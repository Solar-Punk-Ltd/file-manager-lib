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

### `initialize(): Promise<void>`

- Reads node addresses (publisher public key for ACT).
- Tries to load existing admin state (drive list + drive list topic) from Swarm.
- If found: syncs `driveList` and `fileInfoList`.
- If not found: leaves `driveList`/`fileInfoList` empty — call `createDrive(batchId, name, true)` to bootstrap a new
  admin drive.
- Never throws: on failure it logs and emits `INITIALIZED` with `false`.

**Events**: `INITIALIZED` (`true`/`false`), `STATE_INVALID` (`true`) if admin state exists but is unreadable/invalid.

### `driveList: DriveInfo[]`

- In-memory list of all known drives (populated by `initialize()`/`createDrive()`).

### `fileInfoList: FileInfo[]`

- In-memory list of all known file infos across drives.

### `adminStamp: PostageBatch | undefined`

- The postage batch backing the admin drive, or `undefined` if not set/found.

---

## Drives

### `createDrive(batchId, name, isAdmin, redundancyLevel?, resetState?, requestOptions?): Promise<void>`

- **batchId**: Bee postage stamp id.
- **name**: display name of the drive (ignored for the admin drive — normalized to `"admin"`).
- **isAdmin**: `true` to create/bootstrap the admin drive (must be unique).
- **redundancyLevel?**: optional redundancy strategy (default `RedundancyLevel.OFF`).
- **resetState?**: if `true` (admin drive only), wipes the existing admin state/drive list feed and starts a fresh
  one — used to recover from an invalid/expired admin stamp.
- **requestOptions?**: optional Bee request options.

Creates a new drive, persists the updated drive list to the admin feed. Requires `initialize()` to have run first.

**Throws**: `DriveError` (not initialized, admin drive already exists, duplicate name/batchId, resetting a non-admin
drive), `StampError` (non-admin drive's stamp not usable).
**Events**: `DRIVE_CREATED`.

### `destroyDrive(driveInfo, stamp): Promise<void>`

- Cannot destroy the admin drive.
- **stamp** must be the `PostageBatch` matching `driveInfo.batchId`.
- Dilutes the stamp (shortens its duration to somewhere between 24 and 47 hours), then removes the drive plus its
  file infos from local state and persists the updated drive list.

**Throws**: `StampError` (no admin stamp, stamp/drive mismatch), `DriveError` (target is the admin drive).
**Events**: `DRIVE_DESTROYED`.

### `forgetDrive(driveInfo): Promise<void>`

- Removes the drive and its file infos from local state and persists the updated drive list.
- Does **not** touch or dilute the underlying Swarm postage batch.

**Throws**: `DriveError` if the drive is the admin drive.
**Events**: `DRIVE_FORGOTTEN`.

---

## Files

### `upload(driveInfo, fileOptions, uploadOptions?, requestOptions?): Promise<void>`

- **driveInfo**: target drive (must already be in `driveList`).
- **fileOptions**: flat object — `{ name, topic?, version?, customMetadata?, file? }` plus either:
  - Node: `{ path: string, previewPath?: string }`
  - Browser: `{ files: File[] | FileList, preview?: File }`
  - `topic` targets an existing `FileInfo`'s feed to upload a new version onto instead of creating a new file. If
    `topic` is set, `uploadOptions.actHistoryAddress` must also be provided (and vice versa), or `FileInfoError` is
    thrown.
  - `file?: { reference, historyRef }` — skip re-uploading data and reuse an existing manifest reference (e.g. for a
    metadata-only update).
- **uploadOptions?**: `RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions` from bee-js.
- **requestOptions?**: Bee request options.

Uploads a file/directory, wraps it into a Mantaray manifest, and writes/updates the resulting `FileInfo` on its
feed. Does **not** return the `FileInfo` — read it from the `FILE_UPLOADED` event payload or `fm.fileInfoList`
afterwards.

**Throws**: `DriveError` (not initialized, drive not found), `FileInfoError` (topic/historyRef mismatch), `FileError`
(Node fs errors).
**Events**: `FILE_UPLOADED` (`{ fileInfo }`).

### `listFiles(fileInfo, paths?, options?, requestOptions?): Promise<Record<string, string>>`

- **fileInfo**: file entry whose manifest to list.
- **paths?**: optional subset of fork paths to return; omit to return every path in the manifest.
- **options?**: `DownloadOptions` — must include `actPublisher`/`actHistoryAddress` (usually
  `fileInfo.actPublisher`/`fileInfo.file.historyRef`) if the manifest reference is ACT-protected.
- **requestOptions?**: Bee request options.

Returns a `{ path → fork reference }` map collected from the Mantaray manifest.

### `download(fileInfo, paths?, options?, requestOptions?): Promise<Bytes[] | ReadableStream<Uint8Array>[]>`

- **fileInfo**: target file entry.
- **paths?**: optional subset of paths to download (passed through to `listFiles`).
- **options?**: ACT + redundancy `DownloadOptions`.
- **requestOptions?**: Bee request options.

Resolves `listFiles()` then downloads every resulting fork.

Returns:

- Node: `Bytes[]` (one entry per fork).
- Browser: `ReadableStream<Uint8Array>[]`.

**Events**: none.

---

## Versioning

### `getVersion(fileInfo, version?): Promise<FileInfo>`

- **fileInfo**: base file entry (`topic` + `owner` are used to locate the feed).
- **version?**: `string | FeedIndex` feed slot. If omitted, fetches the latest (head) version.

Returns the cached local head instantly if it already matches the requested version; otherwise fetches and
ACT-unwraps it from the feed.

**Throws**: `FileInfoError` if the feed/slot doesn't exist.

### `restoreVersion(versionToRestore, requestOptions?): Promise<void>`

- **versionToRestore**: a `FileInfo` previously returned by `getVersion()`.
- **requestOptions?**: Bee request options.

Writes a **new** head slot pointing back at `versionToRestore.file`. A no-op if `versionToRestore` is already the
current head.

**Throws**: `FileInfoError` (feed not found, or `version` missing on the input).
**Events**: `FILE_VERSION_RESTORED` (`{ restored }`) — not emitted on the head no-op.

---

## Delete / Recover

### `trashFile(fileInfo): Promise<void>`

- Marks the file `Trashed` by writing a new feed slot (bumps `version`, updates `timestamp`).

**Throws**: `FileInfoError` (unknown file, already trashed, missing version).
**Events**: `FILE_TRASHED` (`{ fileInfo }`).

### `recoverFile(fileInfo): Promise<void>`

- Marks a `Trashed` file `Active` by writing a new feed slot.

**Throws**: `FileInfoError` (unknown file, not currently trashed, missing version).
**Events**: `FILE_RECOVERED` (`{ fileInfo }`).

### `forgetFile(fileInfo): Promise<void>`

- Removes the file from the owner feed's drive entry and in-memory `fileInfoList`, then persists the drive list.
- Underlying Swarm data (manifest, feed history) is left untouched.

**Throws**: `FileInfoError` if the file/drive entry can't be found.
**Events**: `FILE_FORGOTTEN` (`{ fileInfo }`).

---

## Sharing (WIP)

`share`, `subscribeToSharedInbox`, and `unsubscribeFromSharedInbox` are currently **no-op stubs** — implemented in
the interface for a future release, but they do not perform any action yet.

### `share(fileInfo, targetOverlays[], recipients[], message?): Promise<void>`

No-op placeholder for updating the grantee list and notifying recipients over PSS.

### `getGrantees(fileInfo): Promise<GetGranteesResult>`

- Looks up the file's drive/feed entry for a stored encrypted grantee reference (`eGranteeRef`) and returns
  `bee.grantee.get(eGranteeRef)` (bee-js `GetGranteesResult`: current + historical grantee public keys).

**Throws**: `GranteeError` if the drive or the grantee reference can't be found.

### `subscribeToSharedInbox(topic, callback?): Promise<void>` / `unsubscribeFromSharedInbox(): void`

No-op placeholders for a future PSS-based shared inbox.

---

## Events

Events are emitted on the provided `EventEmitter` (`FileManagerEvents` enum, string values in parens):

- `INITIALIZED` (`'initialized'`) — payload: `boolean` (success)
- `STATE_INVALID` (`'state-invalid'`) — payload: `boolean`
- `DRIVE_CREATED` (`'drive-created'`) — payload: `{ driveInfo }`
- `DRIVE_DESTROYED` (`'drive-destroyed'`) — payload: `{ driveInfo }`
- `DRIVE_FORGOTTEN` (`'drive-forgotten'`) — payload: `{ driveInfo }`
- `FILE_UPLOADED` (`'file-uploaded'`) — payload: `{ fileInfo }`
- `FILE_TRASHED` (`'file-trashed'`) — payload: `{ fileInfo }`
- `FILE_RECOVERED` (`'file-recovered'`) — payload: `{ fileInfo }`
- `FILE_FORGOTTEN` (`'file-forgotten'`) — payload: `{ fileInfo }`
- `FILE_VERSION_RESTORED` (`'file-version-restored'`) — payload: `{ restored }`
- `SHARE_MESSAGE_SENT` (`'file-shared'`) — reserved for the sharing feature (WIP, not currently emitted)
- `FILE_DOWNLOADED` (`'file-downloaded'`) — reserved, not currently emitted (`download()` emits nothing today)

---

## Key Types

### `DriveInfo`

```ts
{
  id: string | Identifier
  batchId: string | BatchId
  owner: string | EthAddress
  name: string
  redundancyLevel: RedundancyLevel
  isAdmin: boolean
  infoFeedList?: { topic: string | Topic, eGranteeRef?: string | Reference }[]
}
```

### `FileInfo`

```ts
{
  batchId: string | BatchId
  owner: string | EthAddress
  topic: string | Topic
  name: string
  actPublisher: string | PublicKey
  file: { reference: string | Reference, historyRef: string | Reference }
  driveId: string
  timestamp?: number
  shared?: boolean
  preview?: { reference: string | Reference, historyRef: string | Reference }
  version?: string
  index?: FeedIndex
  redundancyLevel?: RedundancyLevel
  customMetadata?: Record<string, string>
  status?: FileStatus
}
```

### `FileInfoOptions`

A flat object — `{ name, topic?, version?, customMetadata?, file? }` (the same fields `upload()` copies onto the new
`FileInfo`, minus the ones it derives itself) plus one of:

- Node: `{ path: string, previewPath?: string }`
- Browser: `{ files: File[] | FileList, preview?: File, onUploadProgress?: (progress: UploadProgress) => void }`

`file?: { reference, historyRef }` lets you skip re-uploading data and point the new `FileInfo` at an existing
manifest reference instead (e.g. a metadata-only update).

### `FileStatus`

- `FileStatus.Active` (`"active"`) | `FileStatus.Trashed` (`"trashed"`)

### `UploadProgress`

- `{ total: number, processed: number }`

---

## Errors

- `SignerError` — `Bee` instance passed without a signer, or publisher not yet resolved.
- `BeeVersionError` — connected Bee node/API version is unsupported.
- `DriveError` — issues with drive creation, destruction, or lookup.
- `FileInfoError` — invalid, missing, or inconsistent `FileInfo`/feed state.
- `FileError` — Node filesystem errors while uploading (bad path, missing directory, etc.).
- `StampError` — postage stamp not found, unusable, or mismatched.
- `GranteeError` — failure looking up a file's grantee list.
- `SubscriptionError`, `SendShareMessageError` — reserved for the sharing feature (WIP, not currently thrown).

---

## Node vs Browser

- **Node**: pass `{ path, previewPath? }` to `upload()`; `download()` returns `Bytes[]`.
- **Browser**: pass `{ files, preview?, onUploadProgress? }` to `upload()`; `download()` returns
  `ReadableStream<Uint8Array>[]`.
- Environment is auto-detected (via `std-env`'s `isNode`) — no flag to set.

---

## Examples

### Upload & Download (Node)

```ts
const drive = fm.driveList[0];
await fm.upload(drive, { name: 'assets', path: './assets' });
const fi = fm.fileInfoList.find((f) => f.name === 'assets')!;
const list = await fm.listFiles(fi, undefined, { actHistoryAddress: fi.file.historyRef, actPublisher: fi.actPublisher });
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

### Drive removal

```ts
// hard delete: dilutes the postage stamp too
await fm.destroyDrive(driveInfo, stamp);

// soft delete: local metadata only, stamp is left untouched
await fm.forgetDrive(driveInfo);
```
