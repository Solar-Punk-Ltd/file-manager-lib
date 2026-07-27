# v2/transport — one-hop /bytes upload + readable-stream download

The content transport layer: standalone functions that move file bytes to and from Swarm. They are consumed by the
FileManager but never import it (no back-edge into the API class).

## Architecture decisions

### One-hop `/bytes` upload (replaces the collection / streamFile path)

Uploads now go through a single `bee.uploadData(batchId, data, { act: true, ... })` call per file — one hop to the
`/bytes` endpoint — instead of the previous mantaray-collection / `uploadFilesFromDirectory` approach. `processUpload`
(`src/upload/index.ts`) normalizes options (forcing `act: true`, resolving the effective redundancy level) and
dispatches by environment; it returns `{ contentRefs: ActReferences, rLevel: RedundancyLevel }` — the ACT reference pair
the caller writes into the node's feed. Directory/collection upload is intentionally dropped here; multi-file/folder
uploads are rebuilt as per-file nodes at the API layer (`uploadFiles`), so each file is its own ACT-wrapped `/bytes`
object with independent versioning.

### Bytes source is environment-specific: Readable (Node) vs File/Blob (browser)

- **Node** (`src/upload/upload.node.ts`): `readFile` streams the source path as a `ReadStream`
  (`src/utils/fs/fs.node.ts` — `FileData.data` narrowed to `ReadStream`), handed straight to `bee.uploadData`.
  Directories are rejected (`Cannot upload a directory - use uploadFiles`).
- **Browser** (`src/upload/upload.browser.ts`): the `File`/`Blob` from `BrowserUploadOptions.file` is passed straight to
  `bee.uploadData`.

Both return `ActReferences` (`{ reference, historyRef }`) built from the upload result's `reference` + `historyAddress`.
`assertUploadableSource` pre-validates the source per env.

### Readable-stream download for both environments (`src/download/index.ts`)

`processDownload` takes `DownloadResource[]` and fetches each via
`bee.downloadReadableData(reference, { actHistoryAddress, actPublisher, ... })`, returning `DownloadResult[]`
(`{ path, result: ReadableStream<Uint8Array> }`). One code path serves Node and browser — the env-specific
`download.node.ts` / `download.browser.ts` modules are removed. Downloads run concurrently through `settlePromises`;
per-resource failures are logged (not thrown) unless the request was aborted, and the abort signal is honored before and
after the batch.

### Transport resource types (`src/types/v2/download.ts`)

- `DownloadResource` — `{ path, reference, actHistoryAddress, actPublisher }`: everything needed to ACT-decrypt and
  fetch one object.
- `DownloadResult` — `{ path, result: ReadableStream<Uint8Array> }`.

## bee-js dependency

Transport relies on the widened bee-js content API:

- `bee.uploadData` accepting a Node `Readable`/`ReadStream` **and** a browser `File`/`Blob` (not just
  `string | Uint8Array`), with `{ act: true, actHistoryAddress?, redundancyLevel? }` options.
- `bee.downloadReadableData(reference, options, requestOptions)` returning a `ReadableStream<Uint8Array>`.
- The old `streamFiles` / directory-collection upload path is no longer used.

## Changed

- `src/upload/index.ts`, `src/upload/upload.node.ts`, `src/upload/upload.browser.ts` — rewritten to the one-hop model;
  import the v2 types from `src/types/v2/`.
- `src/download/index.ts` — rewritten to `downloadReadableData` + `DownloadResource`/`DownloadResult`.
- `src/download/download.node.ts`, `src/download/download.browser.ts` — removed.
- `src/utils/fs/fs.node.ts` — `FileData.data` narrowed to `ReadStream`.

## Consumer note (temporary bridge — cleaned up in v2/api-core)

The v2 transport signatures replace v1 in place, so the v1 `FileManager` call sites needed adapting to keep the build
green. These are **transitional bridges**, not the real cutover:

- `FileManagerBase.upload` (@467) — the v1 `DriveInfo` is cast to the v2 `DriveInfo`
  (`driveInfo as unknown as DriveInfoV2`) to satisfy `processUpload`; `fileOptions` is cast to `UploadSource` and
  `redundancyLevel` is passed explicitly. Only `batchId` is actually read from the drive by the transport, so the cast
  is safe enough for now.
- `FileManagerBase.download` (@425) — the `listFiles` path→ref map is mapped into `DownloadResource[]` (ACT fields taken
  from the file record), and the returned `DownloadResult[]` is unwrapped back to `ReadableStream[]` to keep the v1
  method's return type.

The surrounding v1 logic still uses v1 types; only the transport boundary is bridged. `v2/api-core` replaces these
methods with the real v2 model (`uploadFiles`, `downloadFile`/`downloadFolder`) and removes the casts.

## Gate

- `pnpm run lint` clean. UT and IT cases fail as of now. They will be fixed later.
