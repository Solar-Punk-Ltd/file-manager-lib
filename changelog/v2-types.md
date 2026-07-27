# v2/types — v2 data model, enums, events, asserts

## Added

### Data model (`src/types/info.ts`)

- `NodeResource` — shared base for every Swarm-addressable node (batchId, topic, owner, redundancyLevel, actPublisher,
  optional version/status).
- `FileRecord` — replaces v1 `FileInfo`. `NodeResource` + `type: NodeType.File`, `driveId`, `path`,
  `content: ActReferences`, and optional `shared`/`granteeListRef`/`customMetadata`.
- `ManifestHost` — base for manifest-backed nodes (`manifestRef?: ActReferences`, `version: never`).
- `DriveInfo` (v2 shape) — `ManifestHost` + `type: NodeType.Drive`, `id`, `name`, `isAdmin`, `trashedNodes?`. **Drops v1
  `infoFeedList`.**
- `FolderInfo` — `ManifestHost` + `type: NodeType.Folder`, `path`, `driveId`.
- `NodeEntry` = `FileRecord | FolderInfo`.
- `NodeHeader` — decoded manifest-fork header: `path`, `type`, `topic`, optional
  `owner`/`actPublisher`/`version`/`head`, plus the raw metadata map.
- `TrashEntry` — trash-overlay pointer: `topic`, `type`, `path`, optional `version`.
- `ShareItem` (v2 shape) — now wraps `record: FileRecord` (was v1 `fileInfo: FileInfo`).

### Enums

- `NodeType` (`File | Folder | Drive`) and `ListDepth` (`Shallow | Deep`) — new.
- `NodeStatus` (`Active | Trashed`) — replaces v1 `FileStatus`.

### Upload / download resource types

- `src/types/upload.ts` (new): `BrowserUploadOptions` (v2), `NodeUploadOptions` (v2), `UploadSource`, `UploadItem`,
  `UpdateItem`, `UploadFilesResult`.
- `src/types/download.ts` (new): `DownloadResource`, `DownloadResult`.

### Utils types (`src/types/utils.ts`)

- `ActReferences` (`reference` + `historyRef`) — the v2 replacement for v1 `ReferenceWithHistory`.
- Retains the feed-result helpers (`FeedPayloadResult`, `FeedReferenceResult`, `FeedResultWithIndex`).

### Events (`src/utils/events.ts`)

- `FileManagerEvents` extended with `FILE_UPDATED`, `FILE_MOVED`, `FILES_UPLOADED`, `FOLDER_CREATED`,
  `FOLDER_FORGOTTEN`, `FOLDER_TRASHED`, `FOLDER_RECOVERED`. Superset of v1 — no member removed or renamed.

### Assert helpers (`src/utils/asserts.ts`)

- `assertActReferences`, `assertNodeResource`, `assertFileRecord`, `assertShareItem`, `assertDriveInfo`,
  `assertFolderInfo`, `assertDriveInfoFromMetadata`, `parseTrashedNodes`, `assertReady` — replace the v1
  `assertFileInfo` / `assertWrappedFileInfoFeed` / `assertWrappedUploadResult` / `assertStateTopicInfo` family.

### Constants (`src/utils/constants.ts`)

- Additive: `ROOT_PATH`, `DRIVE_FORK_PREFIX`, concurrency caps, and the `MANIFEST_METADATA_*` fork-metadata key set
  required by the v2 asserts.

## Not in this PR (later in the stack)

- `FileManager` service interface and any MantarayStore / API signatures (ride with `v2/api-core`).
- `ErrorHandler` / `Logger` and the engine utils (`mantaray`, `path`, `bee`) — `v2/engine`.

## Gate

- `pnpm run lint` clean. All UT and IT cases pass.

## Layout: v2 lands side-by-side with v1

The v2 data model reuses v1 identifiers (`DriveInfo`, `ShareItem`, `BrowserUploadOptions`, `NodeUploadOptions`) and
would replace `asserts.ts` wholesale, while v1 code (`src/fileManager.ts`, `src/utils/bee.ts`, `src/utils/capacity.ts`,
`src/upload/*`, `src/types/fileManager.ts`) still consumes the old shapes. To keep the build green and leave v1
untouched, the v2 layer lives side-by-side under `src/types/v2/` and `src/utils/v2/`. The `v2/api-core` PR performs the
v1→v2 cutover and lifts these files to the canonical paths.
