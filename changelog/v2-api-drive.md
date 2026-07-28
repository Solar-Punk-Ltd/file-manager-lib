# v2/api-drive — drive-teardown verbs

Grows two drive-lifecycle methods onto the minimal `FileManagerBase` from `v2/api-core`. Both are copied from the final
v2 `fileManager.ts`; no lying stubs, and the class still does not `implements FileManager` (the
`// TODO: restore implements FileManager` stays until the final PR).

## Added — public methods

- **`destroyDrive(driveId, requestOptions?)`** — permanently tears a non-admin drive down. Refuses the admin drive and
  the admin stamp, re-fetches and validates the drive's own stamp, then dilutes that batch (`diluteBatch` to
  `depth + floor(log2(ttlDays))`) before pruning the drive from the admin manifest and caches. Emits `DRIVE_DESTROYED`.
- **`forgetDrive(driveId, requestOptions?)`** — metadata-only removal: drops the drive fork from the admin manifest and
  clears local caches, leaving the underlying stamp/content untouched. Refuses the admin drive. Emits `DRIVE_FORGOTTEN`.

Both events (`DRIVE_DESTROYED`, `DRIVE_FORGOTTEN`) already exist in `FileManagerEvents` (added in `v2/types`).

## Added — private helpers (arrive with their first consumer)

- **`findDriveOrThrow(driveId)`** — resolves a drive id to `{ driveIx, cachedDrive }` from `driveList` or throws
  `DriveError`. First used here by both verbs.
- **`pruneDriveMetadata(driveInfo, driveIndex, stateTopic, publisher, requestOptions?)`** — the shared teardown step for
  both verbs: removes the drive's fork from the admin mantaray, re-saves the admin manifest, splices the drive out of
  `driveList`, evicts its store entry, and drops its records from `fileInfoList`.

Both helpers reference only machinery already present in api-core (`store`, `adminHost`, `driveList`, `fileInfoList`,
`getDriveForkPath`, `DriveError`).

## Ownership note — no trash-overlay coupling

`pruneDriveMetadata` does **not** touch the owner-private trash overlay. The drive-teardown path and the trash path are
independent, so `v2/api-trash` does not share any helper introduced here; it will bring its own overlay helpers when it
lands.

## Imports

Only `StampError` was added to the `./utils/errors` import (used by `destroyDrive` for the missing-stamp and
stamp-mismatch guards). No api-core method was modified.

## Gate

- `pnpm run lint clean` clean.
