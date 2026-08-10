# v2/api-drive — drive-teardown verb

Grows a drive-lifecycle method onto the minimal `FileManagerBase` from `v2/api-core`. Copied from the final v2
`fileManager.ts`; no lying stubs, and the class still does not resolve `implement FileManager` (the
`// TODO: restore implements FileManager` stays until the final PR).

## Added — public methods

- **`forgetDrive(driveId, requestOptions?)`** — metadata-only removal: drops the drive fork from the admin manifest and
  clears local caches, leaving the underlying stamp/content untouched. Refuses the admin drive. Emits `DRIVE_FORGOTTEN`.

`DRIVE_FORGOTTEN` already exists in `FileManagerEvents` (added in `v2/types`). Postage-batch lifecycle (creation,
dilution, top-up) is deliberately out of scope for this library — stamp management belongs to the client; this library
only validates stamps. There is no drive-teardown verb that touches the underlying batch.

## Added — private helpers (arrive with their first consumer)

- **`findDriveOrThrow(driveId)`** — resolves a drive id to `{ driveIx, cachedDrive }` from `driveList` or throws
  `DriveError`. First used here by `forgetDrive`.
- **`pruneDriveMetadata(driveInfo, driveIndex, stateTopic, publisher, requestOptions?)`** — the teardown step for
  `forgetDrive`: removes the drive's fork from the admin mantaray, re-saves the admin manifest, splices the drive out of
  `driveList`, evicts its store entry, and drops its records from `fileInfoList`.

Both helpers reference only machinery already present in api-core (`store`, `adminHost`, `driveList`, `fileInfoList`,
`getDriveForkPath`, `DriveError`).

## Ownership note — no trash-overlay coupling

`pruneDriveMetadata` does **not** touch the owner-private trash overlay. The drive-teardown path and the trash path are
independent, so `v2/api-trash` does not share any helper introduced here; it will bring its own overlay helpers when it
lands.

## Imports

No new imports beyond what api-core already carries. No api-core method was modified.

## Gate

- `pnpm run lint clean` clean.
