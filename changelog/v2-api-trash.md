# v2/api-trash — trash lifecycle verbs

Grows the trash lifecycle onto `FileManagerBase`. No lying stubs; the class still does not `implements FileManager` (the
`// TODO` stays — the interface rewrite and the `implements` flip land in the following `v2/api-interface` PR). No
earlier-PR method was modified.

## Added — public methods

- **`trashFile(record, requestOptions?)`** / **`recoverFile(record, requestOptions?)`** — soft-delete / restore a file
  by toggling its topic in the drive's trash overlay. Emit `FILE_TRASHED` / `FILE_RECOVERED`.
- **`trashFolder(folder, requestOptions?)`** / **`recoverFolder(folder, requestOptions?)`** — same for a folder,
  recording only the folder's own topic (no subtree propagation — a single overlay entry regardless of depth). Emit
  `FOLDER_TRASHED` / `FOLDER_RECOVERED`.
- **`listTrash(driveId, requestOptions?)`** — hydrates the overlay entries into full `NodeEntry` objects with
  `status = Trashed`, reading straight from the overlay with no tree walk (cost is proportional to the number of trashed
  roots, not drive size).

## Owner-private trash overlay model

Trash state is **not** a per-node feed write. It lives entirely in the owner-private admin metadata as
`DriveInfo.trashedNodes: TrashEntry[]`, keyed by node topic:

- **Topic-keyed overlay** — trash / recover add or remove a `TrashEntry` for the node's topic; nothing on the node's own
  feed or content changes.
- **Status is derived, never persisted** — `MantarayStore.saveRecord` strips `status` from the record before persisting,
  so it never reaches Swarm. A node's status is computed on demand by `getRecordStatus(drive, topic)`, which returns
  `Trashed` iff the topic is in `drive.trashedNodes`, else `Active`. The status field is populated only on the in-memory
  `fileInfoList` / returned objects.

## Cold-load status derivation — verified

Traced the fresh-load path (`initialize` → `initDriveList`): each drive's overlay is carried in its admin manifest fork
metadata (`swarm-drive-trashed-nodes`, written by `driveForkMetadata`) and reconstructed on load via
`assertDriveInfoFromMetadata` → `parseTrashedNodes`. Records are then hydrated lazily (`listFolder` → `loadRecord`) and
their status is set from `getRecordStatus` against that overlay. A record whose topic is present in the loaded overlay
therefore comes back with `Trashed` status, with no per-node status field ever having been persisted — the derivation
invariant holds.

## Overlay helpers — shared with api-folder

- **`setTrashState(driveId, entry, isTrashed, requestOptions?)`** — introduced here: guards double-trash /
  double-recover, persists the admin drive fork, and updates the in-memory overlay.
- **`persistAdminDriveFork`** and **`pruneTrashOverlay`** were already introduced in `v2/api-folder` (its `move` /
  `forget` mutate the same overlay) and are reused as-is here — shared ownership across the two PRs is deliberate.

## Gate

- `pnpm run lint` and `build` clean
