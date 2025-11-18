# File Manager Library — API Reference

This is the technical API reference for **@solarpunkltd/file-manager-lib**. See [README.md](README.md) for installation
and quick start. See [TESTS.md](tests/TESTS.md) for test coverage and usage patterns.

---

## Class

### `FileManagerBase`

```ts
constructor(bee: Bee, emitter?: EventEmitter)
```

- **bee**: a connected instance of `Bee` from `@ethersphere/bee-js`. Must be initialized with a signer.
- **emitter** _(optional)_: an `EventEmitter` to receive `FileManagerEvents`.

Wraps Bee client, manages drives, file infos, ACT unwrapping, versioning, and events.

---

## Lifecycle

### `initialize(batchId?: BatchId): Promise<void>`

- Reads node addresses.
- Loads the **admin drive** (if a batch labeled `admin` or the provided **batchId** exists).
- Syncs all drives and file infos.

**Throws**: `StampError` if the admin stamp provided is not found.

### `getDrives(): DriveInfo[]`

- Returns in-memory list of all known drives (excluding admin).

---

## Drives

### `createDrive(batchId, name, isAdmin, redundancyLevel?, requestOptions?): Promise<DriveInfo>`

- **batchId**: Bee postage stamp id.
- **name**: display name of the drive.
- **isAdmin**: `true` if this is the admin drive (must be unique).
- **redundancyLevel?**: optional redundancy strategy.
- **requestOptions?**: optional Bee request options.

Creates a new drive, persists it in admin drive list. **Events**: `DRIVE_CREATED`.

### `destroyDrive(driveInfo, stamp): Promise<void>`

- Cannot destroy admin drive.
- Removes from in-memory and admin drive list.
- Dilutes the **stamp** and shortens its duration (min. 24, max 47 hours)

**Events**: `DRIVE_DESTROYED`.

---

## Files

### `upload(driveInfo, infoOptions, uploadOptions?, requestOptions?): Promise<FileInfo>`

- **driveInfo**: target drive.
- **infoOptions**:
  - `info`: `{ name: string, topic?: Topic, file?: { reference, historyRef } }`
  - `path` (Node) or `files` (Browser)
  - Optional `previewPath` (Node) or `preview` (Browser)
- **uploadOptions?**: `{ redundancyLevel?: RedundancyLevel }`
- **requestOptions?**: Bee request options.

Uploads a file/directory:

- Wraps files into Mantaray manifest.
- Creates/updates a FileInfo in the owner feed.
- Returns latest `FileInfo`.

**Events**: `FILE_UPLOADED`.

### `listFiles(fileInfo, options?): Promise<Record<string,string>>`

- **fileInfo**: reference to a file entry.
- **options?**: must include `actPublisher` and `actHistoryAddress` if ACT protected.

Returns a dictionary `{ path → reference }` collected from mantaray manifest.

### `download(fileInfo, paths?, options?): Promise<Bytes[] | ReadableStream[]>`

- **fileInfo**: target file entry.
- **paths?**: optional subset of paths to download.
- **options?**: ACT + redundancy options.

Returns:

- Node: `Bytes[]` (array of file contents as Uint8Array).
- Browser: `ReadableStream[]` (array of streams).

**Events**: none.

---

## Versioning

### `getVersion(fileInfo, version?): Promise<FileInfo>`

- **fileInfo**: target file entry.
- **version?**: hex string index. If omitted, returns latest.

Fetches a specific version from feed history.

### `restoreVersion(fileInfo): Promise<FileInfo>`

- Writes a new head slot pointing back to an older `file.reference`.
- Useful for rolling back.

**Events**: `FILE_VERSION_RESTORED`.

---

## Delete / Recover

### `trashFile(fileInfo): Promise<FileInfo>`

- Marks file as `trashed` by writing a new feed slot.

**Events**: `FILE_TRASHED`.

### `recoverFile(fileInfo): Promise<FileInfo>`

- Marks file as `active` by writing a new feed slot.

**Events**: `FILE_RECOVERED`.

### `forgetFile(fileInfo): Promise<void>`

- Removes from owner feed list and in-memory store.
- Underlying Swarm data persists.

**Events**: `FILE_FORGOTTEN`.

---

## Sharing (WIP)

### `share(fileInfo, targetOverlays[], recipients[], message?): Promise<void>`

- **fileInfo**: the file to share.
- **targetOverlays[]**: swarm overlays to grant access.
- **recipients[]**: optional PSS recipients to notify.
- **message?**: optional string payload.

Updates grantee list and optionally sends PSS message.

**Events**: `SHARE_MESSAGE_SENT`.

### `getGrantees(fileInfo): Promise<string[]>`

- Returns list of overlays who can access.

### `subscribeToSharedInbox(topic, cb?): Promise<void>`

- Subscribes to incoming share messages on given PSS topic.

### `unsubscribeFromSharedInbox(): Promise<void>`

- Cancels subscription.

---

## Events

Events are emitted on the provided `EventEmitter`:

- `FILEMANAGER_INITIALIZED`
- `DRIVE_CREATED`
- `DRIVE_DESTROYED`
- `FILE_UPLOADED`
- `FILE_TRASHED`
- `FILE_RECOVERED`
- `FILE_FORGOTTEN`
- `FILE_VERSION_RESTORED`
- `SHARE_MESSAGE_SENT`

---

## Key Types

### `DriveInfo`

```ts
{
  id: string
  name: string
  batchId: BatchId
  owner: string
  redundancyLevel?: RedundancyLevel
  isAdmin: boolean
}
```

### `FileInfo`

```ts
{
  batchId: BatchId
  owner: string
  topic: Topic
  name: string
  actPublisher: PublicKey
  file: { reference: Reference, historyRef: Reference }
  driveId: string
  version?: string
  status: 'active' | 'trashed'
  customMetadata?: Record<string,string>
  redundancyLevel?: RedundancyLevel
}
```

### `FileInfoOptions`

- Node:
  ```ts
  { info: { name: string }, path: string, previewPath?: string }
  ```
- Browser:
  ```ts
  { info: { name: string }, files: FileList, preview?: File }
  ```

### `FileStatus`

- `"active"` | `"trashed"`

### `UploadProgress`

- `{ loaded: number, total?: number }`

---

## Errors

- `DriveError` — issues with drive creation or destruction.
- `FileInfoError` — invalid or missing FileInfo.
- `StampError` — postage stamp not found or invalid.
- `GranteeError` — failure in grantee list handling.
- `SubscriptionError` — failure in PSS inbox subscription.

---

## Node vs Browser

- **Node**: use `{ path }`, returns `Bytes[]`.
- **Browser**: use `{ files }`, returns `ReadableStream[]`.
- Redundancy/timeout options passed in browser as headers.

---

## Examples

### Upload & Download (Node)

```ts
const drive = fm.getDrives()[0];
const fi = await fm.upload(drive, { info: { name: 'assets' }, path: './assets' });
const list = await fm.listFiles(fi, { actHistoryAddress: fi.file.historyRef, actPublisher: fi.actPublisher });
const files = await fm.download(fi, ['logo.png'], {
  actHistoryAddress: fi.file.historyRef,
  actPublisher: fi.actPublisher,
});
```

### Versioning

```ts
const v0 = await fm.getVersion(fi, '0');
await fm.restoreVersion(v0);
```

### Soft Delete / Recover

```ts
await fm.trashFile(fi);
await fm.recoverFile(fi);
```

### Sharing (WIP)

```ts
await fm.share(fi, [targetOverlay], [recipientPublicKey], 'check this out');
```
