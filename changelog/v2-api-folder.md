# v2/api-folder — folder-structure verbs

Grows the folder verbs onto `FileManagerBase`. No lying stubs; the class still does not `implements FileManager` (the
`// TODO` stays until the final PR). No earlier-PR method was modified — only imports were added. This is the first PR
where both file and folder handling are present, which is why the path-addressed `move` / `forget` verbs land here.

## Added — public methods

- **`createFolder(driveId, parentPath, folderName, redundancyLevel?, requestOptions?)`** — creates a folder node under a
  parent and saves the parent manifest. Emits `FOLDER_CREATED`.
- **`listFolder(driveId, path, depth?, maxDepth?, requestOptions?)`** — bounded-concurrency BFS over a subtree: expands
  each manifest node, hydrates file records (caching into `fileInfoList`), and resolves child folder feeds into the next
  frontier. `Shallow` lists one level; `Deep` descends to `maxDepth`. Trashed folders are surfaced but not descended
  into. Returns `NodeEntry[]`.
- **`downloadFolder(driveId, path, options?, requestOptions?)`** — deferred here from the file-read set because it needs
  the folder walk: hydrates the subtree via `listFolder`, filters `fileInfoList` by path prefix, and streams the leaves
  through `downloadFiles`. `path` `/` fetches the whole drive.
- **`move(fromPath, toPath, sourceDriveId, targetDriveId?, requestOptions?)`** — moves a file or folder within a drive
  or across drives (root move is rejected). Emits `FILE_MOVED`.
- **`forget(driveId, path, requestOptions?)`** — removes a file or folder fork from its parent manifest and clears the
  corresponding in-memory state (root forget is rejected). Emits `FILE_FORGOTTEN` / `FOLDER_FORGOTTEN`.

## Bare NodeType dispatch — `move` / `forget`

Both verbs are path-addressed and branch on the fork's `swarm-node-type` metadata rather than taking a typed handle:

- **`forget`**: on a **folder** fork it evicts the folder's cached manifest and drops every `fileInfoList` entry under
  the path prefix; on a **file** fork it removes the single cached record. Both branches then prune the drive's trash
  overlay of the affected entries.
- **`move`**: on a **file** fork it re-resolves the record, rewrites its path (and `driveId` when cross-drive),
  publishes a new version slot, and re-stamps the fork's version metadata; on a **folder** fork it re-parents the
  sub-mantaray and rewrites the in-memory paths (and trash-overlay paths) of every descendant. Same-parent moves mutate
  one manifest; cross-parent / cross-drive moves save both source and target manifests.

Both dispatch branches now resolve entirely against methods and helpers present on this chain.

## Shared folder-walk helper reused

`downloadFolder` reuses `listFolder` for its subtree walk rather than duplicating the traversal, and both build on
engine's `getAllNodeEntries` (manifest fork listing) plus `MantarayStore.resolveHost` / `getMantarayNode`.
`createFolder` and the batch-upload path both build folder nodes through the shared `createFolderNode` helper.

## Trash-overlay helpers — cross-PR ownership

`move` and `forget` mutate the owner-private trash overlay, so two overlay helpers are introduced here by first-use:

- **`persistAdminDriveFork(driveIx, requestOptions?)`** — rewrites a drive's fork on the admin manifest so the updated
  `trashedNodes` overlay is persisted. Used directly by `move` (path rewrites of trashed descendants) and transitively
  by `pruneTrashOverlay`.
- **`pruneTrashOverlay(driveIx, predicate, requestOptions?)`** — drops overlay entries matching a predicate and persists
  via `persistAdminDriveFork`. Used by `forget` to clear overlay entries for a forgotten node/subtree.

`v2/api-trash` also depends on both of these for its trash / recover flow — ownership landing in this PR by first-use is
a deliberate decision, not an accident. No other trash logic (trashing, recovering, listing) is implemented here; only
what `move` / `forget` strictly need.

## No folder- or drive-level version restore

Version restore exists only per-file, via the file feed slots. There is deliberately no folder- or drive-level restore,
and none was added.

## Gate

- `pnpm run lint` and `build` clean
