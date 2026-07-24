# v2/types — v2 data model, enums, events, asserts

**Stack:** PR 1 of the v2 stack. Base `feat/v2`, head `v2/types`.

> **Do NOT merge until the v2 stack review is complete.**

First PR in the stacked v2 series. Brings over the v2 **data-model layer only** from the
read-only source branch `feat/folder-and-version-handling`. No engine, transport, api, or
upload/download logic — types, enums, events, and assert helpers exclusively.

## Added

### Data model (`src/types/info.ts`)
- `NodeResource` — shared base for every Swarm-addressable node (batchId, topic, owner,
  redundancyLevel, actPublisher, optional version/status).
- `FileRecord` — replaces v1 `FileInfo`. `NodeResource` + `type: NodeType.File`, `driveId`,
  `path`, `content: ActReferences`, and optional `shared`/`granteeListRef`/`customMetadata`.
- `ManifestHost` — base for manifest-backed nodes (`manifestRef?: ActReferences`, `version: never`).
- `DriveInfo` (v2 shape) — `ManifestHost` + `type: NodeType.Drive`, `id`, `name`, `isAdmin`,
  `trashedNodes?`. **Drops v1 `infoFeedList`.**
- `FolderInfo` — `ManifestHost` + `type: NodeType.Folder`, `path`, `driveId`.
- `NodeEntry` = `FileRecord | FolderInfo`; `NodeHeader`; `TrashEntry`.
- `ShareItem` (v2 shape) — now wraps `record: FileRecord` (was v1 `fileInfo: FileInfo`).

### Enums
- `NodeType` (`File | Folder | Drive`), `NodeStatus` (`Active | Trashed`),
  `ListDepth` (`Shallow | Deep`) — replace v1 `FileStatus`.

### Upload / download resource types
- `src/types/upload.ts` (new): `BrowserUploadOptions` (v2), `NodeUploadOptions` (v2),
  `UploadSource`, `UploadItem`, `UpdateItem`, `UploadFilesResult`.
- `src/types/download.ts` (new): `DownloadResource`, `DownloadResult`.

### Utils types (`src/types/utils.ts`)
- `ActReferences` (`reference` + `historyRef`) — the v2 replacement for v1 `ReferenceWithHistory`.
- Retains the feed-result helpers (`FeedPayloadResult`, `FeedReferenceResult`, `FeedResultWithIndex`).

### Events (`src/utils/events.ts`)
- `FileManagerEvents` extended with `FILE_UPDATED`, `FILE_MOVED`, `FILES_UPLOADED`,
  `FOLDER_CREATED`, `FOLDER_FORGOTTEN`, `FOLDER_TRASHED`, `FOLDER_RECOVERED`.
  Superset of v1 — no member removed or renamed.

### Assert helpers (`src/utils/asserts.ts`)
- `assertActReferences`, `assertNodeResource`, `assertFileRecord`, `assertShareItem`,
  `assertDriveInfo`, `assertFolderInfo`, `assertDriveInfoFromMetadata`, `parseTrashedNodes`,
  `assertReady` — replace the v1 `assertFileInfo` / `assertWrappedFileInfoFeed` /
  `assertWrappedUploadResult` / `assertStateTopicInfo` family.

### Constants (`src/utils/constants.ts`)
- Additive: `ROOT_PATH`, `DRIVE_FORK_PREFIX`, concurrency caps, and the `MANIFEST_METADATA_*`
  fork-metadata key set required by the v2 asserts.

## Not in this PR (later in the stack)
- `FileManager` service interface and any MantarayStore / API signatures (ride with `v2/api-core`).
- `ErrorHandler` / `Logger` and the engine utils (`mantaray`, `path`, `bee`) — `v2/engine`.

## Gate
- `npx tsc --noEmit` clean, `npx eslint src` clean. Tests intentionally not run (owner runs them).

## ⚠ Additivity blocker (needs a decision before this can land green)
The plan assumes v2/types is purely additive ("v1 still present, nothing consumes v2 yet").
It is **not** drop-in: the v2 data model reuses v1 identifiers (`DriveInfo`, `ShareItem`,
`BrowserUploadOptions`, `NodeUploadOptions`) in the same files/barrel and replaces `asserts.ts`
wholesale, while still-present v1 code (`src/fileManager.ts`, `src/utils/bee.ts`,
`src/utils/capacity.ts`, `src/upload/*`, `src/types/fileManager.ts`) consumes the old shapes.
A verbatim copy makes `tsc` red across the v1 stack. Reconciliation approach TBD — see PR thread.
