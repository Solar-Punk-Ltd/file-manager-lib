# File Manager Library — API Reference

Technical API reference for **@solarpunkltd/file-manager-lib**. See [README.md](README.md) for installation, the
architecture overview and a quick start. See [ENCRYPTION_AND_ACT.md](ENCRYPTION_AND_ACT.md) for how content and the
index are encrypted, how node keys are derived and recovered, and what sharing will look like. See
[tests/TESTS.md](tests/TESTS.md) for test coverage and usage patterns.

All methods live on `FileManagerBase`, which implements the `FileManager` interface. Every method that accepts a drive
takes either a `string` id or a core-sdk `Identifier`. `requestOptions?: BeeRequestOptions` is available on every
network method for cancellation (`signal`) and retries; it is omitted from the descriptions below for brevity.

Two things every method does before anything else, so they are not repeated in each entry:

- **Readiness.** "Not initialized" in a `Throws` list below covers both readiness failures, and both raise `DriveError`:
  `FileManager is not initialized` before `initialize()` has resolved, and `No identity — create an admin drive first`
  when this credential has no provisioned identity yet.
- **Keys.** Any method that reads or writes a node needs that node's keys, which are recovered by walking down to it. A
  node the current session has never reached raises [`KeyringError`](#errors); so does a fork whose wrapped keys do not
  unwrap under its parent. See [ENCRYPTION_AND_ACT.md §5](ENCRYPTION_AND_ACT.md#5-read-and-write-paths).

---

## Contents

- [Class & construction](#class--construction) — `FileManagerBase`, `SwarmClient`, `Credential`
- [Lifecycle & bootstrap](#lifecycle--bootstrap) — `initialize`, `createAdminDrive`, `createDrive`
- [Drives](#drives) — `forgetDrive`
- [Files — write](#files--write) — `uploadFile`, `uploadFiles`, `updateFile`
- [Files — read](#files--read) — `downloadFile`, `downloadFiles`, `downloadFolder`
- [Folders](#folders) — `createFolder`, `listFolder`, `move` (also rename, and drive rename), `forget`
- [Versioning](#versioning) — `getFileVersion`, `restoreFileVersion`
- [Trash](#trash) — `trash`, `recover`, `listTrash`, `emptyTrash`
- [Getters](#getters) — `identity`, `adminStamp`, `driveList`, `recordList`, `emitter`, `isInitialized`
- [Events](#events)
- [Types](#types) — including the [port vocabulary](#port-vocabulary) a custom `SwarmClient` implements against
- [Manifest metadata keys](#manifest-metadata-keys)
- [Errors](#errors)

---

## Class & construction

### `FileManagerBase`

```ts
constructor(swarmClient: SwarmClient, emitter?: EventEmitter, config?: FileManagerConfig)
```

- **swarmClient** — a [`SwarmClient`](#swarmclient) backend. Ships with `BeeClient` (bee-js + a local `PrivateKey`, Node
  and browser) and `SnahaClient` (`@snaha/swarm-id`, browser only). The FileManager never holds key material — the
  backend exposes only an owner address and public keys.
- **emitter** _(optional)_ — an `EventEmitter` to receive `FileManagerEvents`; a default in-memory emitter is created if
  omitted.
- **config** _(optional)_ — concurrency tuning, see [`FileManagerConfig`](#filemanagerconfig).

Owns the on-Swarm drive/folder/file tree, the index encryption and its key chain, per-file version feeds, the trash
relocation, and event emission. All Swarm I/O goes through the injected `SwarmClient`.

### `SwarmClient`

The Swarm I/O seam the library depends on instead of a concrete `Bee`. No bee-js types cross it: references and keys are
hex strings, payloads are `Uint8Array`, and feed indexes are **decimal** strings. It carries identity (`owner`,
`publicKey`, `actPublisher`), plain and ACT-protected byte transfer, chunk access, sequential feed read/write,
`deriveSecret`, and a read-only `getStamp`. Stamp _management_ is deliberately out of scope — that belongs to the host
application.

```ts
readonly owner: Hex;          // 40-hex address of the login — locates the identity envelope, nothing else
readonly publicKey: Hex;      // 66-hex compressed key of `owner`
readonly actPublisher: Hex;   // 66-hex compressed key of whoever ACT-encrypts; valid only after initialize()

deriveSecret(label: string): Promise<Uint8Array>;   // 32 stable, private bytes
initialize(requestOptions?): Promise<void>;
getStamp(batchId?, requestOptions?): Promise<StampInfo | undefined>;

uploadData(batchId, data, options?, requestOptions?): Promise<ClientUploadResult>;
downloadData(reference, options?, requestOptions?): Promise<Uint8Array>;
downloadStream(reference, options?, requestOptions?): Promise<ReadableStream<Uint8Array>>;

uploadProtected(batchId, data, historyRef?, options?, requestOptions?): Promise<ClientProtectedUploadResult>;
downloadProtected(refs, at?, options?, requestOptions?): Promise<Uint8Array>;
downloadProtectedStream(refs, at?, options?, requestOptions?): Promise<ReadableStream<Uint8Array>>;

uploadChunk(batchId, data, options?, requestOptions?): Promise<ClientUploadResult>;
downloadChunk(reference, options?, requestOptions?): Promise<Uint8Array>;

readFeed(topic, owner, index?, requestOptions?): Promise<FeedRead>;
writeFeed(batchId, topic, payload, index, options?, requestOptions?): Promise<FeedWrite>;
```

`data` is `Uint8Array | string | Blob | Readable`, so a browser `File` passes straight through.

Three members deserve care, because substituting one for another fails in ways that do not look like what they are:

- **`owner`, `publicKey` and `actPublisher` are not interchangeable.** `owner` is a 20-byte address, the other two are
  33-byte compressed keys, and under `BeeClient` the ACT publisher is the **Bee node's** key rather than the signer's.
  Passing an address where a key is expected fails client-side, before any request, so it looks nothing like a 404.
- **`deriveSecret` must return bytes the backend keeps private**, and must return the same bytes on every later session.
  Deriving it from a public value compiles and passes tests, and leaves the identity envelope openable by anyone who can
  read it. See [ENCRYPTION_AND_ACT.md §2](ENCRYPTION_AND_ACT.md#2-identity--from-a-login-to-the-filemanager-key).
- **`writeFeed`'s `options.signer`** is the one place key material crosses the port, and it is always the library's own
  FMK-derived signer — never the backend's credential. Omit it and the update is signed by the backend key, which is
  what puts the identity envelope under the login's address.

The ACT members (`uploadProtected`, `downloadProtected`, `downloadProtectedStream`, `actPublisher`) are **not used by
the tree**. They are reserved for the sharing layer; a backend that will never share may throw from them.

`readFeed` reports "no update yet" as a **successful** return carrying the sentinel index
[`FEED_INDEX_NOT_FOUND`](#feed-index-constants) and a zero-address payload, rather than throwing. Callers branch on the
sentinel; retry helpers must test for it instead of catching.

The vocabulary the port speaks — hex aliases, option shapes, result shapes and the feed-index constants — is exported
from the package root and documented under [Port vocabulary](#port-vocabulary). Implement the interface against those
types to supply your own backend.

### `Credential`

How a login proves who it is. The library ships one implementation — `swarmClientCredential(swarmClient)`, which
delegates to the backend's `deriveSecret` — and uses it unless `config.credential` overrides it.

```ts
interface Credential {
  /** Raw secret bytes to derive the envelope's unlock key from. Zeroed by the library after use. */
  unlockSecret(): Promise<Uint8Array>;
}
```

It carries no owner: the envelope always lives under `swarmClient.owner`, because nothing else can sign a write there.
The secret must be **byte-stable** across sessions and devices for a given user, and must be private to whoever produces
it — see [ENCRYPTION_AND_ACT.md §2](ENCRYPTION_AND_ACT.md#2-identity--from-a-login-to-the-filemanager-key).

```ts
const fm = new FileManagerBase(swarmClient, undefined, {
  credential: { unlockSecret: () => deriveFromWalletSignature() },
});
```

### `FileManagerConfig`

```ts
interface FileManagerConfig {
  uploadConcurrency?: number; // default 2  — concurrent file uploads within uploadFiles
  feedFetchConcurrency?: number; // default 10 — concurrent feed reads while listing/resolving
  credential?: Credential; // default swarmClientCredential(swarmClient)
}
```

Both numeric values are clamped to a minimum of `1`. `uploadConcurrency` bounds concurrent content uploads;
`feedFetchConcurrency` bounds concurrent feed/record reads during `listFolder`, `listTrash`, `downloadFolder` and
version resolution. There is deliberately no `downloadConcurrency`: content downloads return lazy streams, so bounding
their _initiation_ would not bound live consumption.

---

## Lifecycle & bootstrap

The state model has three levels. A per-login **envelope feed** holds the sealed FileManager Key (FMK) and turns a
credential into the identity that owns everything else. A per-identity **state feed** — its topic derived from the FMK,
so it is unguessable from any address — has a head pointing at the **admin manifest** (the drive registry). One **drive
feed** per drive has a head pointing at that drive's mantaray. See
[README → How it works](README.md#how-it-works--a-filesystem-mirrored-onto-swarm) and
[ENCRYPTION_AND_ACT.md](ENCRYPTION_AND_ACT.md).

Bootstrapping splits along read/write: `initialize()` only reads, so it needs no stamp and a first-time user reaches
`identity === undefined` successfully. `createAdminDrive` performs the first write — minting the FMK and sealing its
envelope — so it needs one.

### `initialize(requestOptions?): Promise<void>`

Prepares the backend, resolves the identity from the envelope feed, then rehydrates existing state: reads the state
feed, loads the admin manifest, and populates `driveList`. File records are loaded lazily (via `listFolder` / `download`
/ `move`) as you navigate — there is no eager full-drive load. Safe to call once per instance.

**Never rejects.** Failures are reported as `INITIALIZED false` with all partial state rolled back, so the call can
simply be retried.

- **Emits**: `INITIALIZED`; `IDENTITY_INVALID` before `INITIALIZED false` when the credential does not unlock the stored
  identity; `STATE_INVALID` if the resolved state cannot be parsed.

`identity === undefined` afterwards means "no identity has been provisioned for this credential yet" — the normal
first-run state, not a failure. Call `createAdminDrive` to mint one.

### `createAdminDrive(batchId, redundancyLevel?, reset?, requestOptions?): Promise<DriveInfo>`

**First-time setup only.** Provisions the identity if this credential has none — generating the FMK and writing its
sealed envelope — then seeds an empty admin manifest on the derived state feed and registers the admin drive into it. On
later runs, `initialize()` alone restores everything.

- **batchId** `string | BatchId` — stamp backing the admin drive, the state feed and the identity envelope. Verified
  usable before anything is written.
- **redundancyLevel?** — optional redundancy for the admin drive.
- **reset?** `boolean` — discard existing admin state and start over (wipes local state and appends a fresh empty
  manifest at the next free slot of the same state feed; the topic itself is stable). Required when admin state already
  exists. It does **not** re-mint the identity: an existing envelope is reused, so the same drives remain reachable.
- **Returns**: the newly-created admin `DriveInfo`.
- **Emits**: `DRIVE_CREATED`.
- **Throws**: `DriveError` (not initialized, an admin drive already exists without `reset`, or admin state already
  exists without `reset`); `StampError` (the batch is unknown or not usable); `IdentityError` (an envelope already
  exists for this credential — a concurrent provisioning race).

### `createDrive(batchId, name, redundancyLevel?, requestOptions?): Promise<DriveInfo>`

Creates a non-admin drive and registers it in the admin manifest. Requires admin state to exist already
(`createAdminDrive` first). Mints the drive's node keys, saves an empty mantaray sealed under its `K_meta`, and
publishes the sealed root as the first slot of a freshly generated per-drive feed.

- **name** — display name; must be unique within the registry. The `batchId` need not be: a batch only pays for storage,
  and drive identity is `id`/`topic`, so several drives may share one. This is required under Swarm ID, which exposes a
  single usable batch per account.
- **Returns**: the newly-created `DriveInfo`.
- **Emits**: `DRIVE_CREATED`.
- **Throws**: `DriveError` (not initialized, no identity, admin state not ready, or duplicate name); `StampError`.

---

## Drives

### `forgetDrive(driveId, requestOptions?): Promise<void>`

Removes the drive and all of its file metadata from local state and persists the updated drive list. **Does not** touch
the underlying Swarm batch (no dilution). Cannot target the admin drive.

- **Emits**: `DRIVE_FORGOTTEN`.
- **Throws**: `DriveError` (not initialized, not found, or admin drive).

---

## Files — write

### `uploadFile(driveId, item, uploadOptions?, requestOptions?): Promise<FileRecord>`

Uploads a **new** file: mints a fresh feed topic and adds a new fork to the drive manifest. For re-versioning an
existing file use [`updateFile`](#updatefiledriveid-record-changes-uploadoptions-requestoptions-promisefilerecord); for
multi-file/folder uploads use
[`uploadFiles`](#uploadfilesdriveid-items-destinationpath-uploadoptions-requestoptions-promiseuploadfilesresult).

- **item** [`UploadItem`](#uploaditem) — new content (`sourcePath` on Node / `file` in browser) plus placement metadata
  (`path`). No `topic`.
- **uploadOptions?** [`UploadOptions`](#uploadoptions) — `redundancyLevel` only; defaults to the drive's.
- **Returns**: the newly-created `FileRecord`.
- **Emits**: `FILE_UPLOADED`.
- **Throws**: `DriveError` (not initialized, drive not found, target folder path missing, or a node already occupies
  `item.path`); `FolderError` (the path is under the reserved `.trash` folder); `FileError` (source is a directory, node
  source path missing, or content upload failed); `FileRecordError` (invalid `item.path`, or a folder along the path has
  no feed).

Names are fork keys, so they are unique within a folder: uploading onto an occupied name is rejected rather than
silently replacing it. Re-version with
[`updateFile`](#updatefiledriveid-record-changes-uploadoptions-requestoptions-promisefilerecord), relocate with
[`move`](#movefrompath-topath-sourcedriveid-requestoptions-promisevoid), or drop the existing node with
[`forget`](#forgetdriveid-path-requestoptions-promisevoid) first. `item.path` must have a non-empty leaf and no `.`/`..`
segments; it is validated before any content is uploaded.

### `uploadFiles(driveId, items, destinationPath?, uploadOptions?, requestOptions?): Promise<UploadFilesResult>`

Uploads multiple files, recreating their folder hierarchy as real folder nodes under `destinationPath`. Each file
becomes its own node with its own version feed and its own key pair (unlike a single opaque collection). Missing folders
are created as needed; each touched parent manifest is saved once at the end. **Partial-failure tolerant** — per-file
errors are collected, not thrown.

- **items** [`UploadItem[]`](#uploaditem) — each with a `path` relative to `destinationPath`.
- **destinationPath?** — absolute destination folder; defaults to the drive root.
- **uploadOptions?** [`UploadOptions`](#uploadoptions) — applied to every file in the batch.
- **Returns**: [`UploadFilesResult`](#uploadfilesresult) — `{ succeeded, failed }`.
- **Emits**: `FOLDER_CREATED` (per folder created), `FILE_UPLOADED` (per file), `FILES_UPLOADED` (once, batch summary).
  All of them fire **after** the last manifest is saved, so an emitted node is always in the drive tree — the batch is
  never announced in instalments, and a failed finalize emits nothing but `FILES_UPLOADED`'s absence. Upload events are
  therefore not a progress feed; use the returned `succeeded` / `failed` for outcomes.
- **Throws**: `FileRecordError` (no items, invalid item path, two items resolving to the same destination, or a
  malformed folder fork); `DriveError` (not initialized, drive not found, or a path segment is a file); `FolderError` (a
  destination is under the reserved `.trash` folder). Per-file content-upload failures go into `failed`, as does an item
  whose destination name is already taken.

Existing folders along the way are reused; existing **files** are not overwritten (see `uploadFile` above).

**Abort semantics.** Aborting wins immediately: the batch stops starting files, no manifest is saved, and the call
rejects. The batch's own in-memory state is discarded with it — its records were never committed to `recordList` and
every manifest it mutated is evicted from the store — so the drive is left exactly as it was and nothing from the
aborted batch can be committed later by an unrelated save. A finalize failure is treated the same way. Content and
record feeds written before the abort are spent but unreferenced; re-upload those files to place them.

### `updateFile(driveId, record, changes, uploadOptions?, requestOptions?): Promise<FileRecord>`

Re-versions or changes metadata of an **existing** file. Reuses the file's feed topic, writes a new feed slot, and never
touches the drive manifest (no rename — use [`move`](#movefrompath-topath-sourcedriveid-requestoptions-promisevoid) to
relocate). Everything derives from `record`.

- **record** — the existing file's `FileRecord` (the single source of truth).
- **changes** [`UpdateItem`](#updateitem) — `item` present ⇒ new bytes; absent ⇒ metadata-only. `customMetadata` is
  merged over the record's existing metadata.
- **uploadOptions?** [`UploadOptions`](#uploadoptions) — applies to the new version's bytes.
- **Returns**: the newly-written `FileRecord` for the updated version.
- **Emits**: `FILE_UPDATED`.
- **Throws**: `FileRecordError` (neither new content nor `customMetadata` provided, the file is trashed, or the fork
  belongs to another node); `DriveError`; `FolderError` (no fork at the record's path); `FileError` (content upload
  failed); `KeyringError` (the node's keys could not be recovered, see below).

The new version's payload is sealed under the file's `K_content`, so the call needs that key. A record held across a
process restart carries none, so the record's `path` is re-walked to recover it. That is transparent when the path is
still current; a record whose node has since moved raises `KeyringError`. Re-resolve such a record through
[`listFolder`](#listfolderdriveid-path-depth-maxdepth-requestoptions-promiselistfolderresult) first.

---

## Files — read

All download methods return a `ReadableStream<Uint8Array>` per file (Node and browser alike). Fetch failures are
**logged, not thrown**, unless noted.

Downloading content needs **no key from the keyring**: `record.content.reference` is 64 bytes of `address ‖ key`, so it
is a self-contained capability and Swarm decrypts the bytes itself. That is what makes a record obtained in an earlier
session still downloadable, and what will make publishing a single file a matter of publishing that reference.

### `downloadFile(record, options?, requestOptions?): Promise<DownloadResult>`

Downloads a single file the caller already holds as a `FileRecord`.

- **Returns**: a single [`DownloadResult`](#downloadresult).
- **Throws**: `DriveError` (not initialized). Content-fetch failures are logged.

### `downloadFiles(fileRecords, options?, requestOptions?): Promise<DownloadFilesResult>`

Downloads files whose `FileRecord`s the caller already holds — no drive traversal or re-resolution. Fetches exactly the
passed records.

- **Returns**: one `DownloadFilesResult` marking per record success and failure.
- **Throws**: `DriveError` (not initialized). Per-record failures are logged.

### `downloadFolder(driveId, path?, options?, requestOptions?): Promise<DownloadFilesResult[]>`

Downloads every file in a folder subtree, resolved fresh via `listFolder`. `path` omitted ⇒ the whole drive.

- **Returns**: one `DownloadFilesResult` marking per file success and failure in the subtree.
- **Throws**: `DriveError` (not initialized, drive not found, or folder path missing); `FolderError` (`path` is the
  reserved `.trash` folder).

`failed` covers **both** halves: files that could not be fetched, and files the listing walk could not resolve in the
first place (folded in from `listFolder`, prefixed `Could not list …`). A file dropped during the walk can never be
fetched, so reporting only fetch failures would let a partial download read as a complete one.

---

## Folders

### `createFolder(driveId, parentPath, folderName, redundancyLevel?, requestOptions?): Promise<FolderInfo>`

Creates a new empty folder (a nested mantaray) within a drive.

- **parentPath** — absolute path of the parent, or `'/'` for the drive root.
- **folderName** — must not contain `/`, and must not already be taken by a file or folder in the parent.
- **redundancyLevel?** — inherits from parent or drive if omitted.
- **Returns**: the new `FolderInfo`.
- **Emits**: `FOLDER_CREATED`.
- **Throws**: `DriveError` (not initialized, drive not found, or parent path missing); `FolderError` (invalid or
  reserved name, or the name is already taken); `FileRecordError` (a folder feed is missing).

`mkdir` semantics, not upsert: a duplicate name is rejected before a feed is minted for it. `uploadFiles` differs
deliberately — it reuses an existing folder on the way to a file rather than failing.

### `listFolder(driveId, path, depth?, maxDepth?, requestOptions?): Promise<ListFolderResult>`

Lists entries in a folder (or drive root) from the drive manifest, hydrating and caching any file entries into
`recordList`. The reserved `.trash` folder is omitted from the drive root and cannot be listed here — use `listTrash`.

- **path** — absolute folder path, or `'/'` for the drive root.
- **depth?** [`ListDepth`](#enums) — `Shallow` (one level, default) or `Deep` (full BFS).
- **maxDepth?** — max BFS levels when `Deep`; must be positive, unlimited if omitted.
- **Returns**: [`ListFolderResult`](#listfolderresult) — `entries` ([`NodeEntry`](#nodeentry)) for every node resolved
  at or below `path`, and `failed` ([`NodeFailure`](#nodefailure)) for every node that could not be.
- **Throws**: `DriveError` (not initialized, drive not found, or a path segment missing); `FolderError` (`path` is the
  reserved `.trash` folder, or `maxDepth` is not positive).

A node present in the manifest that the walk cannot resolve is **reported, never omitted**: an unreadable file record, a
folder whose feed is missing, or a manifest that fails to load all land in `failed`. Omitting them would make a broken
node indistinguishable from one that was never there. `scope` says how much is hidden — `entry` is that node alone,
`subtree` means its descendants were never enumerated, so their number and names are unknown.

A subtree-scoped failure does not imply the node itself is absent from `entries`: a folder whose feed resolves but whose
manifest cannot be read is listed _and_ reported, because it exists — only its contents are unknown.

### `move(fromPath, toPath, sourceDriveId, requestOptions?): Promise<void>`

Moves or renames a file or folder **within a single drive**. Path-addressed and dispatches on node type, so it works for
both files and folders. Same parent ⇒ rename; different parent ⇒ relocate.

- **Emits**: `FILE_MOVED` (file), `FOLDER_MOVED` (folder), or `DRIVE_RENAMED` (drive rename, see below).
- **Throws**: `DriveError` (not initialized, drive not found, or a folder along either path missing; on a drive rename:
  the drive is the admin drive, the name is unchanged, or another drive already carries that name); `FolderError`
  (source is root with an invalid destination, invalid destination, source == destination, source not found, destination
  occupied, or either path under `.trash`); `FileRecordError` (a folder feed or the source record is missing);
  `KeyringError` (the moved node's wrapped keys do not unwrap under its current parent).

**No version bump.** A node's name is its fork label in the parent manifest, not part of the record payload, so a move
or rename rewrites no record and pins no new version — the file's version history is untouched either way. This is the
same rule `trash` and `recover` follow. It also means a moved file needs no feed read at all: relocation is a pure
manifest operation.

**Keys are re-wrapped on a cross-parent move.** A node's keys are sealed under its parent's, so relocating a fork
verbatim would leave an entry that lists correctly and opens for nobody. The move unwraps under the old parent and
re-wraps under the new one — still O(1), one unwrap and one wrap, regardless of subtree size. A same-parent move (a
rename) shares the key and re-wraps nothing. A **drive** rename re-wraps too, because it rebuilds the drive's fork
metadata from scratch to change the name.

**Renaming a drive** — pass `'/'` as `fromPath` and the new name as `toPath`:

```ts
await fm.move('/', 'My Renamed Drive', drive.id);
```

`toPath` must not contain `/`. This edits the **admin** manifest rather than the drive's own — a drive's name lives
solely in its admin-manifest fork metadata, and that fork is keyed by drive id, so nothing is relabelled and the drive's
own feed is not written. Identity, contents and `manifestRef` are untouched. The admin drive cannot be renamed. Every
other use of `'/'` as `fromPath` still throws `Cannot move root folder`.

There is no cross-drive move: a relocated node keeps its drive's `batchId`, so a file "in" another drive would still be
paid for — and die — with the original stamp. Both paths are resolved against `sourceDriveId`, so a path from another
drive simply is not found. To relocate content between drives, `forget` it and re-upload to the target.

### `forget(driveId, path, requestOptions?): Promise<void>`

**Hard-delete** a file or folder at `path` from the drive manifest and in-memory state. For folders, all descendant
`FileRecord`s are also purged from `recordList`. The underlying Swarm data persists (content-addressed), but the node is
removed from the tree.

- **Emits**: `FILE_FORGOTTEN` (file) or `FOLDER_FORGOTTEN` (folder).
- **Throws**: `DriveError` (not initialized, drive not found, or a folder along the path missing); `FolderError` (path
  is the drive root, or `.trash` itself — use `emptyTrash`); `FileRecordError` (path not found, or a folder feed is
  missing).

---

## Versioning

Each file has its own feed; every version is a slot. Drives and folders gain version history implicitly because every
structural change publishes a new manifest slot.

### `getFileVersion(record, version?, requestOptions?): Promise<FileRecord>`

Returns a specific version of a file.

- **record** — base `FileRecord` (provides `topic`, `owner` and the node's current path).
- **version?** `string | FeedIndex` — desired slot; latest if omitted. A `string` must be the 16-hex-character
  `FeedIndex` form (`FeedIndex.fromBigInt(0n).toString()`), not a decimal like `'0'`.
- **Returns**: the `FileRecord` for that version (cached or fetched). Its `path` is the node's **current** absolute
  location, not the leaf stored in the requested slot — restoring a version restores content, never location.
- **Throws**: `DriveError` (not initialized); `FileRecordError` (file feed not found); `KeyringError` (the node's keys
  could not be recovered — every slot of a file's feed is sealed under the same `K_content`, which is walked to, not
  carried on the record).

### `restoreFileVersion(versionToRestore, requestOptions?): Promise<void>`

Restores a previous version as the new head of the file's feed. Per-file only — there is deliberately **no**
folder/drive-level restore.

- **Emits**: `FILE_VERSION_RESTORED`.
- **Throws**: `DriveError` (not initialized, or no fork at the file's current path); `FileRecordError` (feed not found,
  restore version undefined, it is already the current head, or the fork at that path belongs to a different node);
  `KeyringError` (the node's keys could not be recovered).

---

## Trash

Trash is a **reserved `.trash` folder** at the drive root, not a metadata overlay. Trashing relocates a node's fork into
it — keyed by the node's own topic, so same-named nodes never collide — and stamps the path it came from onto the moved
fork. The node's feed, version and content are untouched, and a folder's subtree rides along unread, so any trash or
recover is two manifest writes regardless of depth.

Both directions cross a parent boundary, so both re-wrap the moved node's keys under the new parent — see
[`move`](#movefrompath-topath-sourcedriveid-requestoptions-promisevoid). Descendants are unaffected: their keys are
wrapped under the moved node, which travels with them.

Trashed nodes leave the active namespace completely: `listFolder` omits `.trash` from the drive root and refuses to
descend into it, `downloadFolder` skips trashed files, and `updateFile` / `uploadFile` / `createFolder` / `move` refuse
any path under `.trash`. The folder is created lazily on the first trash, so a drive that never trashes anything carries
no trash node at all.

### `trash(driveId, path, requestOptions?): Promise<void>`

Soft-deletes the file or folder at `path`. Bare and path-addressed — it dispatches on the resolved node type.

- **Emits**: `FILE_TRASHED` or `FOLDER_TRASHED`, with `{ driveId, path, trashedPath }` (plus `record` for a file).
- **Throws**: `DriveError` (not initialized, drive not found, or a folder along the path missing); `FolderError` (path
  is the drive root, already under `.trash`, or the node itself not found); `FileRecordError` (fork missing node
  metadata).

### `recover(driveId, trashedPath, toPath?, requestOptions?): Promise<string>`

Restores a trashed node to `toPath`, or to the location stamped on it when `toPath` is omitted. Restores **location
only** — content and version are whatever they were.

The stamped origin can go stale: if that folder has since been forgotten, moved or trashed, resolution fails and the
caller passes an explicit `toPath`. An occupied destination is refused, never overwritten.

- **Returns**: the path the node was restored to.
- **Emits**: `FILE_RECOVERED` or `FOLDER_RECOVERED`.
- **Throws**: `DriveError` (destination occupied, or the destination's parent no longer exists); `FolderError`
  (destination under `.trash`); `FileRecordError` (`trashedPath` is not `.trash/<topic>`, invalid destination path, not
  in the trash, or no stamped origin and no `toPath`).

### `listTrash(driveId, depth?, maxDepth?, requestOptions?): Promise<ListFolderResult>`

Walks `.trash` with the same machinery as `listFolder`, so `depth` controls the cost: `Shallow` (default) returns the
trashed roots only, `Deep` descends into trashed folders. Returns `[]` for a drive with no trash node.

Entries carry `status = trashed`, `path` = their real location under `.trash`, and `trashedFrom` = where they came from.

- **maxDepth?** — max BFS levels when `Deep`; must be positive, unlimited if omitted.
- **Returns**: the trashed nodes; pass a `path` back to `recover`.
- **Throws**: `DriveError` (not initialized or drive not found); `FolderError` (`maxDepth` is not positive).

### `emptyTrash(driveId, requestOptions?): Promise<number>`

De-references every trashed node in one manifest write. Like `forget`, the content stays on Swarm until its stamp
expires — this drops references, it does not delete data.

- **Returns**: how many nodes were de-referenced.
- **Emits**: `TRASH_EMPTIED`.
- **Throws**: `DriveError` (not initialized or drive not found).

---

## Getters

| Getter                                | Description                                                         |
| ------------------------------------- | ------------------------------------------------------------------- |
| `identity: IdentityInfo \| undefined` | The provisioned identity, or `undefined` on a first run. See below. |
| `adminStamp: StampInfo \| undefined`  | Admin postage batch used for drive-management operations.           |
| `driveList: readonly DriveInfo[]`     | In-memory list of all known drives.                                 |
| `recordList: readonly FileRecord[]`   | In-memory cache of file records, populated lazily as you navigate.  |
| `emitter: EventEmitter`               | Emitter carrying `FileManagerEvents`.                               |
| `isInitialized: boolean`              | Whether `initialize()` has completed.                               |

Both list getters are `readonly` — treat them as snapshots and mutate state only through the methods above.

### `identity`

```ts
interface IdentityInfo {
  readonly owner: Hex; // FMK-derived address that owns and signs every feed the library writes
  readonly keyId: Hex; // non-secret fingerprint of the FMK, salted with its envelope's salt
}
```

`undefined` after `initialize()` is a **normal first-run state**, not an error: it means no identity has been
provisioned for this credential yet, which is exactly what a newcomer with no stamp looks like. Render a first-run
screen and call `createAdminDrive`.

`identity.owner` is **not** `swarmClient.owner`. The login's address only locates the sealed identity envelope; the
identity's own address owns everything else, which is what lets one user reach one set of drives from several login
methods. Persist `owner` rather than `keyId` as "which identity is this": `owner` is derived from the FMK unsalted, so
every credential unsealing the same identity reports the same value, while `keyId` is salted with its own envelope's
salt and so names one envelope. Two credentials linked to one FMK would look like two identities under `keyId`. The
identity's private key is deliberately not on this type and never leaves the library.

---

## Events

Emitted on the provided `EventEmitter` as `FileManagerEvents`:

| Event                   | Fired by                                           | Payload                                              |
| ----------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `INITIALIZED`           | `initialize` (success or failure)                  | `boolean`                                            |
| `IDENTITY_INVALID`      | `initialize` (credential does not unlock)          | `boolean` (always `false`)                           |
| `STATE_INVALID`         | `initialize` (unparseable state)                   | `boolean`                                            |
| `DRIVE_CREATED`         | `createAdminDrive`, `createDrive`                  | `{ driveInfo }`                                      |
| `DRIVE_RENAMED`         | `move` with `'/'` as source                        | `{ driveInfo }`                                      |
| `DRIVE_UNRESOLVED`      | `initialize` (per unloadable drive)                | `{ id, name, error }`                                |
| `DRIVE_FORGOTTEN`       | `forgetDrive`                                      | `{ driveInfo }`                                      |
| `FILE_UPLOADED`         | `uploadFile`, `uploadFiles` (per file)             | `{ record }`                                         |
| `FILES_UPLOADED`        | `uploadFiles` (once, batch summary)                | `{ succeeded, failed }`                              |
| `FILE_UPDATED`          | `updateFile`                                       | `{ record }`                                         |
| `FILE_VERSION_RESTORED` | `restoreFileVersion`                               | `{ restored }`                                       |
| `FILE_MOVED`            | `move` (file)                                      | `{ driveId, fromPath, toPath, record }`              |
| `FOLDER_MOVED`          | `move` (folder)                                    | `{ driveId, fromPath, toPath, folderInfo }`          |
| `FILE_TRASHED`          | `trash` (file)                                     | `{ driveId, path, trashedPath, record }`             |
| `FOLDER_TRASHED`        | `trash` (folder)                                   | `{ driveId, path, trashedPath, folderInfo }`         |
| `FILE_RECOVERED`        | `recover` (file)                                   | `{ driveId, trashedPath, restoredPath, record }`     |
| `FOLDER_RECOVERED`      | `recover` (folder)                                 | `{ driveId, trashedPath, restoredPath, folderInfo }` |
| `FILE_FORGOTTEN`        | `forget` (file)                                    | `{ driveId, path, record }`                          |
| `FOLDER_FORGOTTEN`      | `forget` (folder)                                  | `{ driveId, path, folderInfo }`                      |
| `FOLDER_CREATED`        | `createFolder`, `uploadFiles` (per folder created) | `{ folderInfo }`                                     |
| `TRASH_EMPTIED`         | `emptyTrash`                                       | `{ driveId, count }`                                 |

`move` / `trash` / `recover` / `forget` are path-addressed and dispatch on node type, so each emits a file **or** folder
event whose payloads are the same shape: the drive id, the operation's paths, and the node itself — a
[`FileRecord`](#filerecord) as `record` or a [`FolderInfo`](#folderinfo) as `folderInfo`. `record` is `undefined` when
the file was never hydrated into `recordList`; `folderInfo` is composed from the fork's metadata, so it carries no
`manifestRef`.

Every event fires only after the Swarm writes behind it have landed, so a received event always describes committed
state, never an operation still in flight — a failed operation rejects and emits nothing. Consequently events are not a
progress feed; for batch progress use the `succeeded` / `failed` result.

`INITIALIZED`, `IDENTITY_INVALID`, `STATE_INVALID` and `DRIVE_UNRESOLVED` are emitted **during** `initialize`, so a
listener attached afterwards misses them. Pass your own emitter to the constructor to observe them.

`IDENTITY_INVALID` fires immediately before `INITIALIZED false` when an identity envelope exists for this credential but
will not unseal — the credential re-derived a different unlock secret, or the envelope belongs to a different FMK. It is
a distinct event on purpose: "sign in with the other credential" and "the node is unreachable" need different screens,
and the alternative would be presenting a silently empty drive list. A **missing** envelope is not this event: that is a
first run, and it leaves `identity === undefined` with `INITIALIZED true`.

`DRIVE_UNRESOLVED` ([`UnresolvedDrive`](#unresolveddrive)) fires once per drive that is registered in the admin manifest
but cannot be loaded — most often one whose own manifest feed has not propagated or was never fully written. Such a
drive is absent from `driveList`, so every later call addressing it fails with "drive not found"; the event is the only
signal that it exists but is broken. `id` and `name` fall back to `'unknown'` when the fork metadata itself is
unparseable.

---

## Types

### Enums

```ts
enum NodeType {
  File = 'file',
  Folder = 'folder',
  Drive = 'drive',
}
enum NodeStatus {
  Active = 'active',
  Trashed = 'trashed',
}
enum ListDepth {
  Shallow = 'shallow',
  Deep = 'deep',
}
enum FailureScope {
  Entry = 'entry', // this node alone
  Subtree = 'subtree', // this node's descendants were never enumerated
}
```

### Port vocabulary

Everything [`SwarmClient`](#swarmclient) speaks, exported from the package root. Deliberately free of bee-js and
swarm-id types — hex strings and plain bytes only, converted on each side of the port. That is what keeps the seam
stable across backend SDK major versions, and what makes a third-party backend possible without depending on either SDK.

#### Aliases

```ts
type Hex = string; // reference / address / public key, unprefixed hex
type FeedIndexString = string; // uint64 feed index as a DECIMAL string, e.g. '0', '42'
type SwarmRedundancyLevel = number; // 0–4; bee-js spells these RedundancyLevel.OFF … PARANOID
type SwarmRedundancyStrategy = number; // 0–3; bee-js spells these RedundancyStrategy.NONE … RACE
```

Feed indexes are **decimal** across the port. Note that bee-js's `FeedIndex.toString()` emits 16-char **hex**, so never
hand its output to a port method: `BigInt('0000000000000000')` is still `0`, which makes the mismatch silent. Convert
with `FeedIndex.fromBigInt(BigInt(s))` and `index.toBigInt().toString()`.

#### Feed index constants

```ts
const FEED_INDEX_NOT_FOUND: FeedIndexString = '18446744073709551615'; // uint64 max
const FEED_INDEX_START: FeedIndexString = '0';
```

> These two are part of the port contract but are **not currently re-exported from the package root** — a third-party
> backend must mirror the literal values above.

A feed with no update yet is an expected state, not a failure, so [`readFeed`](#swarmclient) reports it **in band**: a
successful return carrying `FEED_INDEX_NOT_FOUND` as `index`, `FEED_INDEX_START` as `nextIndex`, and a zero-address
payload. Every backend must emit exactly these values, and every caller must test for them.

Two consequences follow from nothing being thrown:

- Retry-on-throw helpers never fire. A retry loop must test `FEED_INDEX_NOT_FOUND`, not `catch`.
- A missed check reads as a valid index whose payload is 32 zero bytes — which typically surfaces far away as
  `JSON.parse` failing on `""`.

#### Options

```ts
interface SwarmRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  headers?: Record<string, string>;
}
interface SwarmUploadOptions {
  redundancyLevel?: SwarmRedundancyLevel;
  /** Swarm native encryption: a random per-object key, returned embedded in a 64-byte reference. */
  encrypt?: boolean;
}
interface SwarmFeedWriteOptions extends SwarmUploadOptions {
  /** Private key (64 hex chars) to sign this feed update with, overriding the backend's own key. */
  signer?: Hex;
}
interface SwarmDownloadOptions {
  redundancyStrategy?: SwarmRedundancyStrategy;
  fallback?: boolean;
}
```

These are the only options that reach a backend. `BeeClient` honours all of them. `SnahaClient` drops `redundancyLevel`,
`redundancyStrategy` and `signal` — see its class doc for the full list of gaps and why each one is absorbed rather than
emulated. Note the asymmetry that follows: `encrypt` survives on both backends, `redundancyLevel` does not, so data
written through Swarm ID is encrypted but not erasure-coded.

`signer` is the single exception to "no key material crosses the port", and it is always the library's own FMK-derived
feed key — never the backend's credential. Feed updates are single chunks, so the inherited upload options are ignored
on `writeFeed`; only `signer` is read.

#### References and results

```ts
interface ContentRef {
  /** 32- or 64-byte hex. When 64, the second half is the Swarm-native decryption key. */
  reference: Hex;
}

// Retained for the share layer; no tree operation produces or consumes these.
interface ActReferences {
  reference: string; // the ACT-encrypted content reference
  historyRef: string; // ACT history, required to decrypt it later
}
interface ProtectedRefs extends ActReferences {
  publisher: Hex; // compressed public key of whoever encrypted — see actPublisher
}

interface FeedRead {
  payload: Uint8Array;
  index: FeedIndexString;
  nextIndex: FeedIndexString;
}
interface FeedWrite {
  reference: Hex;
  index: FeedIndexString;
}

interface ClientUploadResult {
  reference: Hex;
  tagUid?: number;
}
interface ClientProtectedUploadResult {
  contentRefs: ActReferences;
  tagUid?: number;
}

interface FailedResult {
  path: string;
  error: string;
}
```

`FailedResult` is the shared per-item failure shape in the partial-success results
([`UploadFilesResult`](#uploadfilesresult), [`DownloadFilesResult`](#downloadfilesresult)). [`StampInfo`](#stampinfo)
below is also part of this vocabulary — it is what `getStamp` returns.

### `StampInfo`

The port's stamp view — deliberately narrower than bee-js's `PostageBatch`, since the library only ever reads stamps.

```ts
interface StampInfo {
  batchId: string;
  usable: boolean;
  depth: number;
}
```

### `NodeResource`

Base shape shared by every node.

```ts
interface NodeResource {
  batchId: string;
  topic: string;
  owner: string; // always identity.owner — the FMK-derived address, never the login's
  redundancyLevel: RedundancyLevel;
  version?: string;
  status?: NodeStatus;
}
```

### `FileRecord`

A file leaf. Its `content` is the 64-byte Swarm reference to the content bytes; version history lives in the file's feed
(`topic`).

```ts
interface FileRecord extends NodeResource {
  type: NodeType.File;
  // Derived, not persisted — stripped before writing and rehydrated by the manifest walk.
  // A record belongs to whichever drive's manifest references it.
  driveId?: string;
  status?: NodeStatus;
  path: string; // absolute path within the drive
  name: string; // bare filename — the one identity field of the three that IS persisted
  content: ContentRef; // { reference } — 64 bytes: address ‖ decryption key
  timestamp?: number;
  customMetadata?: Record<string, string>;
  trashedFrom?: string;
}
```

**`content.reference` is a capability, not just a locator.** Its second half is the key Swarm generated for those bytes,
so anyone holding the full 64 bytes can fetch and decrypt the file from any gateway, with no identity and no stamp.
Treat it as you would the file itself. The record **does not** carry the node's `K_meta`/`K_content` — those are held
only wrapped in the parent manifest and recovered by walking, which is why a stale record raises `KeyringError` on
`updateFile` but downloads fine.

`name` and `path` are not interchangeable. The **fork label in the parent manifest is authoritative** for a node's name;
`path` is composed during the walk and never written. `name` is persisted only so a record read by topic alone is
self-describing — and because a rename rewrites no record, it can lag behind the fork label until the next content
write. Trust `path` on anything obtained from a listing.

### `DriveInfo`

A drive = a mantaray host with an id and a name.

```ts
interface DriveInfo extends ManifestHost {
  type: NodeType.Drive;
  id: string;
  name: string;
  isAdmin: boolean;
}
```

### `FolderInfo`

A folder = a mantaray host at a path within a drive.

```ts
interface FolderInfo extends ManifestHost {
  type: NodeType.Folder;
  path: string;
  driveId: string;
  trashedFrom?: string;
}
```

### `ManifestHost`

Mixin for nodes that own a sub-manifest (drives and folders). Has `manifestRef` instead of `content`; carries no
per-node `version`.

```ts
interface ManifestHost extends NodeResource {
  manifestRef?: ContentRef; // 32-byte mantaray root; the feed slot holds it sealed under K_meta
  version?: never;
}
```

### `NodeEntry`

```ts
type NodeEntry = FileRecord | FolderInfo; // discriminate on `.type`
```

### `ListFolderResult`

Returned by `listFolder` and `listTrash`.

```ts
interface ListFolderResult {
  entries: NodeEntry[];
  failed: NodeFailure[];
}
```

### `NodeFailure`

A node present in a manifest that a listing could not resolve. Reported, never silently dropped.

```ts
interface NodeFailure {
  path: string;
  scope: FailureScope; // 'entry' = this node; 'subtree' = its descendants are unknown too
  error: string;
  type?: NodeType; // absent when the walk never learned what the node was
  topic?: string;
}
```

### `UnresolvedDrive`

Payload of `DRIVE_UNRESOLVED`.

```ts
interface UnresolvedDrive {
  id: string; // 'unknown' if the fork metadata itself was unparseable
  name: string; // 'unknown' likewise
  error: string;
}
```

### `UploadItem`

Upload metadata plus the environment-specific byte source. `topic` is intentionally absent (a new topic is minted).

```ts
type UploadSource = { file: File } | { sourcePath: string }; // browser | node (+ optional onUploadProgress)
type UploadItem = UploadMetadata & UploadSource; // UploadMetadata ⊂ FileRecord fields, incl. `path`
```

### `UpdateItem`

```ts
interface UpdateItem {
  item /* metadata (no path) */?: UploadSource; // present ⇒ new bytes; absent ⇒ metadata-only
  customMetadata?: Record<string, string>;
}
```

### `UploadOptions`

```ts
interface UploadOptions {
  redundancyLevel?: RedundancyLevel; // bee-js enum; defaults to the drive's
}
```

Deliberately narrower than bee-js's `FileUploadOptions`. Content rides the `SwarmClient` port, whose
[`SwarmUploadOptions`](#port-vocabulary) carries only `redundancyLevel` and `encrypt` — pinning, tags and deferred
uploads have nowhere to land, so they are not offered rather than accepted and dropped. `encrypt` is not offered either:
it is forced on for every content upload, because a `FileRecord`'s 64-byte reference is the only thing guarding its
bytes.

`redundancyLevel` reaches Swarm on the `BeeClient` backend only. `SnahaClient` discards it (swarm-id removed the option
in 0.3.0), so data written through swarm-id is encrypted but not erasure-coded.

### `UploadFilesResult`

```ts
interface UploadFilesResult {
  succeeded: FileRecord[];
  failed: { path: string; error: string }[];
}
```

### `DownloadFilesResult`

```ts
interface DownloadFilesResult {
  succeeded: DownloadResult[];
  failed: FailedResult[];
}
```

### `DownloadResult`

```ts
interface DownloadResult {
  path: string;
  result: ReadableStream<Uint8Array>;
}
```

### `NodeHeader`

Intermediate, pre-hydration view of a manifest fork (surfaced during listing/traversal).

```ts
interface NodeHeader {
  path: string;
  type: NodeType;
  topic: string;
  owner?: string;
  version?: string;
  head?: ContentRef;
  rawMetadata: Record<string, string>; // the fork's raw metadata map, incl. the wrapped keys
}
```

### `NodeKeys` and `WrappedKeys`

A node's two symmetric keys and the form they take inside a parent's fork metadata. Exported for completeness; nothing
on the public API accepts or returns them today, and they become relevant when sharing lands.

```ts
interface NodeKeys {
  meta: Uint8Array; // 32 bytes — unlocks this node's listing (its manifest and manifest feed)
  content: Uint8Array; // 32 bytes — unlocks this node's content pointer (its record feed)
}

interface WrappedKeys {
  meta: Hex; // iv ‖ AES-256-GCM(K_meta(parent), K_meta(child))
  content: Hex; // iv ‖ AES-256-GCM(K_content(parent), K_content(child))
}
```

### Identity types

```ts
interface IdentityInfo {
  readonly owner: Hex; // FMK-derived; owns and signs every feed the library writes
  readonly keyId: Hex; // salted, non-secret fingerprint of the FMK
}

interface Credential {
  unlockSecret(): Promise<Uint8Array>;
}

/** Wire format of the sealed FMK, stored as JSON directly in the envelope feed payload. */
interface IdentityEnvelope {
  v: number; // KDF epoch
  salt: Hex; // 16 public bytes, fresh per envelope
  sealed: Hex; // iv ‖ AES-256-GCM(K_unlock, FMK)
  keyId: Hex;
}
```

`Identity` — the internal type carrying `stateTopic`, `signer` and the FMK-derived key material — is exported for typing
but is never handed out by the public API. `fm.identity` is an `IdentityInfo`.

---

## Manifest metadata keys

Each manifest fork carries a metadata map that mirrors inode metadata. Keys are stable string constants:

| Constant                                | Key                         | On    | Purpose                                       |
| --------------------------------------- | --------------------------- | ----- | --------------------------------------------- |
| `MANIFEST_METADATA_NODE_TOPIC`          | `swarm-node-topic`          | all   | The node's own topic                          |
| `MANIFEST_METADATA_NODE_TYPE`           | `swarm-node-type`           | all   | `file` / `folder` / `drive`                   |
| `MANIFEST_METADATA_NODE_OWNER`          | `swarm-node-owner`          | all   | Owner address                                 |
| `MANIFEST_METADATA_NODE_VERSION`        | `swarm-node-version`        | file  | Version / feed index                          |
| `MANIFEST_METADATA_REDUNDANCY_LEVEL`    | `swarm-redundancy-level`    | all   | Redundancy strategy                           |
| `MANIFEST_METADATA_WRAPPED_META_KEY`    | `swarm-wrapped-meta-key`    | all   | `K_meta(child)` sealed under `K_meta(parent)` |
| `MANIFEST_METADATA_WRAPPED_CONTENT_KEY` | `swarm-wrapped-content-key` | all   | `K_content(child)` sealed under the parent's  |
| `MANIFEST_METADATA_DRIVE_ID`            | `swarm-drive-id`            | drive | Drive identifier                              |
| `MANIFEST_METADATA_DRIVE_NAME`          | `swarm-drive-name`          | drive | Drive display name                            |
| `MANIFEST_METADATA_DRIVE_OWNER`         | `swarm-drive-owner`         | drive | Drive owner                                   |
| `MANIFEST_METADATA_DRIVE_IS_ADMIN`      | `swarm-drive-is-admin`      | drive | Admin-drive flag                              |
| `MANIFEST_METADATA_DRIVE_BATCH_ID`      | `swarm-drive-batch-id`      | drive | Backing postage batch                         |
| `MANIFEST_METADATA_TRASHED_FROM`        | `swarm-trashed-from`        | trash | Path the node was trashed from                |

The map is **not encrypted** — the manifest chunk carrying it is, under the host's `K_meta`. So reaching this metadata
already requires the parent's key, and the two wrapped-key entries are ciphertext regardless.

The two wrapped-key entries are the key chain's only on-Swarm home. A fork missing them raises `KeyringError` naming the
fork, rather than failing later as an unwrap of `undefined`. That matters most where fork metadata is rebuilt from
scratch rather than relocated — a drive rename — since dropping them there would leave a drive that lists and never
opens.

There is no `swarm-node-act-publisher` / `swarm-drive-act-publisher` any more. The publisher described whoever was
_reading_, not the node, and under Swarm ID it was the login's own public key — so writing it beside `swarm-node-owner`
published the link between a user's login and their identity address to anyone holding a manifest chunk.

---

## Errors

All errors extend `FileManagerError` (which sets an explicit `.name` and supports an ES2022 `cause`), so consumers can
catch broadly (`instanceof FileManagerError`) or branch on `error.name`.

| Error             | Meaning                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `DriveError`      | Drive creation or lookup problems, and both readiness failures (not initialized, no identity).  |
| `FolderError`     | Folder-operation failures — invalid names/paths, collisions, reserved `.trash`.                 |
| `FileError`       | Content/IO failures — reading, uploading, or downloading file bytes.                            |
| `FileRecordError` | Record / feed / metadata failures (missing feed, invalid version, etc.).                        |
| `IdentityError`   | The identity envelope will not unseal, belongs to another FMK, or already exists. See below.    |
| `KeyringError`    | A node's keys are not in the chain and cannot be recovered. See below.                          |
| `StampError`      | Postage stamp missing or not usable.                                                            |
| `SignerError`     | Backend-level: no signer, or the backend was used before `initialize()`. Raised by the clients. |
| `BeeVersionError` | Connected Bee node version is unsupported.                                                      |

**`IdentityError`** means the credential and the stored identity disagree, and it is always fatal for that credential —
there is no retry that helps. It is raised when the envelope's authentication tag fails (a different unlock secret was
derived), when its `keyId` names a different FMK, when its version does not match the current KDF epoch, or when
provisioning finds an envelope already present. `initialize()` surfaces it as `IDENTITY_INVALID` before
`INITIALIZED false`.

**`KeyringError`** means a node cannot be opened because its keys were never recovered. Two shapes:

- _"No keys for node `<topic>` — its parent was never resolved"_ — the session has not walked down to this node. List
  the containing folder first.
- _"Fork `<topic>` does not unwrap under its parent"_ / _"Fork carries no wrapped keys"_ — the manifest and the key
  chain disagree, which normally means a fork was relocated without re-wrapping or was written by an incompatible
  version.

Neither is recoverable by retrying, and neither is a network problem. See
[ENCRYPTION_AND_ACT.md](ENCRYPTION_AND_ACT.md).

---

## Node vs Browser

The only surface difference is the upload/update byte source:

- **Node** — `{ path: 'in/drive.txt', sourcePath: '/on/disk.txt' }`
- **Browser** — `{ path: 'in/drive.txt', file: someFile }`

Downloads return `ReadableStream<Uint8Array>` per file in both environments. Redundancy and request options are passed
identically; in the browser they are applied as request headers by bee-js.
