# v2/engine — MantarayStore, node/fork model, writeActFeed, engine utils

The engine layer: a stateful `MantarayStore` collaborator plus the manifest/feed utilities it builds on. `MantarayStore`
depends only on v2 types and utils — it is a leaf, with no reference to the `FileManager` class.

## Architecture decisions

### MantarayStore as the stateful collaborator (`src/mantarayStore.ts`)

`FileManager` delegates all path resolution and manifest/feed I/O to `MantarayStore`. The store owns three per-node
caches, keyed by feed topic:

- **`nodeManifestCache`** (`topic → MantarayNode`) — the loaded manifest tree for a drive/folder node, so repeated
  resolves within a request don't re-download and re-unmarshal it.
- **`nodeFeedIndexCache`** (`topic → bigint`) — the next feed index to write for a node's feed, primed from a probed
  `feedIndexNext`, so sequential writes don't re-probe the feed head.
- **`nodeRefCache`** (`topic → ActReferences`) — the latest ACT ref (reference + historyRef) written to a node's feed.
  Doubles as the ACT-history continuation pointer for the next write and as the manifest root for the next load.

Entry points: `resolveHost` (path → owning `ManifestHost`: a folder, or the drive root when the path is empty/root) and
`resolveHostMantaray` (the same, plus the loaded node — the common resolve→load→mutate path). Record I/O is `saveRecord`
/ `getRecord`; manifest I/O is `getMantarayNode` / `saveMantarayNode`. Cache-management accessors (`get/setNodeRef`,
`get/setManifestCache`, `setNodeFeedIndex`, `evict`, `clear`) let callers seed and invalidate state. `resolveFolder`
walks each path segment, requiring every intermediate fork to be a folder (`swarm-node-type === folder`) and probing
each folder feed for its current manifest ref.

### Drive / folder / file unified as mantaray nodes; fork target = child feed topic

Every node (drive root, folder, file) is a mantaray fork carrying a standard metadata map. A folder fork's target
resolves to that folder's own feed (its manifest history); a file fork's target resolves to the file's record feed.
Resolution is therefore uniform: read a fork's `swarm-node-topic`, probe that feed's head for the current ACT ref, load
the manifest (folder) or the record (file). This makes drive, folder, and file the same shape at different tree levels.

### writeActFeed — single ACT-wrap at the feed slot, manifest tree saved plainly

`writeActFeed` (`src/utils/v2/bee.ts`) is the one write path: ACT-encrypt the payload via `uploadData({ act: true })`,
capturing `{ reference, historyRef }` as `ActReferences`, then write those refs (not the content) into the node's feed
at the next index. `saveNodeManifest` (`src/utils/v2/mantaray.ts`) first `saveRecursively`s the mantaray tree
**plainly** (content- addressed, unencrypted) and then ACT-wraps only the resulting root reference through
`writeActFeed`. So a manifest carries exactly one ACT wrap — at its root feed slot — rather than per-node encryption.
`saveRecord` follows the same path for a file record's JSON.

### Fork-metadata keys (`src/utils/v2/mantaray.ts` builders + `src/utils/constants.ts` keys)

Three builders stamp the metadata map on each fork:

- `fileForkMetadata` — `swarm-file-topic`, `swarm-node-topic`, `swarm-node-type=file`, `swarm-node-owner`,
  `swarm-node-act-publisher`, and `swarm-node-version` (only when versioned).
- `folderForkMetadata` — `swarm-node-topic`, `swarm-node-type=folder`, `swarm-redundancy-level`, `swarm-node-owner`,
  `swarm-node-act-publisher`.
- `driveForkMetadata` — `swarm-node-topic`, `swarm-node-type=drive`, plus the drive-scoped keys
  (`swarm-drive-id/name/owner/is-admin/batch-id/act-publisher`), `swarm-redundancy-level`, and
  `swarm-drive-trashed-nodes` (JSON of the trash overlay).

`getAllNodeEntries` reads these back into `NodeHeader[]` for listing; `getDriveForkPath` derives a drive's fork path
from its id.

### getRecordStatus derives status from the owner-private trash overlay (`src/utils/v2/common.ts`)

A node's `NodeStatus` is not stored on the record — `getRecordStatus(drive, topic)` returns `Trashed` when the topic is
present in `drive.trashedNodes`, else `Active`. `saveRecord` strips `status` from the record before persisting, so trash
state lives only in the drive's owner-private overlay and never leaks into a shared record.

### Error model and observability (`src/utils/errors.ts`, `src/utils/logger.ts`)

`FileManagerError` is a base carrying an explicit `name` and native `cause`; every domain error (`BeeVersion`, `Stamp`,
`Drive`, `Folder`, `Signer`, `FileInfo`, `File`) extends it, and
`FolderError` is added. `ErrorHandler` (singleton) logs `name`/`message`/`stack` and walks the `cause` chain
(depth-guarded). `Logger` (singleton) provides leveled, timestamped output. The engine and the still-present v1 code
route through these: `console.*` → `logger.*`; `catch` sites either `errorHandler.handleError(err, context)`
(log-and-continue) or rethrow a typed error with the caught error attached as `cause`.

## Added (new files)

- `src/mantarayStore.ts` — `MantarayStore` (see above).
- `src/utils/v2/bee.ts` — `FeedTarget`, `writeActFeed`.
- `src/utils/v2/mantaray.ts` — `loadMantaray`, `getAllNodeEntries`, `saveNodeManifest` (+ `SavedManifest`),
  `fileForkMetadata`, `folderForkMetadata`, `driveForkMetadata`, `getDriveForkPath`.
- `src/utils/v2/common.ts` — `awaitAllPromisesBounded` (bounded-concurrency pool), `joinPath`, `getRecordStatus`.
- `src/utils/v2/path.ts` — `pathSegments`, `normalizePath`, `splitPath`, `assertValidRelativePath`.
- `src/utils/logger.ts` — `Logger` singleton.

## Changed (v1 — deduplicated / adopted early to shrink the api-core cutover)

- `src/utils/bee.ts` — now hosts the shared, in-use feed helpers: `getTopicAndVersion` (signature
  `(bee, address, currentVersion?, currentTopic?)`; returns the next feed slot — `currentVersion.next()` when a current
  version is given, otherwise a probed `feedIndexNext`), `verifyStampUsability` (moved here from `common.ts`) and
  `verifySupportedBeeVersions`. `fetchStamp` reports via `errorHandler`.
- `src/utils/common.ts` — `settlePromises` gains an indexed callback + optional `onError`; `verifyStampUsability`
  removed (now in `bee.ts`). `isNotFoundError` / `getEncodedSize` retained.
- `src/utils/errors.ts` — `FileManagerError` base + `cause`, `FolderError`, `ErrorHandler` (above).
- `src/utils/index.ts` — barrel now also exports `ErrorHandler`, `Logger`, `FileManagerError`, `FolderError`.
- `src/fileManager.ts`, `src/upload/*` — adopt `logger`/`errorHandler`; `FileManagerBase` now uses the shared
  `getTopicAndVersion` and `verifySupportedBeeVersions` utils (its private copies removed).

## Layout

`MantarayStore` and genuinely v2-only utilities live side-by-side under `src/mantarayStore.ts` and `src/utils/v2/` (with
the v2 asserts from `v2/types`). Functions shared by v1 and v2 that are already in use were **deduplicated into the v1
utils** (`bee.ts`, `common.ts`, `errors.ts`) rather than duplicated under `v2/`, so the `v2/api-core` cutover carries a
smaller changeset. `MantarayStore` imports `getFeedData` from `src/utils/bee.ts` and `writeActFeed` from
`src/utils/v2/bee.ts`.

## Gate

- `pnpm run lint` clean. All UT and IT cases pass.
