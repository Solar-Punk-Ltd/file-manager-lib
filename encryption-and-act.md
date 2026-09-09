# Client-side encryption + ACT sharing — design

**Branch:** `feat/encryption` · **Status:** §§4–5 implemented, sharing (§2.5 phase 2) not started · **Targets:** v2
(breaking)

Replaces per-node ACT with client-side symmetric encryption over a two-chain key hierarchy, and narrows ACT to what it
is actually good at: gating a small key blob to a named grantee list at share time.

**Current v2 data is not readable under this design.** No migration path is planned or owed.

---

## 1. The model in one paragraph

Content bytes are uploaded with **Swarm native encryption**, so every object gets a random key that Bee embeds in its
64-byte reference — we never choose or store a content key. Those references live in the index (feed payloads and
manifests), and the index is encrypted **client-side** under keys we do control. Each node carries two keys: `K_meta`
unlocks its listing, `K_content` unlocks its content pointer. Each is wrapped under the parent's corresponding key, so
the tree carries two parallel key chains. Sharing hands over keys, not data. ACT is used only to deliver those keys to a
named grantee list — a payload of a few hundred bytes — so its cost scales with the number of shares, not with the size
of the tree.

Design rationale and the discussion that produced it are not repeated here; this document is the specification.

---

## 2. Flowcharts

### 2.1 Identity — login to FileManager key

Three login paths converge on one **FileManager Key (FMK)**. The FMK is the root of all index encryption and is what
makes a user's drives reachable from any origin and any login method.

```mermaid
flowchart TD
    subgraph L["Login methods"]
        A1["Raw private key<br/>injection"]
        A2["Ethereum wallet"]
        A3["Swarm ID / snaha"]
    end

    A1 --> B1["K_unlock = HKDF(privKey, 'fm-unlock-v1')"]
    A2 --> B2["sig = personal_sign('fm-identity-v1')<br/>K_unlock = HKDF(sig, 'fm-unlock-v1')"]
    A3 --> B3["identity-scoped secret<br/>K_unlock = HKDF(secret, 'fm-unlock-v1')"]

    B1 --> C["Envelope feed<br/>topic = HKDF(secret, 'fm-identity-envelope-v1')<br/>owner = swarmClient.owner (the login)"]
    B2 --> C
    B3 --> C

    subgraph INIT["FileManagerBase.initialize() — read-only, needs no stamp"]
        C --> D{"Envelope<br/>exists?"}
        D -->|no| N["identity = undefined<br/>init still succeeds"]
        D -->|yes| F["FMK = AES-GCM-decrypt(K_unlock, envelope)"]

        F --> V{"auth tag +<br/>keyId match?"}
        V -->|no| X["IdentityError -> IDENTITY_INVALID<br/>'this credential derives a different identity'"]
        V -->|yes| G["FMK established"]

        G --> H["stateTopic = HKDF(FMK, 'fm-state-v1')<br/>K_state = HKDF(FMK, 'state')<br/>signer = HKDF(FMK, 'fm-signer-v1')"]
        H --> I["identity.owner = address(signer)<br/>every data feed is owned and signed by it"]
        I --> S["load admin state"]
    end

    N --> P
    subgraph PROV["createAdminDrive() — first write, needs a stamp"]
        P["Generate FMK, 32 random bytes"] --> Q["seal under K_unlock<br/>write envelope at the 0th index"]
        Q --> R["derive stateTopic + signer as above"]
    end
```

Notes:

- **Two addressing layers, and the split is the whole portability mechanism.** The envelope lives under the _login's_
  address — it has to, because it must be findable before the FMK exists, and because only the login can sign a write
  there. Everything else — the state feed and every node feed — is owned and signed by `HKDF(FMK, 'fm-signer-v1')`.
  Without that second layer the FMK would make the state feed _topic_ portable while the owner stayed per-login, and a
  Swarm feed is addressed by the **pair**: two credentials sharing one FMK would derive an identical topic, look under
  two different owners, and find two disjoint feeds. Same identity, no shared data.
- **One owner, one source of truth.** `Credential` carries only `unlockSecret()`; it does not carry an owner, because
  the envelope's location is the client's address and nothing else can be. `IdentityInfo.owner` is the FMK-derived
  address — a property of the identity, not of the session — so it is stable across every credential that unseals the
  same FMK, and is the only owner a consumer ever sees. It is also the _only_ such stable identifier on the public
  surface: `keyId` is deliberately not one (below).
- **The signer is the one secret held as bytes.** secp256k1 is outside WebCrypto, so a client-side feed signer cannot be
  a non-extractable `CryptoKey` the way every FMK-derived AES key is. It sits on `Identity` and is deliberately absent
  from the public `IdentityInfo`. This is inherent to signing in the page, not a property of this particular scheme.
- **It crosses the port.** `writeFeed` takes `options.signer`, verified supported on both backends —
  `bee.feed.makeWriter(topic, signer)` and swarm-id's `SequentialFeedWriterOptions.signer`, which the proxy's Zod
  message schema carries through the iframe boundary. This is the single exception to §6's "no key material crosses the
  port" rule in `CLAUDE.md`; restate that rule as _the backend's_ key material, since this key is fm-lib's own. On
  swarm-id the key reaches the iframe, which already holds the master key it descends from, so no party is added to the
  trust boundary. Behaviour still wants a live check — snaha's option schemas are Zod `$strip`, which is how
  `redundancyLevel` came to be silently discarded.
- **Injection is explicit, not a wrapper.** An earlier draft put a delegating `IdentityClient` in front of the port,
  overriding `owner` and `writeFeed`'s signer so nothing downstream had to change. It was removed: it made
  `swarmClient.owner` mean the login before an identity was set and the identity after, so a single expression had two
  meanings decided by mutable state at a distance, and `implements SwarmClient` claimed backend-hood for something that
  is not a backend. It also bought less than it looked like — the domain layer has exactly **one** `writeFeed` call
  (`writeActFeed`, two callers) and `getFeedData` already took its owner as a parameter. Instead: `getFeedData`'s
  `owner` is **required**, `writeActFeed`/`saveNodeManifest` take the `Identity`, `MantarayStore` holds one via
  `setIdentity`, and `FileManagerBase.requireIdentity()` throws where the wrapper would have silently fallen back.
  Reading a feed at the wrong address is now a compile error or a loud one, never an empty result.

- **Resolve and provision are separate phases.** `initialize()` only reads, so a newcomer with no stamp still
  initializes successfully and lands on `identity === undefined`. The FMK is minted on the first write that needs it —
  `createAdminDrive` — because writing the envelope costs a stamp. This split is what makes the stampless guest flow in
  the widget work.
- **AES-GCM's authentication tag is the verifier.** A wrong unlock key fails decryption outright, so no separate
  verifier value is stored. `keyId` — carried inside the envelope — is the narrower check that the envelope belongs to
  this FMK rather than a foreign one. Together they convert a non-deterministic signer into a loud failure instead of a
  silently empty drive list: the mitigation for wallets that do not implement RFC 6979 and for smart accounts that
  cannot `personal_sign` deterministically at all.
- **`keyId` is salted with the envelope's own salt**: `HKDF(FMK, 'fm-key-id-v1', salt)` rather than an FMK-only
  fingerprint. It is the one FMK-derived value written to the wire in the clear, so an unsalted one would be
  byte-identical in every envelope sealing that FMK. The moment a second credential joins an identity (§8), anyone able
  to read both envelopes could tell they belong to the same person and link that user's login addresses — a correlator
  the two-addressing-layer split above exists precisely to avoid. Salting costs nothing: the salt is already in the
  envelope, so the check still works, and it is scoped to an envelope rather than to an identity by design.
  `IDENTITY_ENVELOPE_VERSION` is 3 for this; a v2 envelope still unseals but its `keyId` will not match, and failing on
  the version reports that honestly.
- The failure surfaces as `IdentityError`, which `initialize()` reports as `IDENTITY_INVALID` before `INITIALIZED false`
  — a distinct event, because "sign in with the right wallet" and "the node is unreachable" need different screens.
- **The envelope's topic is derived, not fixed.** `HKDF(unlockSecret, 'fm-identity-envelope-v1')`, unsalted — the salt
  lives inside the envelope, so it cannot address it, and domain separation from `K_unlock` is by `info` alone. It was a
  fixed public constant while the derived secret could not be trusted to be secret on both backends; that version let
  anyone who knew an address see whether an identity existed there, and would have let someone sweep addresses for
  envelopes to correlate their `keyId`s. Deriving the topic removes the enumeration primitive rather than hardening what
  it finds. Both halves of an operation — locating the envelope and opening it — therefore run off **one**
  `unlockSecret()` call, threaded as bytes (`withUnlockSecret`): a wallet-backed credential signs to produce it, and a
  second call would put a second signature prompt in front of the user on every startup.
- **The envelope is read at feed index 0 explicitly**, never by probing for the latest update. It is single-slot by
  design: every way the envelope can change moves the topic instead of appending — the topic is derived from the unlock
  secret, so a changed secret lands on a fresh feed; a joining credential writes under its own address; re-keying the
  FMK is a new identity. Since nothing appends, addressing slot 0 is the accurate read, and it collapses Bee's
  latest-update lookup (several round trips, each a postMessage hop under swarm-id) into one addressed chunk fetch on
  the path every session start runs through. A miss still reports the port's not-found sentinel, so "no identity yet" is
  unchanged. The rule this creates: **never append to the envelope feed** — Bee no-ops on a taken index, so a slot-1
  envelope would be written successfully and then be invisible to every reader.
- The envelope's **unlock secret** must come from something the backend keeps private. snaha shipped this in
  `@snaha/swarm-id` 0.4.0 as `deriveAppSecret(label)` — `HMAC(appSecret, label)`, computed inside the iframe — replacing
  the adapter's earlier hash of `appKey.publicKey`, which is recoverable from any feed chunk the login has signed and so
  sealed the envelope under a value its own reader could recompute (snaha/swarm-id#520).
- The envelope's **locator** must be origin-independent, and is not yet. `deriveAppSecret` is scoped to
  `(identity, app origin)`, so the same user on two origins provisions two disjoint identities. This is the single
  remaining dependency on snaha, and it is now a portability limit rather than a security one.
- Swarm has no delete. An envelope written once is permanently retrievable; rotation is additive, and the old ciphertext
  survives forever. Use a deliberately expensive KDF.

### 2.2 Key hierarchy in the tree

```mermaid
flowchart TD
    FMK["FMK"] --> KS["K_state"]
    KS --> SF["State feed payload<br/>encrypted"]
    SF --> AD["Admin drive node"]

    AD --> AM["Admin manifest<br/>natively encrypted"]

    AM -->|"fork: drive A"| DA["wrap_meta = AES(K_meta(admin), K_meta(A))<br/>wrap_content = AES(K_content(admin), K_content(A))"]

    DA --> DAF["Drive A feed payload<br/>AES(K_meta(A))<br/>holds manifestRef"]
    DAF --> DAM["Drive A manifest<br/>natively encrypted"]

    DAM -->|"fork: folder F"| FF["wrap_meta under K_meta(A)<br/>wrap_content under K_content(A)"]
    DAM -->|"fork: file X"| FX["wrap_meta under K_meta(A)<br/>wrap_content under K_content(A)"]

    FF --> FFF["Folder F feed payload<br/>AES(K_meta(F))<br/>holds manifestRef"]
    FX --> FXF["File X feed payload<br/>AES(K_content(X))<br/>holds 64-byte content ref"]

    FXF --> XC["Content chunks<br/>Swarm native encryption<br/>key embedded in the 64-byte ref"]
```

The invariant: **folder and drive feed payloads are meta-keyed; file feed payloads are content-keyed.** Walking the tree
needs `K_meta`. Opening a leaf needs `K_content`. That single asymmetry is what makes `ls -la` without `open`
expressible.

### 2.3 Write path — upload a file

```mermaid
flowchart TD
    A["uploadFile(driveId, path, data)"] --> B["resolve parent host<br/>MantarayStore.resolveHostMantaray"]
    B --> C["unwrap K_meta(parent), K_content(parent)<br/>from grandparent chain, or FMK at the root"]
    C --> D["generate K_meta(X), K_content(X)<br/>32 random bytes each"]
    D --> E["swarmClient.uploadData(batchId, bytes, { encrypt: true })<br/>-> 64-byte contentRef"]
    E --> F["record = { topic, name, content: { reference: contentRef }, ... }"]
    F --> G["uploadData(JSON(record), { encrypt: true })<br/>-> 64-byte recordRef"]
    G --> H["writeFeed(AES-GCM(K_content(X), recordRef))<br/>the reference is sealed, not the payload"]
    H --> I["parent.addFork(name, topic, forkMetadata)<br/>forkMetadata carries wrap_meta, wrap_content,<br/>type, version"]
    I --> J["saveNodeManifest(parent)<br/>each node: AES-GCM(K_meta(parent), marshal()) -> uploadData (plain, 32-byte refs)"]
    J --> J2["writeFeed(AES-GCM(K_meta(parent), rootRef))<br/>32-byte root goes straight into the slot"]
    J2 --> K["propagate manifestRef upward to the drive root"]
```

### 2.4 Read paths

```mermaid
flowchart TD
    subgraph LIST["listFolder — needs K_meta only"]
        L1["read folder feed head"] --> L2["AES-GCM-decrypt with K_meta(F)<br/>-> 32-byte mantaray root"]
        L2 --> L4["downloadData per node<br/>AES-GCM-decrypt with K_meta(F) -> unmarshal"]
        L4 --> L5["forks: name, topic, type,<br/>version, wrapped keys"]
        L5 --> L6["render listing — no file content touched"]
    end

    subgraph OPEN["downloadFile — needs K_content"]
        O1["unwrap K_content(X) from parent fork"] --> O2["read file feed head"]
        O2 --> O3["AES-GCM-decrypt with K_content(X)<br/>-> 64-byte recordRef"]
        O3 --> O35["downloadData -> FileRecord JSON<br/>Swarm decrypts natively"]
        O35 --> O4["FileRecord.content.reference, 64-byte"]
        O4 --> O5["downloadData -> plaintext bytes"]
    end

    L5 -.->|"only if K_content chain available"| O1
```

### 2.5 Sharing

Phase 1 is the plain-hash link. Phase 2 adds ACT delivery. Both consume the same key material, so phase 1 does not need
to be undone.

```mermaid
flowchart TD
    S["User picks a node to share"] --> T{"Phase"}

    T -->|"1 — now"| P1["Single file:<br/>publish content.reference, 64 bytes"]
    P1 --> P2["Send over any channel<br/>messenger, email, URL fragment"]
    P2 --> P3["Recipient: downloadData via any gateway<br/>no identity, no stamp, no fm-lib"]

    T -->|"1 — now, folder"| Q1["Resolve every descendant's content ref"]
    Q1 --> Q2["Build a NEW plaintext manifest<br/>forks point at resolved refs"]
    Q2 --> Q3["Upload manifest only — content bytes untouched"]
    Q3 --> Q4["Publish that manifest reference<br/>snapshot, does not track edits"]

    T -->|"2 — later"| R1["Build key blob:<br/>{ owner, topic, K_meta, K_content? }"]
    R1 --> R2["swarmClient.uploadProtected(blob, grantees)"]
    R2 --> R3["write share feed head"]
    R3 --> R4["Recipient: ACT-decrypt blob -> keys"]
    R4 --> R5["Traverse the OWNER'S LIVE TREE<br/>public feed reads + those keys"]
```

Share grades available in phase 2, all from the same mechanism:

| hand over                            | recipient can                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `K_meta(folder)`                     | full recursive `ls -laR` — names, types, sizes, timestamps, versions. No file contents. |
| `K_meta` + `K_content(folder)`       | full read of the subtree, tracking future changes                                       |
| `K_content(file)`                    | open that one file — equivalent to publishing its 64-byte reference                     |
| `K_meta(folder)` + `K_content(file)` | browse everything, open one thing                                                       |

**Not supported, deliberately:** shallow listing (list a folder but not its subfolders). Neither UNIX nor Google Drive
offers it; implementing it means breaking the `K_meta` chain at every subfolder boundary, turning one share into N.

---

## 3. Comparison with the current ACT implementation

| #   | Concern                           | Current (v2, ACT everywhere)                                                                                     | Planned (v1)                                                                                 |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Index confidentiality             | ACT-wrapped **pointer**; manifest bytes ride `/bytes` in **plaintext**, protected only by an unguessable address | AES-256-GCM on feed payloads _and_ on manifest bytes (§7.1: not native, mantaray forbids it) |
| 2   | Content confidentiality           | none requested — `uploadProtected` passes no `encrypt`                                                           | `encrypt: true`, random per-object key inside the 64-byte reference                          |
| 3   | Who encrypts                      | Bee node (bee-js) or snaha iframe                                                                                | fm-lib, client-side, `crypto.subtle`                                                         |
| 4   | Cost per node write               | ACT upload + feed write                                                                                          | AES encrypt (local) + upload + feed write                                                    |
| 5   | Cost per folder share             | O(subtree) ACT grants                                                                                            | 1 ACT write of a few hundred bytes                                                           |
| 6   | Identity coupling                 | `actPublisher` still needed per read, but no longer written into plaintext fork metadata                         | none in the tree; identity only at the share boundary                                        |
| 7   | Cross-origin drive access         | broken — origin-scoped `appKey` changes owner and state topic                                                    | FMK is origin-independent, but snaha's unlock secret is not — still blocked, one seam        |
| 8   | Cross-login drive access          | impossible                                                                                                       | works via the envelope                                                                       |
| 9   | snaha `actUploadData` history gap | blocks grantee amendment on tree nodes                                                                           | irrelevant — share blobs are rewritten wholesale                                             |
| 10  | Listing without read              | not expressible                                                                                                  | native — `K_meta` / `K_content` split                                                        |
| 11  | Share a file without re-upload    | needs `actResolveReference` from snaha                                                                           | native — fm-lib already holds the plain reference                                            |
| 12  | Share a folder, live-tracking     | not expressible                                                                                                  | phase 2, one grant                                                                           |
| 13  | Revocation                        | nominally via `actRevokeGrantees`; unavailable on snaha, and Swarm cannot unsee                                  | explicitly not offered. Key rotation denies _future_ reads at O(subtree) index rewrites      |
| 14  | Content re-upload on rotation     | no                                                                                                               | no — index only                                                                              |
| 15  | Streaming                         | `downloadProtectedStream`; faked on snaha                                                                        | `downloadStream` on plain refs; unchanged semantics                                          |
| 16  | Port surface                      | 5 ACT-specific members                                                                                           | ACT members retained but used **only** by the share layer                                    |

---

## 4. Data type changes

### 4.1 `src/types/utils.ts`

```ts
// REMOVED from the tree's vocabulary. Retained, but only the share layer uses it.
export interface ActReferences {
  reference: string;
  historyRef: string;
}

// NEW — what a node's feed payload resolves to.
export interface ContentRef {
  /** 64-byte hex: 32-byte address + embedded encryption key. */
  reference: Hex;
}

// CHANGED — `encrypt` is additive and supported by both backends
// (bee-js `UploadOptions.encrypt`; snaha `UploadOptions.encrypt`, which survived the 0.3.0 purge
// that removed `redundancyLevel`).
export interface SwarmUploadOptions {
  redundancyLevel?: SwarmRedundancyLevel;
  encrypt?: boolean; // NEW
}

// NEW — the two-chain key pair carried per node.
export interface NodeKeys {
  meta: Uint8Array; // 32 bytes
  content: Uint8Array; // 32 bytes
}

// NEW — what a fork stores so a child's keys can be recovered from its parent.
export interface WrappedKeys {
  meta: Hex; // AES-GCM(K_meta(parent), K_meta(child)), nonce prefixed
  content: Hex; // AES-GCM(K_content(parent), K_content(child)), nonce prefixed
}
```

`ProtectedRefs`, `ClientProtectedUploadResult`, `FEED_INDEX_*` are unchanged.

### 4.2 `src/types/info.ts`

```ts
export interface NodeResource {
  batchId: string;
  topic: string;
  owner: string;
  redundancyLevel: RedundancyLevel;
  actPublisher: string; // REMOVED
  version?: string;
  status?: NodeStatus;
}

export interface FileRecord extends NodeResource {
  type: NodeType.File;
  driveId?: string;
  name: string;
  path: string;
  content: ActReferences; // CHANGED -> ContentRef
  timestamp?: number; // MOVED to fork metadata (listing data)
  customMetadata?: Record<string, string>;
  trashedFrom?: string;
}

export interface ManifestHost extends NodeResource {
  manifestRef?: ActReferences; // CHANGED -> ContentRef
}
```

Rationale for moving `timestamp` (and adding `size`) into the fork: they are **listing** data. A `K_meta`-only grantee
must see them, and the record is content-keyed. Anything a listing must show belongs in the fork; anything only a reader
may see stays in the record.

### 4.3 `src/utils/constants.ts` (lines 30–42)

```ts
// REMOVED — done, ahead of the rest of this section
MANIFEST_METADATA_NODE_ACT_PUBLISHER = 'swarm-node-act-publisher';
MANIFEST_METADATA_DRIVE_ACT_PUBLISHER = 'swarm-drive-act-publisher';

// NEW — done
MANIFEST_METADATA_WRAPPED_META_KEY = 'swarm-wrapped-meta-key';
MANIFEST_METADATA_WRAPPED_CONTENT_KEY = 'swarm-wrapped-content-key';
ROOT_META_KEY_LABEL = 'fm-root-meta-v1';
ROOT_CONTENT_KEY_LABEL = 'fm-root-content-v1';

// DEFERRED — listing data, see below
MANIFEST_METADATA_NODE_SIZE = 'swarm-node-size';
MANIFEST_METADATA_NODE_TIMESTAMP = 'swarm-node-timestamp';

// NEW — identity (all present)
STATE_TOPIC_LABEL = 'fm-state-v1';
IDENTITY_ENVELOPE_TOPIC_LABEL = 'fm-identity-envelope-v1';
UNLOCK_KDF_LABEL = 'fm-unlock-v1';
KEY_ID_LABEL = 'fm-key-id-v1';
SIGNER_LABEL = 'fm-signer-v1';
```

**`size` and `timestamp` in fork metadata are deliberately deferred.** They are listing data, and their only reader is
the `K_meta`-only grantee of §2.5 phase 2, who does not exist yet. Adding them now would put `timestamp` in two places —
the fork and the content-keyed record — with no consumer to justify the second copy, and `size` is not even available:
nothing on the upload path measures it today, so plumbing it means touching `File.size` on the browser side and a `stat`
on the node side. Both land with the share layer, together with the reader that needs them.

**The two publisher keys are already gone** — they did not need the keyring to justify removing them. Fork metadata is
plaintext (only the root pointer is ACT-wrapped), and under swarm-id `actPublisher` is the login's own public key, so
writing it beside `MANIFEST_METADATA_NODE_OWNER` published the link between a user's login and their identity address to
anyone holding a manifest chunk. It also bought nothing: the publisher describes whoever is _reading_, not the node, and
every read path already fell back to the live `SwarmClient.actPublisher`. `assertDriveInfoFromMetadata` now takes it as
a parameter, and `NodeHeader` no longer carries it.

---

## 5. Function-level changes, by file

### 5.1 `src/utils/crypto/index.ts`

On `globalThis.crypto.subtle` (browser and Node 22, which `engines.node: ">=22.0.0"` already requires — **no new
dependency**). The HKDF and `CryptoKey`-level AES halves landed with the identity work; this adds the raw-key layer the
node keys need:

```ts
importAesKey(raw: Uint8Array): Promise<CryptoKey>                     // non-extractable
sealWithKey(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>   // AES-256-GCM, iv prefixed
openWithKey(key: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>
wrapKey(kek: Uint8Array, key: Uint8Array): Promise<Hex>
unwrapKey(kek: Uint8Array, wrapped: Hex): Promise<Uint8Array>
generateNodeKeys(): NodeKeys                                          // 2 x 32 random bytes
```

The raw-key helpers import on every call rather than caching a `CryptoKey` per node. An import is local work next to a
network round trip, and a second cache keyed by topic would have to stay coherent with the keyring for no measurable
gain.

### 5.2 NEW — `src/identity.ts` and `src/keyring.ts`

`identity.ts` implements §2.1: resolve `K_unlock` from the login method, read or create the envelope feed, verify,
produce the FMK.

`keyring.ts` is the in-memory key cache and the unwrap path, as built:

```ts
class Keyring {
  constructor(identity: Identity);
  requireKeys(topic: string): Promise<NodeKeys>; // throws KeyringError if the node was never reached
  mint(topic: string): NodeKeys;
  register(topic: string, keys: NodeKeys): void;
  wrapFor(parentTopic: string, childTopic: string): Promise<WrappedKeys>;
  unwrapChild(parentTopic: string, childTopic: string, wrapped: WrappedKeys): Promise<NodeKeys>;
  clear(): void;
}
```

`requireKeys` is async and special-cases the state topic, deriving `HKDF(FMK, 'fm-root-meta-v1')` /
`'fm-root-content-v1'` on first use. That removes an initialization-order hazard: nothing has to remember to seed the
root before the first save, and there is no window in which the store holds an identity but not its root keys.

**Root keys are raw bytes, not a non-extractable `CryptoKey`.** Every node key below the root is wrapped into a manifest
and, once sharing lands, handed to a grantee, so none of them can be non-extractable; making the root the one exception
would have split `NodeKeys` into two shapes and infected every signature that touches one. `Identity` gained
`deriveKeyBytes(info)` for this and lost the unused `deriveKey(info): Promise<CryptoKey>`. The FMK itself stays
non-extractable — what is in the heap is one generation below it.

The keyring is populated as the tree is walked — the same lazy-hydration shape `MantarayStore` already uses for
manifests and feed indexes, and it lives alongside those caches, rebuilt by `setIdentity`.

**Consequence worth knowing: reaching a node means having walked to it.** `getFileVersion` and `updateFile` accept a
caller-held `FileRecord`, and under ACT that was enough — the publisher was all a read needed. Under the key chain a
record carries no key, so a record reconstructed outside a session that listed its folder throws `KeyringError`. In
practice the app lists before it opens, so the keyring is warm; the failure is loud and names the node rather than
returning an empty result.

**Unwrapping is per entry, at the point of use** — `store.unwrapFork(parentTopic, childTopic, forkMetadata)`, called
where the child is about to be read: each segment of `resolveFolder`'s descent, each header in `walkFolder`'s file and
folder phases, each drive in `initDriveList`.

An earlier version hydrated a whole manifest's keys in one eager pass. That was wrong, and the existing tests said so
twice. `walkFolder` and `initDriveList` both have a deliberate per-entry failure model — `FailureScope.Entry` for a
file, `FailureScope.Subtree` for a folder, `DRIVE_UNRESOLVED` for a drive — and a batched unwrap turns any single bad
fork into a failure of the whole listing. One fork whose keys do not unwrap must cost the user that fork, not every
sibling it happens to share a manifest with. `initDriveList` additionally unwraps _after_ `assertDriveInfoFromMetadata`,
so a malformed fork is still reported as malformed rather than as a key error.

**Retention rule:** the keyring never discards a key on rotation, and `MantarayStore.evict(topic)` deliberately leaves
keys in place while dropping every other cache for that node. A partial or failed rotation must never be data loss for
the owner; only the recipient's view is meant to change. Keys are dropped only by `clear()`, which is a full reset.

### 5.3 `src/utils/bee.ts`

**A feed payload is one Swarm reference, sealed — and nothing else.** `AES-GCM(key, reference)`, written raw into the
slot: 60 bytes for a 32-byte reference, 92 for a 64-byte one. Not JSON, and not a sealed _payload_ whose reference is
then published.

That distinction is the whole point and it is easy to get backwards. A 64-byte Swarm reference is `address ‖ key` — the
reference **is** the capability. So sealing the payload and publishing the reference protects nothing that sealing the
reference doesn't, costs AES over the whole payload instead of over 64 bytes, and makes native encryption dead weight,
since the key it generated is published in the clear beside the address. Seal the reference; let Swarm encrypt the
bytes.

(Sealing only the key half of a 64-byte reference would be equally secure — the address alone yields ciphertext — but
sealing all 64 costs 32 bytes and additionally hides _which chunk_ a feed points at, so an observer cannot correlate
feed to chunk.)

Two writers, because payload size decides whether a blob is needed at all:

```ts
// The reference already exists — every manifest root. No blob, no extra round trip.
writeSealedRefFeed(swarmClient, identity, reference: Reference, key, target, requestOptions): Promise<FeedWriteResult>

// The payload is unbounded — a file record. Upload it natively encrypted, then seal what comes back.
writeEncryptedFeed(swarmClient, identity, payload, key, target, requestOptions): Promise<FeedWriteResult>
```

`writeEncryptedFeed` is `uploadData(payload, { encrypt: true })` followed by `writeSealedRefFeed`, so both end at the
same place. `openFeedRef(payload, key)` is the read side for both — it unseals and validates the result as a 32/64-byte
reference, so a mis-keyed read fails there rather than as a puzzling 404 further down.

- **`FeedTarget`** — remove `actHistoryAddress`.
- **`FeedWriteResult.contentRef: ActReferences`** → `reference: ContentRef`.
- `getFeedData`, `getTopicAndVersion`, `fetchStamp`, `verifyStampUsability` — unchanged.

### 5.4 `src/utils/mantaray.ts`

- **`saveMantarayRecursively`** — seal each node's marshaled bytes under `K_meta(host)` and upload them **plain**. Not
  `{ encrypt: true }`, as originally specified: §7 item 1 verified that native manifest encryption breaks
  prefix-overlapping entry names. The key threads down from `saveNodeManifest`.
- **`saveNodeManifest`** — call `writeSealedRefFeed` with the root reference and `K_meta(host)`; drop
  `actHistoryAddress: host.manifestRef?.historyRef`. The root is 32 bytes, so it goes into the feed slot directly —
  uploading it as its own blob would add a round trip to every node a listing walks.
- **`unmarshalNode` / `loadMantaray` / `loadForks`** — take the same `K_meta` and open each node after download.
  References stay 32 bytes, so nothing about the format changes.
- **`fileForkMetadata`** — `MANIFEST_METADATA_NODE_ACT_PUBLISHER` is already dropped (§4.3); add wrapped keys:

  ```ts
  export function fileForkMetadata(record: FileRecord, wrapped: WrappedKeys): Record<string, string> {
    return {
      [MANIFEST_METADATA_NODE_TOPIC]: record.topic,
      [MANIFEST_METADATA_NODE_TYPE]: NodeType.File,
      [MANIFEST_METADATA_NODE_OWNER]: record.owner,
      ...wrappedKeysMetadata(wrapped),
      ...(record.version !== undefined ? { [MANIFEST_METADATA_NODE_VERSION]: record.version } : {}),
    };
  }
  ```

- **`folderForkMetadata` and `driveForkMetadata`** — same treatment; both already lost their publisher key.
- **`wrappedKeysMetadata` / `wrappedKeysFromMetadata`** — the one place the two metadata keys are written and read, so a
  fork missing them fails as a `KeyringError` naming the fork rather than as an unwrap of `undefined`.
  `driveForkMetadata` is the reason this matters: `renameDrive` rebuilds drive fork metadata from scratch, so the
  wrapped keys have to be re-sealed alongside the new name or the drive lists and never opens.

### 5.5 `src/mantarayStore.ts`

- **The store owns the `Keyring`**, built in `setIdentity` and exposed as `store.keyring`, rather than a bare
  `Map<string, NodeKeys>` beside the other caches. One source of truth: the key chain's lifetime is exactly the
  identity's, and `FileManagerBase` reaches it through the store the same way it reaches the index caches.
- **`getMantarayNode`** — `manifestRef` _is_ the mantaray root, so `downloadProtected` is replaced by nothing at all: it
  goes straight to `loadMantaray(manifestRef.reference, K_meta(topic))`. The `publisher` parameter is removed.
- **`openManifestRef(topic, payload)`** — the one place a folder, drive or state feed payload is unsealed back into a
  root reference. Callers hold the payload, the store holds the key.
- **`saveMantarayNode`** — resolves `K_meta(host.topic)` and passes it to `saveNodeManifest`. It no longer has to carry
  the previous ref forward, since that existed only to continue an ACT history.
- **`saveRecord`** — `writeEncryptedFeed` uploads `JSON.stringify(persistable)` natively encrypted and seals the
  returned reference under `K_content(record.topic)`. The `actHistoryAddress: prevRef?.historyRef` argument disappears.
- **`getRecord`** — `openFeedRef` under `K_content(topic)`, then a plain `downloadData`: Swarm decrypts the bytes itself
  from the key inside the reference. The `actPublisher` parameter is removed.
- **`resolveHost` / `resolveHostMantaray` / `resolveFolder`** — the `publisher: string` parameter is gone;
  `resolveFolder` unwraps each segment's keys as it descends, so reaching a folder hydrates the chain down to it.
- **New: `unwrapFork` / `rewrapFork`** — the three key-chain operations the domain layer needs, kept here rather than on
  `FileManagerBase` because they pair with the caches they feed.

### 5.6 `src/fileManager.ts`

- **`assertReady`** dropped `publisher` from both its parameters and its result — with ACT gone it had nothing left to
  check, and the `SignerError` it raised is no longer reachable from any of the 19 methods that documented it.
- **`initialize`** — unchanged by this step; the FMK and `stateFeedTopic` already came from §2.1's identity work.
- **`createAdminDrive` / `createDrive` / `createFolder`** — mint `NodeKeys` for the new node, register in the keyring,
  wrap under the parent before `addFork`.
- **`uploadFile` / `uploadFiles`** — mint the file's keys straight after `getTopicAndVersion`, so the record write can
  seal under `K_content` and the `addFork` can wrap under the parent.
- **`move` — REQUIRED, non-obvious.** A cross-parent move relocates a fork verbatim via `sourceFork.targetAddress`.
  Under wrapped keys the child's keys are sealed under the **old** parent's, so moving without unwrap-then-rewrap leaves
  an entry that appears in the listing and cannot be opened by anyone. Still O(1) — one unwrap, one wrap — but the
  failure is silent. A same-parent move (a rename) shares the KEK and needs nothing.
- **`trash` / `recover`** — same re-wrap requirement; the trash host is a different parent with different keys.
- **`renameDrive`** — the subtle one, because it is not a relocation. It rebuilds the drive's fork metadata from scratch
  to change the name, which drops the wrapped keys unless they are re-sealed with it.
- **`downloadFiles`** — the `DownloadResource` mapping drops `actHistoryAddress` and `actPublisher`, keeping only
  `reference`. Content needs no keyring entry at all: the 64-byte reference carries its own key, which is what makes
  §2.5 phase 1 a matter of publishing that reference.

### 5.7 `src/upload/*` and `src/download/*`

- `upload-node.ts` / `upload-browser.ts` — `swarmClient.uploadProtected(...)` becomes
  `uploadData(batchId, data, { encrypt: true, redundancyLevel })`. The `historyRef` positional argument and the
  `Optional.of(historyAddress)` return disappear, and with them the bee-js `UploadResult` round-trip both files did only
  to unwrap it again.
- `encrypt` is **forced**, not read from the caller's `uploadOptions`. The 64-byte reference is the only content
  capability a record holds, so an unencrypted upload would leave the bytes readable to anyone who learns it — a
  caller-flippable flag there is a footgun with no use case.
- `processDownload` — `downloadProtected` / `downloadProtectedStream` become `downloadData` / `downloadStream`.
- The port's `uploadData` widens to `Uint8Array | string | Blob | Readable`, matching `uploadProtected`, so the browser
  path can still hand a `File` straight through. `BeeClient` passes it to `bee.data.upload`, which already accepts all
  four; `SnahaClient` buffers via its existing `toBytesAsync`. `uploadData` also returns `tagUid` now, which is what
  `onUploadProgress` was getting from `uploadProtected`.

### 5.8 `src/types/swarmClient.ts` and the two clients

The port keeps `uploadProtected` / `downloadProtected` / `downloadProtectedStream` / `actPublisher` — they become the
**share layer's** API rather than the tree's. Nothing else changes.

`BeeClient` and `SnahaClient` need only the additive `encrypt` in `SwarmUploadOptions`, forwarded to each SDK's own
`UploadOptions.encrypt`. Verified present on both at the versions in the tree: bee-js v13's `UploadOptions.encrypt` and
`@snaha/swarm-id@0.4.0`'s. Note the asymmetry that follows for swarm-id — `encrypt` survives its Zod `$strip` while
`redundancyLevel` does not, so that backend now writes encrypted-but-unreplicated data.

**Done:** `writeFeed`'s options widen to `SwarmFeedWriteOptions`, adding `signer?: Hex` — the FMK-derived feed key from
§2.1. `BeeClient` builds a `PrivateKey` from it in place of its constructor signer; `SnahaClient` passes it as
`SequentialFeedWriterOptions.signer`. Both fall back to the backend key when it is absent, which is how the identity
envelope stays under the login's address. The domain layer supplies it from one place — `writeActFeed`, which takes the
`Identity` and is the only feed write outside `src/identity.ts`.

**Backend note:** snaha's `ActUploadOptions` are Zod `$strip`, so an unsupported option is discarded silently at the
postMessage boundary rather than erroring — the same trap that removed `redundancyLevel` in 0.3.0. `encrypt` is present
on both SDKs today; re-verify on every snaha bump.

---

## 6. Rotation — "stop sharing"

Rotating `K_meta`/`K_content` for a subtree denies **future** reads only. Anything a recipient has already dereferenced
is theirs permanently; this is inherent to Swarm and is accepted.

Cost: **no content re-upload.** Per node in the subtree — re-encrypt a small feed payload, re-marshal the parent
manifest with re-wrapped child keys, one feed write. The 64-byte content references are unchanged, so content chunks are
never touched. This is the same order and the same nature as `actRevokeGrantees` today, which also rewrites pointers
rather than content.

The real risk is **partial failure**, not cost. A half-rotated subtree has parents holding wrapped keys that no longer
match their children, and this is precisely the operation that meets the feed-index landmine — Bee silently no-ops on a
taken index, so a naive retry loses writes without erroring. Requirements:

1. The keyring retains old keys indefinitely (§5.2), so the owner can always read either generation.
2. Rotation is a resumable job with a persisted progress marker, not a single pass.
3. Never guess a feed index; always use the probed `feedIndexNext`.

---

## 7. Open items and verification

1. **64-byte references through mantaray — verified, and it fails. §5.4 changed as a result.**

   A marshaled node stores **one** `refBytesSize` byte and applies it to its entry _and_ every fork: `marshal()` takes
   it from `targetAddress.length` when the node has an entry, otherwise from the first fork's `selfAddress.length`, and
   `unmarshalFromData` reads every fork at that one width. fm-lib's fork targets are 32-byte **topics**, so a natively
   encrypted manifest mixes a 32-byte entry with 64-byte fork addresses, and any node carrying both parses back wrong.
   That node is not exotic: it is what `addFork` builds whenever one entry name is a prefix of another — `report` beside
   `report.pdf`, `a` beside `ab`.

   Measured against `@ethersphere/core-sdk@0.1.1` with an in-memory chunk store, mirroring `saveMantarayRecursively` +
   `loadMantaray`:

   | entry names                         | 32-byte refs | 64-byte refs                                   |
   | ----------------------------------- | ------------ | ---------------------------------------------- |
   | `a.txt`, `b.txt`, `notes.md`        | round-trips  | round-trips                                    |
   | `a`, `ab`, `abc`                    | round-trips  | `Fork#unmarshal not enough bytes for metadata` |
   | `report`, `report.pdf`, `other.txt` | round-trips  | `Fork#unmarshal not enough bytes for metadata` |

   It throws rather than corrupting silently, which is the one mercy — but it throws at **read** time, on a manifest
   that was written successfully, so the damage is already durable when it surfaces.

   **Resolution: manifest chunks are sealed client-side under `K_meta(host)` and uploaded plain.** Every reference stays
   32 bytes, the format risk disappears, and the manifest key becomes ours to rotate instead of being embedded in the
   reference. Native encryption is still used everywhere it is unconstrained — file content, and the sealed blobs behind
   feed payloads — because those references are never mantaray entries.

2. **Fork target vs. content reference.** Forks target the child **topic** (32 bytes) and are unaffected by (1).
   Confirmed in the current tree; keep it that way.
3. **Feed payload size.** Payloads stay small — a JSON object with one reference plus a 12-byte nonce and 16-byte tag.
   Confirm against the SOC payload limit for the largest realistic record (`customMetadata` is the only unbounded
   field).
4. **snaha identity-scoped secret.** The only external dependency. Without it the Swarm ID login path cannot join the
   unified identity, and grantee lists in phase 2 remain origin-scoped.
5. **Linking a second credential is unbuilt, and is now the only thing between us and §2.1's promise.** A stable
   FMK-derived owner makes multi-login portability _possible_; it does not make it _reachable_. A second login finds no
   envelope under its own address and mints a fresh FMK — a second, disjoint identity — rather than joining the first.
   Joining means writing an envelope sealing the _same_ FMK under credential B's unlock key, at B's address, which
   requires being signed in as B while holding the FMK. Since the FMK is imported non-extractable and its source bytes
   are zeroed immediately, there is currently no export path to hand it over. Options, none chosen: keep the raw FMK
   available for the length of an explicit link operation; transfer the _unlock secret_ instead; or have the envelope
   itself be the transfer unit and require both credentials live in one session. Decide the UX before the mechanism —
   this is a device-pairing flow, and the precedents (Signal's safety numbers, WhatsApp's linked devices, passkey sync)
   all put an explicit user ceremony at the centre.

   **Whatever the mechanism, credential B's envelope must get a fresh salt.** It is tempting to reuse A's — the FMK is
   the same, and copying the whole envelope shape looks like the conservative move. It is the opposite: `keyId` is
   `HKDF(FMK, 'fm-key-id-v1', salt)`, so a shared salt makes both envelopes carry a byte-identical `keyId` in the clear,
   publicly linking A's and B's login addresses as one person. That is the exact correlation salting `keyId` exists to
   prevent, and this is the first code with any reason to get it wrong. A fresh salt also re-randomises `K_unlock`,
   which is correct on its own terms.

6. **Feed signer validity.** `HKDF(FMK, 'fm-signer-v1')` is 32 uniform bytes, which is not guaranteed to be a valid
   secp256k1 scalar. The failure probability is ~2⁻¹²⁸, so no retry loop is warranted, but note that neither core-sdk's
   `PrivateKey` nor the derivation checks the range.
7. **Cross-backend shares do not work.** ACT decryption is node-side on bee-js and iframe-side on snaha, so a phase-2
   share created for a snaha identity is unreadable by a `BeeClient` user, and vice versa. Document rather than solve.
8. **Discovery is out of scope.** ACT gates who _can_ read a share; nothing announces that one exists. Phase 1 relies on
   the user sending a link. A deterministic share-feed topic (`keccak(sharerPubKey || recipientPubKey || label)`) would
   allow polling per contact without an inbox, if that is wanted later.
9. **Tests.** The unit suite module-mocks `getFeedData`, `fetchStamp`, `loadMantaray` and `getAllNodeEntries`. Renaming
   `writeActFeed` and changing `getMantarayNode` / `getRecord` signatures will break those mocks, and integration is the
   first place the new crypto path actually executes. No test changes are proposed here — the shape of the fixtures is a
   decision for the owner.
