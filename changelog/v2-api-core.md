# v2/api-core — v1→v2 FileManager cutover (minimal core)

The cutover PR: `src/fileManager.ts` is replaced wholesale by a **minimal v2 `FileManagerBase`** that compiles
standalone. Later PRs grow real methods onto it — never lying stubs.

## The cutover

The v1 `FileManagerBase` (mantaray-collection uploads, `FileInfo`/`FileStatus`, `infoFeedList`, v1 upload/download
signatures) is gone. The new class is built on the v2 stack: `MantarayStore` (engine), the one-hop transport, and the v2
data model (`FileRecord`, v2 `DriveInfo`, `NodeType`, `ActReferences`). This resolves the additivity breakages flagged
in PRs 1–3 — nothing in `src` consumes v1 types/engine/transport through mismatched signatures anymore, and the
transitional transport bridges added in `v2/transport` are removed with the v1 methods they patched.

## Growing-class approach

Only the bootstrap + drive-creation surface lands here. The class intentionally does **not** resolve
`implement FileManager` yet (a subset can't satisfy the full interface): `// TODO: restore \`implements FileManager\`
when all methods land` — restored by the final PR.

**Present now:** constructor + fields, getters (`adminStamp`, `isInitialized`), `initialize`, `createAdminDrive`,
`createDrive`. Only methods with a working implementation land — no stubs.

**Arriving in later PRs:** `forgetDrive` (api-drive); `uploadFile`/`uploadFiles`/ `updateFile` (api-file-write);
`downloadFile`/`downloadFiles`/`downloadFolder`/`getFileVersion`/ `restoreFileVersion` (api-file-read);
`createFolder`/`listFolder`/`move`/`forget` (api-folder);
`trashFile`/`recoverFile`/`listTrash`/`trashFolder`/`recoverFolder` (api-trash).

## Two-feed bootstrap

`initialize` calls ONLY `verifySupportedBeeVersions` → `initPublisher` → `tryToFetchAdminState` → (if state exists)
`initDriveList` — no API method is invoked during init. The two feeds:

1. **State feed** (`FILEMANAGER_STATE_TOPIC`, per signer) — head slot holds the ACT reference pair (`ActReferences`)
   pointing to the admin manifest. `tryToFetchAdminState` reads it, decrypts the pointer, and sets `stateFeedTopic`.
   `establishAdminState` (via `createAdminDrive`) creates it.
2. **Admin manifest feed** (`stateFeedTopic`) — a mantaray whose forks are the drives. `initDriveList` loads it, reads
   drive forks via `getAllNodeEntries` + `assertDriveInfoFromMetadata`, and probes each drive feed for its current
   manifest ref.

`registerDrive` creates a drive's own manifest, adds a fork to the admin manifest, and persists — shared by both
`createAdminDrive` and `createDrive`.

## Store wiring

`MantarayStore` is constructed in the FileManager constructor and owns all manifest/feed caches.
`assertReady(publisher, isInitialized, stateFeedTopic)` gates the drive operations; `adminHost` builds the
`ManifestHost` for the admin manifest from the admin stamp + `stateFeedTopic`.

## Gate

- `pnpm run lint clean`. Remaining `tsc` errors are test-only (tests target the not-yet-present v2 methods / v1
  `FileInfo`, plus the bee-js update fallout), addressed by the test-migration PR.
