# File Manager Library — API Reference

Technical API reference for **@solarpunkltd/file-manager-lib**. See [README.md](README.md) for installation, the
architecture overview and a quick start. See [tests/TESTS.md](tests/TESTS.md) for test coverage and usage patterns.

All methods live on `FileManagerBase`, which implements the `FileManager` interface. Every method that accepts a drive
takes either a `string` id or a bee-js `Identifier`. `requestOptions?: BeeRequestOptions` is available on every network
method for cancellation (`signal`) and retries; it is omitted from the descriptions below for brevity.

---

## Contents

- [Class & construction](#class--construction)
- [Lifecycle & bootstrap](#lifecycle--bootstrap) — `initialize`, `createAdminDrive`, `createDrive`
- [Drives](#drives) — `forgetDrive`
- [Files — write](#files--write) — `uploadFile`, `uploadFiles`, `updateFile`
- [Files — read](#files--read) — `downloadFile`, `downloadFiles`, `downloadFolder`
- [Folders](#folders) — `createFolder`, `listFolder`, `move`, `forget`
- [Versioning](#versioning) — `getFileVersion`, `restoreFileVersion`
- [Trash](#trash) — `trash`, `recover`, `listTrash`, `emptyTrash`
- [Getters](#getters) — `adminStamp`, `driveList`, `recordList`, `emitter`, `isInitialized`
- [Events](#events)
- [Types](#types)
- [Manifest metadata keys](#manifest-metadata-keys)
- [Errors](#errors)

---

## Class & construction

### `FileManagerBase`

```ts
constructor(bee: Bee, emitter?: EventEmitter, config?: FileManagerConfig)
```

- **bee** — a connected `Bee` from `@ethersphere/bee-js`, constructed **with a signer**. Throws `SignerError` otherwise.
- **emitter** _(optional)_ — an `EventEmitter` to receive `FileManagerEvents`; a default in-memory emitter is created if
  omitted.
- **config** _(optional)_ — concurrency tuning, see [`FileManagerConfig`](#filemanagerconfig).

Wraps the Bee client and owns the on-Swarm drive/folder/file tree, ACT wrapping, per-file version feeds, the
trash relocation, and event emission.

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

The state model has two feed levels: a per-signer **state feed** whose head points at the **admin manifest** (the drive
registry), and one **drive feed** per drive whose head points at that drive's mantaray. See
[README → How it works](README.md#how-it-works--a-filesystem-mirrored-onto-swarm).

### `initialize(requestOptions?): Promise<void>`

Rehydrates all existing state from Swarm: resolves the state feed, loads the admin manifest, and populates `driveList`.
File records are loaded lazily (via `listFolder` / `download` / `move`) as you navigate — there is no eager full-drive
load. Safe to call once per instance.

- **Emits**: `INITIALIZED`; `STATE_INVALID` if the resolved state cannot be parsed.

### `createAdminDrive(batchId, redundancyLevel?, reset?, requestOptions?): Promise<DriveInfo>`

**First-time setup only.** Establishes the state feed and its empty admin manifest, then registers the admin drive into
it. On later runs, `initialize()` alone restores everything.

- **batchId** `string | BatchId` — stamp backing the admin drive/state.
- **redundancyLevel?** — optional redundancy for the admin drive.
- **reset?** `boolean` — overwrite existing admin state with a freshly generated one (wipes local state and appends a
  new state pointer). Required when admin state already exists.
- **Returns**: the newly-created admin `DriveInfo`.
- **Emits**: `DRIVE_CREATED`.
- **Throws**: `DriveError` (not initialized, or admin state already exists without `reset`); `SignerError`;
  `StampError`.

### `createDrive(batchId, name, redundancyLevel?, requestOptions?): Promise<DriveInfo>`

Creates a non-admin drive and registers it in the admin manifest. Requires admin state to exist already
(`createAdminDrive` first). Initialises an empty mantaray, ACT-encrypts its root, and publishes it as the first slot of
a freshly generated per-drive feed.

- **name** — display name; must be unique within the registry.
- **Returns**: the newly-created `DriveInfo`.
- **Emits**: `DRIVE_CREATED`.
- **Throws**: `DriveError` (not initialized, admin state not ready, or duplicate name/`batchId`); `SignerError`;
  `StampError`.

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
  `item.path`); `SignerError`; `FileError` (source is a directory, node source path missing, or content upload failed);
  `FileRecordError` (invalid `item.path`, or a folder along the path has no feed).

Names are fork keys, so they are unique within a folder: uploading onto an occupied name is rejected rather than
silently replacing it. Re-version with [`updateFile`](#updatefiledriveid-record-changes-uploadoptions-requestoptions-promisefilerecord),
relocate with [`move`](#movefrompath-topath-sourcedriveid-targetdriveid-requestoptions-promisevoid), or drop the
existing node with [`forget`](#forgetdriveid-path-requestoptions-promisevoid) first. `item.path` must have a non-empty
leaf and no `.`/`..` segments; it is validated before any content is uploaded.

### `uploadFiles(driveId, items, destinationPath?, uploadOptions?, requestOptions?): Promise<UploadFilesResult>`

Uploads multiple files, recreating their folder hierarchy as real folder nodes under `destinationPath`. Each file
becomes its own node with independent versioning and ACT (unlike a single opaque collection). Missing folders are
created as needed; each touched parent manifest is saved once at the end. **Partial-failure tolerant** — per-file errors
are collected, not thrown.

- **items** [`UploadItem[]`](#uploaditem) — each with a `path` relative to `destinationPath`.
- **destinationPath?** — absolute destination folder; defaults to the drive root.
- **Returns**: [`UploadFilesResult`](#uploadfilesresult) — `{ succeeded, failed }`.
- **Emits**: `FOLDER_CREATED` (per folder created), `FILE_UPLOADED` (per file), `FILES_UPLOADED` (once, batch summary).
- **Throws**: `FileRecordError` (no items, invalid item path, two items resolving to the same destination, or a malformed
  folder fork); `DriveError` (not initialized, drive not found, or a path segment is a file); `SignerError`. Per-file
  content-upload failures go into `failed`, as does an item whose destination name is already taken.

Existing folders along the way are reused; existing **files** are not overwritten (see `uploadFile` above).

**Abort semantics.** Aborting wins immediately: the batch stops starting files, no manifest is saved, and the call
rejects. The batch's own in-memory state is discarded with it — the records it persisted are removed from `recordList`
and every manifest it mutated is evicted from the store — so the drive is left exactly as it was and nothing from the
aborted batch can be committed later by an unrelated save. Content and record feeds written before the abort are spent
but unreferenced; re-upload those files to place them.

### `updateFile(driveId, record, changes, uploadOptions?, requestOptions?): Promise<FileRecord>`

Re-versions or changes metadata of an **existing** file. Reuses the file's feed topic, writes a new feed slot, and never
touches the drive manifest (no rename — use
[`move`](#movefrompath-topath-sourcedriveid-targetdriveid-requestoptions-promisevoid) to relocate). Everything derives
from `record`, including the ACT-history continuation reference.

- **record** — the existing file's `FileRecord` (the single source of truth).
- **changes** [`UpdateItem`](#updateitem) — `item` present ⇒ new bytes; absent ⇒ metadata-only. `customMetadata` is
  merged over the record's existing metadata.
- **Returns**: the newly-written `FileRecord` for the updated version.
- **Emits**: `FILE_UPDATED`.
- **Throws**: `FileRecordError` (neither new content nor `customMetadata` provided); `DriveError`; `SignerError`;
  `FileError` (content upload failed).

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
- **Throws**: `DriveError` (not initialized, drive not found, or folder path missing); `SignerError`; `FileRecordError`
  (a folder feed is missing). Per-file failures are logged.

---

## Folders

### `createFolder(driveId, parentPath, folderName, redundancyLevel?, requestOptions?): Promise<FolderInfo>`

Creates a new empty folder (a nested mantaray) within a drive.

- **parentPath** — absolute path of the parent, or `'/'` for the drive root.
- **folderName** — must not contain `/`, and must not already be taken by a file or folder in the parent.
- **redundancyLevel?** — inherits from parent or drive if omitted.
- **Returns**: the new `FolderInfo`.
- **Emits**: `FOLDER_CREATED`.
- **Throws**: `DriveError` (not initialized, drive not found, invalid name, parent path missing, or the name is already
  taken); `SignerError`; `FileRecordError` (a folder feed is missing).

`mkdir` semantics, not upsert: a duplicate name is rejected before a feed is minted for it. `uploadFiles` differs
deliberately — it reuses an existing folder on the way to a file rather than failing.

### `listFolder(driveId, path, depth?, maxDepth?, requestOptions?): Promise<NodeEntry[]>`

Lists entries in a folder (or drive root) from the drive manifest, hydrating and caching any file entries into
`recordList`. The reserved `.trash` folder is omitted from the drive root and cannot be listed here — use `listTrash`.

- **path** — absolute folder path, or `'/'` for the drive root.
- **depth?** [`ListDepth`](#enums) — `Shallow` (one level, default) or `Deep` (full BFS).
- **maxDepth?** — max BFS levels when `Deep`; unlimited if omitted.
- **Returns**: [`NodeEntry[]`](#nodeentry) (`FileRecord | FolderInfo`) for every node at or below `path`.
- **Throws**: `DriveError` (not initialized, drive not found, or a path segment missing); `SignerError`;
  `FileRecordError` (a folder feed is missing).

### `move(fromPath, toPath, sourceDriveId, targetDriveId?, requestOptions?): Promise<void>`

Moves a file or folder from one path to another, within a drive or across drives. Path-addressed and dispatches on node
type, so it works for both files and folders.

- **targetDriveId?** — for cross-drive moves; defaults to `sourceDriveId`.
- **Emits**: `FILE_MOVED`.
- **Throws**: `DriveError` (not initialized, source/target drive not found, source is root, invalid destination, source
  == destination, or a path missing); `SignerError`; `FileRecordError` (a folder feed or the source record is missing).

### `forget(driveId, path, requestOptions?): Promise<void>`

**Hard-delete** a file or folder at `path` from the drive manifest and in-memory state. For folders, all descendant
`FileRecord`s are also purged from `recordList`. The underlying Swarm data persists (content-addressed), but the node is
removed from the tree.

- **Emits**: `FILE_FORGOTTEN` (file) or `FOLDER_FORGOTTEN` (folder).
- **Throws**: `DriveError` (not initialized, drive not found, path is the drive root, or path missing); `SignerError`;
  `FileRecordError` (a folder feed is missing).

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
- **Throws**: `DriveError` (not initialized, drive not found, path is the drive root or under `.trash`, or path not
  found); `SignerError`; `FileRecordError` (fork missing node metadata).

### `recover(driveId, trashedPath, toPath?, requestOptions?): Promise<string>`

Restores a trashed node to `toPath`, or to the location stamped on it when `toPath` is omitted. Restores **location
only** — content and version are whatever they were.

The stamped origin can go stale: if that folder has since been forgotten, moved or trashed, resolution fails and the
caller passes an explicit `toPath`. An occupied destination is refused, never overwritten.

- **Returns**: the path the node was restored to.
- **Emits**: `FILE_RECOVERED` or `FOLDER_RECOVERED`.
- **Throws**: `DriveError` (`trashedPath` is not `.trash/<topic>`, destination invalid/occupied, or the destination's
  parent no longer exists); `SignerError`; `FileRecordError` (not in the trash, or no stamped origin and no `toPath`).

### `listTrash(driveId, depth?, maxDepth?, requestOptions?): Promise<NodeEntry[]>`

Walks `.trash` with the same machinery as `listFolder`, so `depth` controls the cost: `Shallow` (default) returns the
trashed roots only, `Deep` descends into trashed folders. Returns `[]` for a drive with no trash node.

Entries carry `status = trashed`, `path` = their real location under `.trash`, and `trashedFrom` = where they came from.

- **Returns**: the trashed nodes; pass a `path` back to `recover`.
- **Throws**: `DriveError` (not initialized or drive not found); `SignerError`.

### `emptyTrash(driveId, requestOptions?): Promise<number>`

De-references every trashed node in one manifest write. Like `forget`, the content stays on Swarm until its stamp
expires — this drops references, it does not delete data.

- **Returns**: how many nodes were de-referenced.
- **Emits**: `TRASH_EMPTIED`.
- **Throws**: `DriveError` (not initialized or drive not found); `SignerError`.

---

## Getters

| Getter                                  | Description                                                        |
| --------------------------------------- | ------------------------------------------------------------------ |
| `adminStamp: PostageBatch \| undefined` | Admin postage batch used for drive-management operations.          |
| `driveList: readonly DriveInfo[]`       | In-memory list of all known drives.                                |
| `recordList: readonly FileRecord[]`     | In-memory cache of file records, populated lazily as you navigate. |
| `emitter: EventEmitter`                 | Emitter carrying `FileManagerEvents`.                              |
| `isInitialized: boolean`                | Whether `initialize()` has completed.                              |

Both list getters are `readonly` — treat them as snapshots and mutate state only through the methods above.

---

## Events

Emitted on the provided `EventEmitter` as `FileManagerEvents`:

| Event                   | Fired by                                           |
| ----------------------- | -------------------------------------------------- |
| `INITIALIZED`           | `initialize` (success)                             |
| `STATE_INVALID`         | `initialize` (unparseable state)                   |
| `DRIVE_CREATED`         | `createAdminDrive`, `createDrive`                  |
| `DRIVE_FORGOTTEN`       | `forgetDrive`                                      |
| `FILE_UPLOADED`         | `uploadFile`, `uploadFiles` (per file)             |
| `FILES_UPLOADED`        | `uploadFiles` (once, batch summary)                |
| `FILE_UPDATED`          | `updateFile`                                       |
| `FILE_DOWNLOADED`       | download path                                      |
| `FILE_MOVED`            | `move`                                             |
| `FILE_TRASHED`          | `trash` (file)                                     |
| `FILE_RECOVERED`        | `recover` (file)                                   |
| `FILE_FORGOTTEN`        | `forget` (file)                                    |
| `FILE_VERSION_RESTORED` | `restoreFileVersion`                               |
| `FOLDER_CREATED`        | `createFolder`, `uploadFiles` (per folder created) |
| `FOLDER_TRASHED`        | `trash` (folder)                                   |
| `FOLDER_RECOVERED`      | `recover` (folder)                                 |
| `FOLDER_FORGOTTEN`      | `forget` (folder)                                  |
| `TRASH_EMPTIED`         | `emptyTrash`                                       |

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
  // Not persisted: stripped before persist and hydrated. A record belongs to whichever drive's manifest references it
  driveId?: string;
  path: string;
  content: ActReferences; // { reference, historyRef }
  timestamp?: number;
  shared?: boolean;
  customMetadata?: Record<string, string>;
  granteeListRef?: string;
}
```

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

| Constant                                | Key                         | On    | Purpose                                   |
| --------------------------------------- | --------------------------- | ----- | ----------------------------------------- |
| `MANIFEST_METADATA_NODE_TOPIC`          | `swarm-node-topic`          | all   | The node's own topic                      |
| `MANIFEST_METADATA_NODE_TYPE`           | `swarm-node-type`           | all   | `file` / `folder` / `drive`               |
| `MANIFEST_METADATA_FILE_TOPIC`          | `swarm-file-topic`          | file  | Feed topic for the file's version history |
| `MANIFEST_METADATA_NODE_OWNER`          | `swarm-node-owner`          | all   | Owner address                             |
| `MANIFEST_METADATA_NODE_ACT_PUBLISHER`  | `swarm-node-act-publisher`  | all   | ACT publisher for unwrapping              |
| `MANIFEST_METADATA_NODE_VERSION`        | `swarm-node-version`        | all   | Version / feed index                      |
| `MANIFEST_METADATA_REDUNDANCY_LEVEL`    | `swarm-redundancy-level`    | all   | Redundancy strategy                       |
| `MANIFEST_METADATA_DRIVE_ID`            | `swarm-drive-id`            | drive | Drive identifier                          |
| `MANIFEST_METADATA_DRIVE_NAME`          | `swarm-drive-name`          | drive | Drive display name                        |
| `MANIFEST_METADATA_DRIVE_OWNER`         | `swarm-drive-owner`         | drive | Drive owner                               |
| `MANIFEST_METADATA_DRIVE_IS_ADMIN`      | `swarm-drive-is-admin`      | drive | Admin-drive flag                          |
| `MANIFEST_METADATA_DRIVE_BATCH_ID`      | `swarm-drive-batch-id`      | drive | Backing postage batch                     |
| `MANIFEST_METADATA_DRIVE_ACT_PUBLISHER` | `swarm-drive-act-publisher` | drive | Drive-level ACT publisher                 |
| `MANIFEST_METADATA_TRASHED_FROM`        | `swarm-trashed-from`        | trash | Path the node was trashed from            |

---

## Errors

All errors extend `FileManagerError` (which sets an explicit `.name` and supports an ES2022 `cause`), so consumers can
catch broadly (`instanceof FileManagerError`) or branch on `error.name`.

| Error             | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `DriveError`      | Drive creation, lookup, or destruction problems (incl. not-initialized). |
| `FolderError`     | Folder-operation failures.                                               |
| `FileError`       | Content/IO failures — reading, uploading, or downloading file bytes.     |
| `FileRecordError` | Record / feed / metadata failures (missing feed, invalid version, etc.). |
| `StampError`      | Postage stamp missing or not usable.                                     |
| `SignerError`     | Signer / publisher unavailable.                                          |
| `BeeVersionError` | Connected Bee node version is unsupported.                               |

---

## Node vs Browser

The only surface difference is the upload/update byte source:

- **Node** — `{ path: 'in/drive.txt', sourcePath: '/on/disk.txt' }`
- **Browser** — `{ path: 'in/drive.txt', file: someFile }`

Downloads return `ReadableStream<Uint8Array>` per file in both environments. Redundancy and request options are passed
identically; in the browser they are applied as request headers by bee-js.
