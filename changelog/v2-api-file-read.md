# v2/api-file-read — file read + version verbs

Grows the file-read and per-file version verbs onto `FileManagerBase`, copied from the final v2 `fileManager.ts`. No
lying stubs; the class still does not `implements FileManager` (the `// TODO` stays until the final PR). No earlier-PR
method was modified — only imports were added.

## Added — public methods

- **`downloadFile(fileRecord, options?, requestOptions?)`** — convenience wrapper: downloads a single caller-held record
  via `downloadFiles` and returns its one result.
- **`downloadFiles(fileRecords, options?, requestOptions?)`** — downloads exactly the passed records with no drive
  traversal or re-resolution (caller owns record currency). Maps each record to a `DownloadResource` and delegates to
  transport `processDownload`.
- **`getFileVersion(fr, version?, requestOptions?)`** — resolves a specific version from the file's own feed
  (short-circuits to the in-memory head when the cached version matches), returning the `FileRecord` for that slot.
  Read-only — no persistence.
- **`restoreFileVersion(versionToRestore, requestOptions?)`** — republishes an older version's content refs as a new
  head slot on the per-file feed, then bumps the fork version in the parent manifest. Refuses restoring the current head
  slot. Emits `FILE_VERSION_RESTORED`.

## Transport download path

Content download is not re-implemented here. `downloadFiles` builds `DownloadResource[]` (from `./types/v2/download`)
and calls transport's `processDownload` (from `./download`), which fans out over `bee.downloadReadableData` and returns
`DownloadResult[]`. `DownloadOptions` comes from bee-js.

## Core helpers reused (already present)

- `loadRecord` is **not** needed by these verbs — version reads go directly through `store.getRecord` / `getFeedData`,
  and the callers of the download verbs already hold their records.
- `persistRecord` and `syncForkVersion` (introduced in api-file-write) are reused by `restoreFileVersion` to publish the
  restored slot and update the fork version. `findDriveOrThrow` (api-drive) resolves the drive.

## Per-file restore only — no folder/drive-level restore

Per-file restore via the file feed slots is the only version-restore that exists. There is deliberately no folder- or
drive-level restore, and none was added.

## Gate

- `pnpm run lint` and `build` clean
