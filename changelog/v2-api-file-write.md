# v2/api-file-write — file-write verbs

Grows the three file-write methods onto `FileManagerBase`, copied from the final v2 `fileManager.ts`. No lying stubs;
the class still does not resolve `implements FileManager` (the `// TODO` stays until the final PR). No api-core /
api-drive method was modified — only imports were added.

## Added — public methods

- **`uploadFile(driveId, item, uploadOptions?, requestOptions?)`** — uploads a single file: resolves the parent folder
  for redundancy inheritance, uploads content one-hop via transport `processUpload`, persists the file record to its own
  feed, then adds/saves the file fork on the parent manifest. Emits `FILE_UPLOADED`.
- **`uploadFiles(driveId, items, destinationPath, uploadOptions?, requestOptions?)`** — batch upload under a destination
  path. Plans the file/folder tree, auto-creates any missing intermediate folders, uploads files with bounded
  concurrency (`MAX_CONCURRENT_UPLOADS`), then does a single batched manifest save per dirty host. Returns
  `{ succeeded, failed }`; emits `FOLDER_CREATED`, `FILE_UPLOADED`, and `FILES_UPLOADED`.
- **`updateFile(driveId, record, changes, uploadOptions?, requestOptions?)`** — writes a new version of an existing
  record. Loads the current head, optionally re-uploads content (chaining the ACT history), merges `customMetadata`,
  persists the new version, and bumps the fork's version in the parent manifest. Emits `FILE_UPDATED`.

## Core shared helpers consumed — introduced here, not in api-core

The merge plan slotted `loadRecord` / `persistRecord` / `syncForkVersion` into api-core, but api-core removed them as
unused (growing-class: no dead code). This PR is their first consumer, so they land here:

- **`persistRecord(fr, ...)`** — saves a record via the store and upserts it into `fileInfoList`. Used by all three
  verbs.
- **`loadRecord(topic, owner, actPublisher, version?, ...)`** — returns the cached record or fetches+caches the current
  head (`{ record, fromCache }`). Used by `updateFile`.
- **`syncForkVersion(drive, driveIx, absolutePath, newVersion, publisher, ...)`** — rewrites the file fork's
  `swarm-node-version` metadata in the parent manifest and re-saves it. Used by `updateFile`.

## Shared helper with api-folder — `createFolderNode`

`uploadFiles` auto-creates missing intermediate folders via
**`createFolderNode(driveInfo, parentHost, parentPath, folderName, publisher, redundancyLevel?, ...)`** — builds a
folder mantaray node, seeds its feed, and adds the folder fork to the parent (returns `{ folder, node }`). This PR is
its first consumer, so it is introduced here. `v2/api-folder`'s public `createFolder` will also depend on it — ownership
lands in this PR by first-use, which is a deliberate call-out, not an accident.

## One-hop upload path via transport

Content upload is not re-implemented here. Both verbs call transport's `processUpload` (from `./upload`), which
dispatches to the node/browser one-hop `/bytes` upload and returns `{ contentRefs, rLevel }`. Source validation uses
transport's `assertUploadableSource` (synchronous on this chain — the copy-source's `await` was dropped).

## Gate

- `pnpm run lint clean` clean.
