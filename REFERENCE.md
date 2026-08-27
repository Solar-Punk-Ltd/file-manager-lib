# File Manager Library — API Reference

Technical API reference for **@solarpunkltd/file-manager-lib**. See [README.md](README.md) for installation, the
architecture overview and a quick start. See [tests/TESTS.md](tests/TESTS.md) for test coverage and usage patterns.

All methods live on `FileManagerBase`, which implements the `FileManager` interface. Every method that accepts a drive
takes either a `string` id or a bee-js `Identifier`. `requestOptions?: BeeRequestOptions` is available on every network
method for cancellation (`signal`) and retries; it is omitted from the descriptions below for brevity.

---

## Contents

- [Class & construction](#class--construction) — `FileManagerBase`, `SwarmClient`
- [Lifecycle & bootstrap](#lifecycle--bootstrap) — `initialize`, `createAdminDrive`, `createDrive`
- [Drives](#drives) — `forgetDrive`
- [Files — write](#files--write) — `uploadFile`, `uploadFiles`, `updateFile`
- [Files — read](#files--read) — `downloadFile`, `downloadFiles`, `downloadFolder`
- [Folders](#folders) — `createFolder`, `listFolder`, `move` (also rename, and drive rename), `forget`
- [Versioning](#versioning) — `getFileVersion`, `restoreFileVersion`
- [Trash](#trash) — `trash`, `recover`, `listTrash`, `emptyTrash`
- [Getters](#getters) — `adminStamp`, `driveList`, `recordList`, `emitter`, `isInitialized`
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

Owns the on-Swarm drive/folder/file tree, ACT wrapping, per-file version feeds, the trash relocation, and event
emission. All Swarm I/O goes through the injected `SwarmClient`.

### `SwarmClient`

The Swarm I/O seam the library depends on instead of a concrete `Bee`. No bee-js types cross it: references and keys are
hex strings, payloads are `Uint8Array`, and feed indexes are **decimal** strings. It carries identity (`owner`,
`publicKey`, `actPublisher`), plain and ACT-protected byte transfer, chunk access, sequential feed read/write,
`deriveSecret`, and a read-only `getStamp`. Stamp _management_ is deliberately out of scope — that belongs to the host
application.

`readFeed` reports "no update yet" as a **successful** return carrying the sentinel index
[`FEED_INDEX_NOT_FOUND`](#feed-index-constants) and a zero-address payload, rather than throwing. Callers branch on the
sentinel; retry helpers must test for it instead of catching.

The vocabulary the port speaks — hex aliases, option shapes, result shapes and the feed-index constants — is exported
from the package root and documented under [Port vocabulary](#port-vocabulary). Implement the interface against those
types to supply your own backend.

### `FileManagerConfig`

```ts
interface FileManagerConfig {
  uploadConcurrency?: number; // default 2  — concurrent file uploads within uploadFiles
  feedFetchConcurrency?: number; // default 10 — concurrent feed reads while listing/resolving
}
```

Both values are clamped to a minimum of `1`. `uploadConcurrency` bounds concurrent content uploads;
`feedFetchConcurrency` bounds concurrent feed/record reads during `listFolder`, `listTrash`, `downloadFolder` and
version resolution. There is deliberately no `downloadConcurrency`: content downloads return lazy streams, so bounding
their _initiation_ would not bound live consumption.

---

## Lifecycle & bootstrap

The state model has two feed levels: a per-identity **state feed** — its topic derived from the backend's key material
via `SwarmClient.deriveSecret`, so it is unguessable from the owner address alone — whose head points at the **admin
manifest** (the drive registry), and one **drive feed** per drive whose head points at that drive's mantaray. See
[README → How it works](README.md#how-it-works--a-filesystem-mirrored-onto-swarm).

### `initialize(requestOptions?): Promise<void>`

Rehydrates all existing state from Swarm: resolves the state feed, loads the admin manifest, and populates `driveList`.
File records are loaded lazily (via `listFolder` / `download` / `move`) as you navigate — there is no eager full-drive
load. Safe to call once per instance.

- **Emits**: `INITIALIZED`; `STATE_INVALID` if the resolved state cannot be parsed.

### `createAdminDrive(batchId, redundancyLevel?, reset?, requestOptions?): Promise<DriveInfo>`

**First-time setup only.** Seeds an empty admin manifest on the derived state feed, then registers the admin drive into
it. On later runs, `initialize()` alone restores everything.

- **batchId** `string | BatchId` — stamp backing the admin drive/state.
- **redundancyLevel?** — optional redundancy for the admin drive.
- **reset?** `boolean` — discard existing admin state and start over (wipes local state and appends a fresh empty
  manifest at the next free slot of the same state feed; the topic itself is stable). Required when admin state already
  exists.
- **Returns**: the newly-created admin `DriveInfo`.
- **Emits**: `DRIVE_CREATED`.
- **Throws**: `DriveError` (not initialized, or admin state already exists without `reset`); `SignerError`;
  `StampError`.

### `createDrive(batchId, name, redundancyLevel?, requestOptions?): Promise<DriveInfo>`

Creates a non-admin drive and registers it in the admin manifest. Requires admin state to exist already
(`createAdminDrive` first). Initialises an empty mantaray, ACT-encrypts its root, and publishes it as the first slot of
a freshly generated per-drive feed.

- **name** — display name; must be unique within the registry. The `batchId` need not be: a batch only pays for storage,
  and drive identity is `id`/`topic`, so several drives may share one. This is required under Swarm ID, which exposes a
  single usable batch per account.
- **Returns**: the newly-created `DriveInfo`.
- **Emits**: `DRIVE_CREATED`.
- **Throws**: `DriveError` (not initialized, admin state not ready, or duplicate name); `SignerError`; `StampError`.

---

## Drives

### `forgetDrive(driveId, requestOptions?): Promise<void>`

Removes the drive and all of its file metadata from local state and persists the updated drive list. **Does not** touch
the underlying Swarm batch (no dilution). Cannot target the admin drive.

- **Emits**: `DRIVE_FORGOTTEN`.
- **Throws**: `DriveError` (not initialized, not found, or admin drive); `SignerError`.

---

## Files — write

### `uploadFile(driveId, item, uploadOptions?, requestOptions?): Promise<FileRecord>`

Uploads a **new** file: mints a fresh feed topic and adds a new fork to the drive manifest. For re-versioning an
existing file use [`updateFile`](#updatefiledriveid-record-changes-uploadoptions-requestoptions-promisefilerecord); for
multi-file/folder uploads use
[`uploadFiles`](#uploadfilesdriveid-items-destinationpath-uploadoptions-requestoptions-promiseuploadfilesresult).

- **item** [`UploadItem`](#uploaditem) — new content (`sourcePath` on Node / `file` in browser) plus placement metadata
  (`path`). No `topic`.
- **uploadOptions?** `RedundantUploadOptions | FileUploadOptions`.
- **Returns**: the newly-created `FileRecord`.
- **Emits**: `FILE_UPLOADED`.
- **Throws**: `DriveError` (not initialized, drive not found, target folder path missing, or a node already occupies
  `item.path`); `FolderError` (the path is under the reserved `.trash` folder); `SignerError`; `FileError` (source is a
  directory, node source path missing, or content upload failed); `FileRecordError` (invalid `item.path`, or a folder
  along the path has no feed).

Names are fork keys, so they are unique within a folder: uploading onto an occupied name is rejected rather than
silently replacing it. Re-version with
[`updateFile`](#updatefiledriveid-record-changes-uploadoptions-requestoptions-promisefilerecord), relocate with
[`move`](#movefrompath-topath-sourcedriveid-requestoptions-promisevoid), or drop the existing node with
[`forget`](#forgetdriveid-path-requestoptions-promisevoid) first. `item.path` must have a non-empty leaf and no `.`/`..`
segments; it is validated before any content is uploaded.

### `uploadFiles(driveId, items, destinationPath?, uploadOptions?, requestOptions?): Promise<UploadFilesResult>`

Uploads multiple files, recreating their folder hierarchy as real folder nodes under `destinationPath`. Each file
becomes its own node with independent versioning and ACT (unlike a single opaque collection). Missing folders are
created as needed; each touched parent manifest is saved once at the end. **Partial-failure tolerant** — per-file errors
are collected, not thrown.

- **items** [`UploadItem[]`](#uploaditem) — each with a `path` relative to `destinationPath`.
- **destinationPath?** — absolute destination folder; defaults to the drive root.
- **Returns**: [`UploadFilesResult`](#uploadfilesresult) — `{ succeeded, failed }`.
- **Emits**: `FOLDER_CREATED` (per folder created), `FILE_UPLOADED` (per file), `FILES_UPLOADED` (once, batch summary).
  All of them fire **after** the last manifest is saved, so an emitted node is always in the drive tree — the batch is
  never announced in instalments, and a failed finalize emits nothing but `FILES_UPLOADED`'s absence. Upload events are
  therefore not a progress feed; use the returned `succeeded` / `failed` for outcomes.
- **Throws**: `FileRecordError` (no items, invalid item path, two items resolving to the same destination, or a
  malformed folder fork); `DriveError` (not initialized, drive not found, or a path segment is a file); `FolderError` (a
  destination is under the reserved `.trash` folder); `SignerError`. Per-file content-upload failures go into `failed`,
  as does an item whose destination name is already taken.

Existing folders along the way are reused; existing **files** are not overwritten (see `uploadFile` above).

**Abort semantics.** Aborting wins immediately: the batch stops starting files, no manifest is saved, and the call
rejects. The batch's own in-memory state is discarded with it — its records were never committed to `recordList` and
every manifest it mutated is evicted from the store — so the drive is left exactly as it was and nothing from the
aborted batch can be committed later by an unrelated save. A finalize failure is treated the same way. Content and
record feeds written before the abort are spent but unreferenced; re-upload those files to place them.

### `updateFile(driveId, record, changes, uploadOptions?, requestOptions?): Promise<FileRecord>`

Re-versions or changes metadata of an **existing** file. Reuses the file's feed topic, writes a new feed slot, and never
touches the drive manifest (no rename — use [`move`](#movefrompath-topath-sourcedriveid-requestoptions-promisevoid) to
relocate). Everything derives from `record`, including the ACT-history continuation reference.

- **record** — the existing file's `FileRecord` (the single source of truth).
- **changes** [`UpdateItem`](#updateitem) — `item` present ⇒ new bytes; absent ⇒ metadata-only. `customMetadata` is
  merged over the record's existing metadata.
- **Returns**: the newly-written `FileRecord` for the updated version.
- **Emits**: `FILE_UPDATED`.
- **Throws**: `FileRecordError` (neither new content nor `customMetadata` provided, the file is trashed, or the fork
  belongs to another node); `DriveError`; `FolderError` (no fork at the record's path); `SignerError`; `FileError`
  (content upload failed).

---

## Files — read

All download methods return a `ReadableStream<Uint8Array>` per file (Node and browser alike). Fetch failures are
**logged, not thrown**, unless noted.

### `downloadFile(record, options?, requestOptions?): Promise<DownloadResult>`

Downloads a single file the caller already holds as a `FileRecord`.

- **Returns**: a single [`DownloadResult`](#downloadresult).
- **Throws**: `DriveError` (not initialized); `SignerError`. Content-fetch failures are logged.

### `downloadFiles(fileRecords, options?, requestOptions?): Promise<DownloadFilesResult>`

Downloads files whose `FileRecord`s the caller already holds — no drive traversal or re-resolution. Fetches exactly the
passed records.

- **Returns**: one `DownloadFilesResult` marking per record success and failure.
- **Throws**: `DriveError` (not initialized); `SignerError`. Per-record failures are logged.

### `downloadFolder(driveId, path?, options?, requestOptions?): Promise<DownloadFilesResult[]>`

Downloads every file in a folder subtree, resolved fresh via `listFolder`. `path` omitted ⇒ the whole drive.

- **Returns**: one `DownloadFilesResult` marking per file success and failure in the subtree.
- **Throws**: `DriveError` (not initialized, drive not found, or folder path missing); `FolderError` (`path` is the
  reserved `.trash` folder); `SignerError`.

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
  reserved name, or the name is already taken); `SignerError`; `FileRecordError` (a folder feed is missing).

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
  reserved `.trash` folder, or `maxDepth` is not positive); `SignerError`.

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
  occupied, or either path under `.trash`); `SignerError`; `FileRecordError` (a folder feed or the source record is
  missing).

**No version bump.** A node's name is its fork label in the parent manifest, not part of the record payload, so a move
or rename rewrites no record and pins no new version — the file's version history is untouched either way. This is the
same rule `trash` and `recover` follow. It also means a moved file needs no feed read at all: relocation is a pure
manifest operation.

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
  is the drive root, or `.trash` itself — use `emptyTrash`); `SignerError`; `FileRecordError` (path not found, or a
  folder feed is missing).

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
- **Throws**: `DriveError` (not initialized); `SignerError`; `FileRecordError` (file feed not found).

### `restoreFileVersion(versionToRestore, requestOptions?): Promise<void>`

Restores a previous version as the new head of the file's feed. Per-file only — there is deliberately **no**
folder/drive-level restore.

- **Emits**: `FILE_VERSION_RESTORED`.
- **Throws**: `DriveError` (not initialized, or no fork at the file's current path); `SignerError`; `FileRecordError`
  (feed not found, restore version undefined, it is already the current head, or the fork at that path belongs to a
  different node).

---

## Trash

Trash is a **reserved `.trash` folder** at the drive root, not a metadata overlay. Trashing relocates a node's fork into
it — keyed by the node's own topic, so same-named nodes never collide — and stamps the path it came from onto the moved
fork. The node's feed, version and content are untouched, and a folder's subtree rides along unread, so any trash or
recover is two manifest writes regardless of depth.

Trashed nodes leave the active namespace completely: `listFolder` omits `.trash` from the drive root and refuses to
descend into it, `downloadFolder` skips trashed files, and `updateFile` / `uploadFile` / `createFolder` / `move` refuse
any path under `.trash`. The folder is created lazily on the first trash, so a drive that never trashes anything carries
no trash node at all.

### `trash(driveId, path, requestOptions?): Promise<void>`

Soft-deletes the file or folder at `path`. Bare and path-addressed — it dispatches on the resolved node type.

- **Emits**: `FILE_TRASHED` or `FOLDER_TRASHED`, with `{ driveId, path, trashedPath }` (plus `record` for a file).
- **Throws**: `DriveError` (not initialized, drive not found, or a folder along the path missing); `FolderError` (path
  is the drive root, already under `.trash`, or the node itself not found); `SignerError`; `FileRecordError` (fork
  missing node metadata).

### `recover(driveId, trashedPath, toPath?, requestOptions?): Promise<string>`

Restores a trashed node to `toPath`, or to the location stamped on it when `toPath` is omitted. Restores **location
only** — content and version are whatever they were.

The stamped origin can go stale: if that folder has since been forgotten, moved or trashed, resolution fails and the
caller passes an explicit `toPath`. An occupied destination is refused, never overwritten.

- **Returns**: the path the node was restored to.
- **Emits**: `FILE_RECOVERED` or `FOLDER_RECOVERED`.
- **Throws**: `DriveError` (destination occupied, or the destination's parent no longer exists); `FolderError`
  (destination under `.trash`); `SignerError`; `FileRecordError` (`trashedPath` is not `.trash/<topic>`, invalid
  destination path, not in the trash, or no stamped origin and no `toPath`).

### `listTrash(driveId, depth?, maxDepth?, requestOptions?): Promise<ListFolderResult>`

Walks `.trash` with the same machinery as `listFolder`, so `depth` controls the cost: `Shallow` (default) returns the
trashed roots only, `Deep` descends into trashed folders. Returns `[]` for a drive with no trash node.

Entries carry `status = trashed`, `path` = their real location under `.trash`, and `trashedFrom` = where they came from.

- **maxDepth?** — max BFS levels when `Deep`; must be positive, unlimited if omitted.
- **Returns**: the trashed nodes; pass a `path` back to `recover`.
- **Throws**: `DriveError` (not initialized or drive not found); `FolderError` (`maxDepth` is not positive);
  `SignerError`.

### `emptyTrash(driveId, requestOptions?): Promise<number>`

De-references every trashed node in one manifest write. Like `forget`, the content stays on Swarm until its stamp
expires — this drops references, it does not delete data.

- **Returns**: how many nodes were de-referenced.
- **Emits**: `TRASH_EMPTIED`.
- **Throws**: `DriveError` (not initialized or drive not found); `SignerError`.

---

## Getters

| Getter                               | Description                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| `adminStamp: StampInfo \| undefined` | Admin postage batch used for drive-management operations.          |
| `driveList: readonly DriveInfo[]`    | In-memory list of all known drives.                                |
| `recordList: readonly FileRecord[]`  | In-memory cache of file records, populated lazily as you navigate. |
| `emitter: EventEmitter`              | Emitter carrying `FileManagerEvents`.                              |
| `isInitialized: boolean`             | Whether `initialize()` has completed.                              |

Both list getters are `readonly` — treat them as snapshots and mutate state only through the methods above.

---

## Events

Emitted on the provided `EventEmitter` as `FileManagerEvents`:

| Event                   | Fired by                                           | Payload                                              |
| ----------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `INITIALIZED`           | `initialize` (success or failure)                  | `boolean`                                            |
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

`INITIALIZED`, `STATE_INVALID` and `DRIVE_UNRESOLVED` are emitted **during** `initialize`, so a listener attached
afterwards misses them. Pass your own emitter to the constructor to observe them.

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
}
interface SwarmDownloadOptions {
  redundancyStrategy?: SwarmRedundancyStrategy;
  fallback?: boolean;
}
```

These are the only options that reach a backend. `BeeClient` honours all of them. `SnahaClient` drops `redundancyLevel`,
`redundancyStrategy` and `signal` — see its class doc for the full list of gaps and why each one is absorbed rather than
emulated.

#### References and results

```ts
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
  owner: string;
  redundancyLevel: RedundancyLevel;
  actPublisher: string;
  version?: string;
  status?: NodeStatus;
}
```

### `FileRecord`

A file leaf. Its `content` is the ACT-wrapped content reference; version history lives in the file's feed (`topic`).

```ts
interface FileRecord extends NodeResource {
  type: NodeType.File;
  // Derived, not persisted — stripped before writing and rehydrated by the manifest walk.
  // A record belongs to whichever drive's manifest references it.
  driveId?: string;
  status?: NodeStatus;
  path: string; // absolute path within the drive
  name: string; // bare filename — the one identity field of the three that IS persisted
  content: ActReferences; // { reference, historyRef }
  timestamp?: number;
  customMetadata?: Record<string, string>;
  trashedFrom?: string;
}
```

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
  manifestRef?: ActReferences;
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
  actPublisher?: string;
  version?: string;
  head?: ActReferences;
  rawMetadata: Record<string, string>;
}
```

---

## Manifest metadata keys

Each manifest fork carries a metadata map that mirrors inode metadata. Keys are stable string constants:

| Constant                                | Key                         | On    | Purpose                        |
| --------------------------------------- | --------------------------- | ----- | ------------------------------ |
| `MANIFEST_METADATA_NODE_TOPIC`          | `swarm-node-topic`          | all   | The node's own topic           |
| `MANIFEST_METADATA_NODE_TYPE`           | `swarm-node-type`           | all   | `file` / `folder` / `drive`    |
| `MANIFEST_METADATA_NODE_OWNER`          | `swarm-node-owner`          | all   | Owner address                  |
| `MANIFEST_METADATA_NODE_ACT_PUBLISHER`  | `swarm-node-act-publisher`  | all   | ACT publisher for unwrapping   |
| `MANIFEST_METADATA_NODE_VERSION`        | `swarm-node-version`        | all   | Version / feed index           |
| `MANIFEST_METADATA_REDUNDANCY_LEVEL`    | `swarm-redundancy-level`    | all   | Redundancy strategy            |
| `MANIFEST_METADATA_DRIVE_ID`            | `swarm-drive-id`            | drive | Drive identifier               |
| `MANIFEST_METADATA_DRIVE_NAME`          | `swarm-drive-name`          | drive | Drive display name             |
| `MANIFEST_METADATA_DRIVE_OWNER`         | `swarm-drive-owner`         | drive | Drive owner                    |
| `MANIFEST_METADATA_DRIVE_IS_ADMIN`      | `swarm-drive-is-admin`      | drive | Admin-drive flag               |
| `MANIFEST_METADATA_DRIVE_BATCH_ID`      | `swarm-drive-batch-id`      | drive | Backing postage batch          |
| `MANIFEST_METADATA_DRIVE_ACT_PUBLISHER` | `swarm-drive-act-publisher` | drive | Drive-level ACT publisher      |
| `MANIFEST_METADATA_TRASHED_FROM`        | `swarm-trashed-from`        | trash | Path the node was trashed from |

---

## Errors

All errors extend `FileManagerError` (which sets an explicit `.name` and supports an ES2022 `cause`), so consumers can
catch broadly (`instanceof FileManagerError`) or branch on `error.name`.

| Error             | Meaning                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `DriveError`      | Drive creation, lookup, or destruction problems (incl. not-initialized).        |
| `FolderError`     | Folder-operation failures — invalid names/paths, collisions, reserved `.trash`. |
| `FileError`       | Content/IO failures — reading, uploading, or downloading file bytes.            |
| `FileRecordError` | Record / feed / metadata failures (missing feed, invalid version, etc.).        |
| `StampError`      | Postage stamp missing or not usable.                                            |
| `SignerError`     | Signer / publisher unavailable.                                                 |
| `BeeVersionError` | Connected Bee node version is unsupported.                                      |

---

## Node vs Browser

The only surface difference is the upload/update byte source:

- **Node** — `{ path: 'in/drive.txt', sourcePath: '/on/disk.txt' }`
- **Browser** — `{ path: 'in/drive.txt', file: someFile }`

Downloads return `ReadableStream<Uint8Array>` per file in both environments. Redundancy and request options are passed
identically; in the browser they are applied as request headers by bee-js.
