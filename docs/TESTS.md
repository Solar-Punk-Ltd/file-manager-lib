# TESTS — @solarpunkltd/file-manager-lib

This document explains how the test-suite for **@solarpunkltd/file-manager-lib** is organized and how to run, extend,
and troubleshoot it. It covers both **unit** and **integration** tests (including an end‑to‑end workflow suite).

> For usage and API details, see: • **README.md** — install, mainnet setup

---

## At a glance

- **Jest** with three **projects** (`unit-node`, `unit-browser`, `integration`), all under **ts-jest** in a Node
  environment.
- **Unit tests** mock all Swarm/Bee internals and focus on `FileManagerBase` behavior — no network. The exception is
  `identity.spec.ts`, which drives the identity and `Keyring` modules directly, with real crypto. They run **twice**:
  `unit-node` and `unit-browser` execute the same specs, the latter adding `tests/platform-browser.ts` to shim browser
  globals so the platform-split code is exercised both ways.
- **Integration tests** run against real Bee nodes provisioned by **`@ethersphere/bee-factory`** and exercise ACT
  encryption, per‑file feeds, mantaray drive manifests, versioning and the reserved `.trash` folder end‑to‑end.
- The runner uses **`--maxWorkers=4`**; integration steps lean on the 5-minute `testTimeout` + propagation retries
  rather than serial execution.
- `testTimeout` is **5 minutes** per test (integration steps wait on chunk propagation).
- Coverage is **opt-in** via `pnpm run test:coverage` (`v8` provider) into `tests/coverage`.

---

## Prerequisites

- **Node.js** — **≥ 22** (matches `engines.node`).
- **Docker** — required for integration tests. `bee-factory` spins up a local Bee cluster in containers.
- **`@ethersphere/bee-factory`** — a dev/test dependency. The integration project's `globalSetup` starts it and
  `globalTeardown` stops it automatically; you don't start Bee manually.
  - Queen node (used by tests): `http://127.0.0.1:1633` (`BEE_URL`)
  - Worker node (a non-admin peer): `http://127.0.0.1:1635` (`OTHER_BEE_URL`)
  - The image tag defaults to `v2.8.0` and can be overridden with the `BEE_FACTORY_TAG` env var.

Unit tests need none of the above — they never touch the network.

---

## Running tests

```bash
# Everything (unit-node + unit-browser + integration), verbose
pnpm test

# Only unit (both envs) / only integration
pnpm run test:ut
pnpm run test:it

# A single unit env
pnpm run test:ut:node
pnpm run test:ut:browser

# Coverage
pnpm run test:coverage
```

Scripts exposed by `package.json`:

- **`pnpm test`** → `jest --config=jest.config.ts --maxWorkers=4 --verbose --silent`
- **`pnpm run test:ut`** → `test --selectProjects=unit-node` then `test --selectProjects=unit-browser`
- **`pnpm run test:ut:node`** / **`pnpm run test:ut:browser`** → a single unit env
- **`pnpm run test:it`** → `test --selectProjects=integration`
- **`pnpm run test:coverage`** → `test --coverage`

Everything is configured in `jest.config.ts`, including the `@/*` → `src/*` path mapping used throughout the specs.

---

## Directory layout

```
tests/
├─ utils.ts                     # shared: URLs, signers, batch params, createInitializedFileManager, retry/stream helpers
├─ platform-browser.ts          # unit-browser setupFilesAfterEnv — shims browser globals (File/Blob/…)
├─ unit/
│   ├─ setup.ts                 # setupFilesAfterEnv — centralizes jest.mock() for @/utils/bee & @/utils/mantaray
│   ├─ mock.ts                  # applyDefaultMocks, mock factories, seedRecords, unit createInitializedFileManager
│   ├─ identity.spec.ts         # identity envelope, key derivation, Keyring — the only spec using the real Keyring
│   ├─ init.spec.ts
│   ├─ drive.spec.ts
│   ├─ file.spec.ts
│   ├─ folder.spec.ts
│   ├─ version.spec.ts
│   ├─ trash.spec.ts
│   ├─ share.spec.ts
│   ├─ events.spec.ts
│   └─ abort.spec.ts
└─ integration/
    ├─ setup/
    │   ├─ jestSetup.ts         # globalSetup → `npx bee-factory start --tag <tag>`
    │   ├─ jestTeardown.ts      # globalTeardown → `npx bee-factory stop`
    │   └─ utils.ts             # temporary file and stamp management
    ├─ init.spec.ts
    ├─ drive.spec.ts
    ├─ file.spec.ts
    ├─ folder.spec.ts
    ├─ version.spec.ts
    ├─ trash.spec.ts
    ├─ share.spec.ts
    ├─ e2e.spec.ts
    └─ abort.spec.ts
```

Each domain area lives in its own spec file, mirrored across `unit/` and `integration/`, except for `identity.spec.ts`,
which is unit-only. The key chain needs no integration suite of its own — integration mocks nothing, so every upload and
download there already exercises the real AES wrapping end-to-end.

### Shared helpers

**`tests/utils.ts`** (used by both projects)

- Constants: `BEE_URL`, `OTHER_BEE_URL`, `DEFAULT_MOCK_SIGNER`, `OTHER_MOCK_SIGNER`, `DUMMY_BATCH_ID`,
  `DEFAULT_BATCH_DEPTH`, `DEFAULT_BATCH_AMOUNT`.
- `createInitializedFileManager(bee?, batchId?, emitter?)` — constructs a `FileManagerBase`, initializes it, and
  bootstraps an admin drive if one isn't present.
- `retryOnPropagationDelay(fn, attempts?, delayMs?)` — retries a read until chunks propagate on the devnet.
- `streamToUint8Array`, `readFilesOrDirectory`, `getTestFile` — content/dir helpers.

**Unit — `tests/unit/setup.ts` + `tests/unit/mock.ts`**

- `setup.ts` is wired via `setupFilesAfterEnv` and holds the module-level `jest.mock()` calls for `@/utils/bee`
  (`getFeedData`, `fetchStamp`, `writeSealedRefFeed`, `writeEncryptedFeed`, `openFeedRef`) and `@/utils/mantaray`
  (`loadMantaray`, `getAllNodeEntries`). Centralizing them here keeps every spec free of duplicated mock boilerplate.
- `setup.ts` also replaces `@/keyring` with a **fake cipher, not a fake key chain**. Fork metadata in the unit specs is
  written by hand, and a real `wrapFor` seals a child's keys under a parent key minted at runtime, which no static
  fixture can reproduce. So wrapping is plain hex here while every other property holds: keys stay per-node, are
  registered only by minting or unwrapping, and `requireKeys` still throws for a node nothing walked to. The real AES
  path runs unmocked in the integration suite, and against the real `Keyring` in `identity.spec.ts`.
- `mock.ts` provides `applyDefaultMocks()` (call it first in each `beforeEach` — resets mocks, installs
  `createInitMocks` and sensible default return values), mock factories (`createMockDriveInfo`, `createMockFileInfo`,
  `createMockFeedReader`, `createMockFeedWriter`, `createMockMantarayNode`, …), `seedRecords(fm, ...records)` to
  pre-populate the record cache, `seedKeys(fm, ...topics)` to mint keys for hand-written forks, `mockWrappedKeys()` for
  the two wrapped-key metadata entries a fork needs, `mockIdentityFeed(client, rest)` to seal a test identity into the
  envelope slot and answer every other feed through one callback, and a unit-local `createInitializedFileManager`.
- The mock feed writer parks any **string** feed payload in an internal slot map that the default `getFeedData` reads
  back, so a JSON feed head written by the code under test is readable afterwards without extra wiring. Sealed reference
  feeds are bytes and are not captured.

**Integration — `tests/integration/setup/utils.ts`**

- `ensureUniqueSignerWithStamp(isNewSigner?)` — returns `{ bee, ownerStamp, signer }`, buying the admin/owner stamp once
  and caching it for the run.
- `setupUserDrive(driveName, { stampLabel?, reuseOwnerStamp? })` — the standard `beforeAll` fixture: ensures a signer,
  initializes a `FileManagerBase` (with admin drive), buys a stamp, creates the named user drive, and returns
  `{ bee, fileManager, drive, ownerStamp, batchId, signer }`.
- `tempFileRegistry()` — returns `{ writeTempFile, writeTempDir, cleanup }`. All on-disk fixtures are written under
  **`tests/integration/tmp/`** (gitignored + npmignored, never the repo root), and removed in a single
  `afterAll(cleanup)`, so **no temporary file survives the run** even if a test throws. `writeTempFile` / `writeTempDir`
  return the **absolute** on-disk path — feed that to `sourcePath`, and keep the logical drive `path` separate (they are
  decoupled: the disk fixture lives in `tmp/`, the drive path is whatever you upload it as).

---

## Domain model under test (v2)

- `FileManagerBase` exposes `recordList` (`FileRecord[]`) and `driveList` (`DriveInfo[]`); records and drives carry a
  `NodeType`.
- **Drives are mantaray manifests.** A drive's file tree is a mantaray whose forks carry per-file metadata; per-file
  version history lives in each file's own Swarm feed.
- **ACT** wraps content per file (`content.historyRef`, `actPublisher`).
- **Every node carries its own key pair** — `K_meta` unlocks its listing, `K_content` its content pointer — each wrapped
  under its parent's matching key and rooted in the FileManager Key, which is itself sealed in a feed envelope the
  backend's `deriveSecret` unlocks. A node's keys are reachable only by walking to it from the root.
- **Trash is a reserved `.trash` folder** at the drive root: trashing relocates the node's fork into it keyed by topic,
  so status is _derived_ from a node's location and a fresh instance sees it by walking the tree.
- **A node's name is its fork label**, not part of the record payload, so `move` (rename or relocate) rewrites no record
  and bumps no version. Tests assert the version is _unchanged_ across a move.
- **Listings report what they cannot resolve.** `listFolder` / `listTrash` return `{ entries, failed }`; a node present
  in a manifest but unresolvable lands in `failed` with a `FailureScope` rather than being dropped. `downloadFolder`
  folds those listing failures into its own `failed`.
- **A drive that cannot be loaded emits `DRIVE_UNRESOLVED`** during `initialize` instead of vanishing silently.
- `FileManagerConfig` lets clients cap `uploadConcurrency` and `feedFetchConcurrency`.
- **Sharing gates one grant blob, not the tree.** A grant is an ACT-protected blob carrying the shared node's keys; the
  stable handle is `{ shareTopic, owner }`, and the churning ACT references live in that feed's head. At most one live
  grant exists per `(node, grade)`: `share` is additive, `revokeShare` is the only removal, and a grade never changes.
  Inbound grants mount as forks of the single `SharedWithMe` drive, which is kept out of `driveList`.

---

## Integration tests — what each suite verifies

Executed against live bee-factory nodes.

- **`init.spec.ts`** — _Initialization and construction_ + _reinitialization_: default state, admin feed/topic
  stability, a non-owner failing to read the admin feed, and `INITIALIZED` / `STATE_INVALID` behavior across
  re-initialization with a valid vs. expired admin stamp (user drives and admin stamp survive re-init).
- **`drive.spec.ts`** — _Drive operations_: `createDrive` persists id/owner/batch/redundancy; forgetting a user drive
  removes it, prunes its records, emits `DRIVE_FORGOTTEN`, and persists; destroying/forgetting the **admin** drive and
  forgetting a non-existent drive throw `DriveError`. Drive **rename** via `move('/', newName, driveId)`: emits
  `DRIVE_RENAMED`, leaves topic/`manifestRef`/files untouched, survives a cold instance, and refuses the admin drive or
  a name another drive holds.
- **`file.spec.ts`** — split into `uploadFile`, `uploadFiles`, `updateFile`, `downloadFile and downloadFiles`, `move`:
  single- and multi-file uploads (each with its own topic), implicit folder creation with batched manifest saves, the
  two-hop ACT-unwrap download round-trip, `updateFile` re-versioning (content vs. metadata-only), directory-source
  guards, rename/move within a drive **at an unchanged version**, a renamed file reading back under its new name on a
  cold instance, and a foreign-drive path failing to resolve (there is no cross-drive move).
- **`folder.spec.ts`** — _Folder operations_: `listFolder` (relative paths, empty folders, deep nesting, empty-path
  rejection), `downloadFolder` destination-path composition, moving a folder as a unit, and `downloadFolder` reporting a
  file it could not list rather than returning a partial download as complete.
- **`version.spec.ts`** — _Version control_: invalid index rejection, sequential slot indices, cold-cache lazy
  hydration, drive-mismatch guard, independently downloadable version bytes, cached-head fast path, restoring a prior
  version as the new head, no-op restore of the head, and restore keeping the current (post-move) location.
- **`trash.spec.ts`** — _Lifecycle management_: trash/recover round-trips through the `.trash` folder (a fresh instance
  stops listing the node and finds it via `listTrash`, **no** version bump), folder trash carrying its subtree,
  same-named nodes kept apart, recover to an explicit destination after the origin was forgotten, the write guards,
  `emptyTrash`, and `forget` (hard de-reference).
- **`share.spec.ts`** — _Sharing_ → `share` (a folder grant with `SHARE_CREATED` and its real grantee list; the head
  published on the share feed matching the entry's ACT refs; a second call joining the standing grant; a second grade
  minting its own; a file as `open`; the validation refusals, including a drive root however the path spells it; a
  fresh instance loading the published index),
  `revokeShare` (full, partial, last-member and non-member cases), and `acceptShare` (a `read` folder grant mounted and
  listed, an `open` file grant downloaded, a `list` grant walking a nested subtree whose file entries carry no `content`
  and whose downloads are reported failed, the same subtree refusing `downloadFile` and `getFileVersion` because the
  record feed is sealed under a key the chain does not carry, a double mount, an unpublished handle). Both identities run on one Bee node,
  so ACT decryption always succeeds for the publisher — what is exercised is the grant blob, the share feed, the keyring
  registration and the mount, not Bee's gating. The grantee-list PATCH settles asynchronously on a fresh list, so the
  calls that issue one retry through `retryWhileGranteeSettles`; `acceptShare` cannot be retried (it mounts before it
  resolves the granted node, so a second attempt hits "already mounted"), and instead every read it depends on is warmed
  first.
- **`abort.spec.ts`** — _Abort signal handling_: `AbortSignal` forwarding for `uploadFile`, `downloadFiles`, and
  `listFolder` — pre-aborted, mid-flight cancel, and clean completion when not aborted; plus a live (never-aborted)
  signal not suppressing failure reporting. An _aborted_ walk rejects via `throwIfAborted`, so it never produces a
  `ListFolderResult` to inspect — only the live-signal half is assertable.
- **`e2e.spec.ts`** — _End-to-End User Workflow_: in-place folder update (one file changes, siblings untouched), adding
  a new folder version without disturbing old files, and multi-branch relative-path listing.

---

## Unit tests — what each suite verifies

Located in `tests/unit/`, all network access mocked (see `setup.ts` / `mock.ts`).

Key strategies:

- `@/utils/bee` (`getFeedData`, `fetchStamp`) and `@/utils/mantaray` (`loadMantaray`, `getAllNodeEntries`) are
  `jest.mock()`-ed in `setup.ts`; `applyDefaultMocks()` gives them default resolved values per test.
- Bee client methods are spied via `createInitMocks` (`downloadData`, `uploadData`, feed reader/writer, stamps, …).
- `seedRecords()` injects `FileRecord`s directly into the cache to test read paths without uploading.
- **A mocked module member is only mocked for its importers.** `jest.mock('@/utils/bee')` does not intercept calls a
  function in that same module makes to its own siblings — `readShareHead` reaches the real `getFeedData`, and so the
  real `SwarmClient`. Anything exercising such a function has to satisfy the Bee client itself (spy `feed.makeReader` /
  `data.download`), not just the helper.

- **`identity.spec.ts`** — _Identity envelope and key chain_, the one suite running the **real** `Keyring` (via
  `jest.requireActual`) and real crypto against an in-memory envelope feed. _provision and resolve_ (a fresh credential
  has no envelope; provisioning seals one and unseals the same identity back; feeds are owned by the identity's own
  address rather than the login address; two credentials get two unrelated identities and cannot see each other's
  envelope), _derivation_ (the same FMK derives the same identity; `keyId` is envelope-scoped while the identity is
  salt-independent; every secret addresses a different envelope; wrong FMK length rejected), _unlock failures_ (a
  different derived secret, a tampered salt, a tampered sealed FMK, a newer KDF epoch, a `keyId` that does not match its
  FMK, a malformed envelope and a non-JSON payload all throw), _provisioning over an existing identity_ (refused twice
  for one credential; a lost write race leaving a foreign envelope in the slot throws; an envelope that is not readable
  back yet keeps the identity and reports `confirmed: false`), _credential contract_ (the handed-over secret is zeroed), and _Keyring_ (root keys derive
  from the FMK, a node whose parent was never resolved is refused, a child key is recovered from its parent, a child
  wrapped under a different parent is refused, child keys are never stored in the clear, a chain entered with `K_meta`
  alone stays meta-only under a fork that does carry a wrapped content key and `requireContentKey` throws there,
  `requireKeys` hands out copies so `clear()` cannot zero a key still in use, and the root re-derives after a clear).
- **`init.spec.ts`** — _constructor_ (missing signer, emitter wiring), _initialize_ (emits `INITIALIZED`; idempotent),
  _reinitialization_, `DRIVE_UNRESOLVED` for a drive whose fork metadata is unparseable (id/name fall back to
  `'unknown'`), and the lazy hand-off: a drive whose manifest feed is empty still loads into `driveList` and surfaces
  the failure on first touch, because `initialize` reads the admin feed only.
- **`drive.spec.ts`** — `creatAdminDrive`, `createDrive` (duplicate name/batchId → `DriveError`), `forgetDrive`, and
  _rename via move_ (admin-fork metadata rewritten in place under its id-keyed path; admin drive, duplicate and no-op
  names refused; every other root move still rejected).
- **`file.spec.ts`** — _File operations_ → `downloadFile`, `downloadFiles`, `uploadFile`, `updateFile`, `move` (correct
  ACT params, no duplicate records on re-version, directory guards; rename and relocate write no record and pin no new
  version, and a cold file is relocated without its feed being read), plus a _record persistence contract_ block: `name`
  is persisted while `path` / `driveId` / `status` are stripped, and `path` falls back to `name` when a record is read
  straight off its feed.
- **`folder.spec.ts`** — `downloadFolder`, `listFolder`, `createFolder`, `move`, plus a _failure reporting_ block:
  entry-scoped file failure (siblings still returned), subtree-scoped unresolvable folder, a folder whose manifest
  cannot be expanded (listed _and_ reported — it exists, only its contents are unknown), and `downloadFolder` folding
  listing failures into its result.
- **`version.spec.ts`** — `getFileVersion` (indexed vs. head, cache reuse, missing-feed error), `restoreFileVersion`
  (head restore is a no-op / emits no event).
- **`trash.spec.ts`** — _Lifecycle management_ → `trash`, `recover`, `listTrash`, `emptyTrash`, `forget` (fork
  relocation, origin stamping and event emission).
- **`share.spec.ts`** — _Sharing_ → `share` (a folder grant and `SHARE_CREATED`; a second call for the same node and
  grade joining the standing grant instead of minting a second, keeping `id` and `shareTopic` so the handle the first
  recipients hold survives; a different grade minting its own; a file shared as `open` and refused at any other grade;
  empty recipients, `open` on a container, an unknown drive and a drive root however the path spells it),
  `getShareGrantees` (members back with duplicates
  collapsed; unknown id throws), `revokeShare` (full revoke stamping `revokedAt` and emptying the list, after which the
  same subject mints a fresh grant because a revoked entry is never re-matched; a partial revoke dropping only the named
  keys; a partial revoke that takes the last member still closing the entry; double revoke and non-member recipients),
  and `acceptShare` (mounting a granted folder into `sharedWithMe` with `SHARE_ACCEPTED`, a `list` grant mounting with
  no content key on the chain, refusing a blob whose claimed type is a drive, refusing a second mount of the same node,
  and an unpublished handle). The suite stands up
  a grantee-list double over `bee.grantee.create` / `patch` /
  `get` — Bee merges lists node-side, so without it membership assertions would be vacuous — and `acceptShare` consumes
  the head `share` actually published, replayed through a `feed.makeReader` spy, plus the grant blob captured off
  `data.upload`.
- **`events.spec.ts`** — _Events and emitter_: deterministic `FILE_UPLOADED` payloads (system time pinned via
  `jest.useFakeTimers()`), `INITIALIZED` fired once per cold init.
- **`abort.spec.ts`** — abort-signal plumbing at the unit level.

Emitted events live in `FileManagerEvents` (`src/utils/events.ts`).Events emitted _during_ `initialize` require the
emitter to be injected via the constructor before initializing — tests that assert them do exactly that. The file/folder
pairs of a path-addressed operation carry the same payload shape — see [REFERENCE.md](REFERENCE.md#events).

---

## Writing new tests

- **Unit vs. integration**
  - Depends on real Bee behavior (feeds, ACT, mantaray, propagation)? → **integration**, using `setupUserDrive`.
  - Validating pure `FileManagerBase` branches/edge cases? → **unit**, using `applyDefaultMocks` + `seedRecords`.

- **Integration `beforeAll` fixture** — prefer `setupUserDrive` over hand-rolling stamp/drive setup:

  ```ts
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ fileManager, drive } = await setupUserDrive('my-suite', { stampLabel: 'mySuiteStamp' }));
  });

  afterAll(cleanup);
  ```

- **On-disk fixtures** — always create them via `writeTempFile` / `writeTempDir` (they write under
  `tests/integration/tmp/` and return the absolute source path to pass as `sourcePath`). Never call
  `fs.writeFileSync`/`mkdirSync` directly in a spec, and never reuse the drive `path` string as the `sourcePath`.

- **ACT download parameters** — pass `actHistoryAddress` and `actPublisher` from the same context that uploaded:

  ```ts
  await fileManager.downloadFiles(
    [record],
    { actHistoryAddress: record.content.historyRef, actPublisher },
    { signal }, // optional requestOptions
  );
  ```

- **Propagation** — wrap reads that follow a write in `retryOnPropagationDelay(() => ...)` to avoid devnet flakiness.

- **Unit ordering** — call `applyDefaultMocks()` at the top of `beforeEach`, _before_ `createInitializedFileManager()`,
  so the mocks are in place when the manager initializes. Anything else the spec spies on Bee's prototypes goes after
  it, since `applyDefaultMocks` resets every mock.

- **Hand-written forks** — a fork the spec writes by hand needs `mockWrappedKeys()` in its metadata and
  `seedKeys(fm, topic)` for its node, or the walk that reaches it will refuse the node for having no resolvable parent.

- **Prefer explicit errors** — assert both the error **type** and **message** so regressions are easy to spot.

---

## Troubleshooting

- **bee-factory won't start / port in use** — ensure Docker is running and nothing else is bound to `1633`/`1635`. A
  previous crashed run may leave containers up; `npx bee-factory stop` clears them.
- **ACT unwrap (404/500) / permission errors** — pass **both** `actPublisher` and `actHistoryAddress` from the
  uploader's context.
- **Version assertions fail** — confirm the test re-uploads using the **same path** the record was created with and
  reads the feed head after propagation.
- **Flaky reads right after a write** — increase the `retryOnPropagationDelay` attempts/delay for that step.
- **`Cannot read properties of undefined (reading 'toBigInt')` in a unit spec** — the code under test reached the real
  `SwarmClient.readFeed` instead of the mocked `getFeedData`, because the caller lives in `@/utils/bee` alongside it.
  Serve that feed through a `bee.feed.makeReader` spy returning `{ payload, feedIndex, feedIndexNext }`, and throw
  `{ status: 404 }` for the not-found branch.
- **Leftover temp files** — shouldn't happen; every fixture goes through `tempFileRegistry()` and is removed in
  `afterAll(cleanup)`. If you added a raw `fs` write, route it through the registry.

---

## Notes on Bee mainnet

The integration suite targets a local **bee-factory** cluster. Pointing it at mainnet will be **slow**, may incur **real
costs**, may **pollute** your feed history, and can fail intermittently on network/ACT-publisher contexts. If you must,
isolate those runs and supply appropriate stamps, signers, and ACT parameters.
