# v2/interface — finalize the v2 FileManager (merge, contract, public surface)

The closing PR of the v2 implementation series. It removes the last v1/v2 split, restores the `FileManager` contract
onto the class, and settles the public surface (list naming, immutability, a client config). After this PR the class is
complete and `FileManagerBase implements FileManager`.

## v1 removed — single flat module layout

The side-by-side `src/types/v2/` and `src/utils/v2/` trees are collapsed into the primary module tree, and the v1
implementation they shadowed is gone. v2 is now the one and only implementation:

- Type modules promoted to their final paths (`types/download.ts`, `types/upload.ts`, `types/info.ts`, `types/utils.ts`)
  and the `types/v2/` directory removed.
- Util modules promoted likewise (`utils/path.ts`, `utils/bee.ts`, `utils/common.ts`, `utils/mantaray.ts`,
  `utils/asserts.ts`) and the `utils/v2/` directory removed; the dead `utils/capacity.ts` dropped.
- All imports rewritten to the flat layout — no remaining `/v2/` path segments anywhere in `src`.

## FileManager contract restored

`src/types/fileManager.ts` is the v2 contract: `initialize`, drive verbs (`createAdminDrive`, `createDrive`,
`forgetDrive`), file write (`uploadFile`, `uploadFiles`, `updateFile`), file read (`downloadFile`, `downloadFiles`,
`downloadFolder`), versioning (`getFileVersion`, `restoreFileVersion`), folder structure (`createFolder`, `listFolder`,
`move`, `forget`), and trash (`trashFile`, `recoverFile`, `trashFolder`, `recoverFolder`, `listTrash`), plus the
read-only members. The interface carries no sharing/grantee surface.

`FileManagerBase implements FileManager` — the growing-class deferral is closed. Every interface member is implemented
with a matching signature. The class exposes no public verb absent from the contract.

## Public surface settled

- **`recordList` (was `fileInfoList`)** — renamed to match the `driveList` convention. It is a lazily-hydrated,
  navigation-driven cache of the files the caller has touched (via `listFolder` / downloads / uploads), not the
  authoritative full file set of a drive.
- **Immutable cache views** — `driveList` and `recordList` are exposed as `readonly` arrays through getters backed by
  private mutable fields (`_driveList`, `_recordList`). External callers can read but can no longer `push` / `splice`
  the internal caches out of sync with Swarm state; the class mutates the backing fields.
- **`FileManagerConfig`** — an optional third constructor argument (`new FileManagerBase(bee, emitter?, config?)`)
  letting clients set the concurrency ceilings:
  - `uploadConcurrency` — parallel file uploads in `uploadFiles` (default `MAX_CONCURRENT_UPLOADS` = 2).
  - `feedFetchConcurrency` — parallel feed fetches in `listFolder` / `listTrash` / drive load (default
    `MAX_CONCURRENT_FEED_FETCHES` = 10).

  Both default to the module constants when unset and are floored at 1. The resolved values feed every bounded fan-out
  (`awaitAllPromisesBounded`) in the class.

## Barrels

`src/types/index.ts` re-exports `FileManager` and `FileManagerConfig` alongside the v2 data types; the root barrel
exports `FileManagerBase`, the types, the utils, and the event emitter.

## Gate

- `pnpm run lint` and `build` clean
