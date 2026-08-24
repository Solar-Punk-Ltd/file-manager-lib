# TESTS — @solarpunkltd/file-manager-lib

This document explains how the test-suite for **@solarpunkltd/file-manager-lib** is organized and how to run, extend,
and troubleshoot it. It covers both **unit** and **integration** tests (including end‑to‑end workflows).

> For usage and API details, see:  
> • **README.md** — install, dev/mainnet setup, quick start  
> • **REFERENCE.md** — method-by-method technical reference

---

## At a glance

- **Jest** test runner (Node + JSDOM where needed)
- **Unit tests** mock Swarm internals and focus on _FileManagerBase_ behavior
- **Integration tests** exercise real Bee devnodes via `BeeDev` and verify ACT, feeds, manifests, versioning, and
  sharing workflows
- Tests run **serially** (`--runInBand`) to avoid shared Bee/port conflicts
- Coverage supported via `pnpm run test:coverage`

---

## Prerequisites

- **Node.js ≥ 24** (see `engines` in `package.json`)
- **Bee devnode** (for integration tests):  
  The jest setup ensures we have bee dev nodes running to support the bee-js methods invoked.

---

## Running tests

```bash
# All tests (unit + integration), verbose and serial
pnpm test

# Only one project
pnpm run test:ut   # unit
pnpm run test:it   # integration

# With coverage
pnpm run test:coverage
```

Jest options are configured via `jest.config.ts` (two projects: `unit` and `integration`). The project's
`package.json` exposes these scripts:

- **`pnpm test`** → `jest --config=jest.config.ts --runInBand --verbose --silent`
- **`pnpm run test:ut`** → `cross-env KEEP_BEE_DIRS=true pnpm run test --selectProjects=unit`
- **`pnpm run test:it`** → `cross-env KEEP_BEE_DIRS=true pnpm run test --selectProjects=integration`
- **`pnpm run test:keep`** → same as `pnpm test` but keeps Bee dev-node dirs around (`KEEP_BEE_DIRS=true`)
- **`pnpm run test:coverage`** → `jest --coverage`

---

## Directory layout

```
tests/
  ├─ utils.ts
  ├─ TESTS.md
  ├─ mockHelpers.ts
  ├─ unit/
  │   └─ fileManager.spec.ts
  ├─ integration/
  │   ├─ fileManager.spec.ts
  │   ├─ testSetupHelpers.ts
  │   └─ test-node-setup
  └─ fixtures/
```

Helper modules you will see in specs:

- **`createInitializedFileManager`** — builds a `FileManagerBase` with a properly configured Bee client and emitter.
- **`ensureOwnerStamp`** — ensures an admin/owner postage stamp exists for the test node, returning
  `{ bee, ownerStamp }`.
- **`utils.ts`** — constants, signer mocks, directory walkers, download/compare helpers, test batch parameters.
- **`mockHelpers.ts`** — spies/mocks for upload/download paths, mantaray, feed writers, etc.

---

## Integration tests — what they verify

Located primarily in `tests/integration/` and executed against a live **BeeDev** node.

### 1) Initialization

- Creates a new `FileManagerBase` and asserts default state (`fileInfoList`, `driveList` empty when no admin state
  exists yet).
- Emits **`INITIALIZED`** with `true`/`false`.
- When a non-owner node attempts to read the owner feed, proper **404/500** errors surface from `bee.data.download()`.
- Verifies supported Bee/Bee-API versions and that `getNodeAddresses()` returns a `publicKey` for ACT.
- Uploads a nested folder + a single file into a drive created with a live postage stamp, and verifies `listFiles()`
  relative paths.

### 2) Reinitialization

- Re-running `initialize()` while already initialized is a no-op (logs, re-emits `INITIALIZED`).
- Repeated reinitialization with a still-usable admin stamp **preserves** `driveList`/`fileInfoList` and the admin
  stamp reference.
- If the admin stamp becomes unusable/invalid, reinitialization emits `STATE_INVALID` and clears state; other,
  unrelated drives are unaffected.
- Operations (e.g. `createDrive`) succeed normally after a successful revalidation.

### 3) Drive handling

- `createDrive()` emits **`DRIVE_CREATED`** and persists a drive with expected attributes (`Identifier` length, owner
  address, batch id, redundancy level, etc.).
- Destroying the admin drive/stamp throws.
- `forgetDrive()` removes a non-admin drive, prunes its file infos, persists the drive list, and emits
  **`DRIVE_FORGOTTEN`**; throws for the admin drive or an unknown drive.

> Note: Full destruction/dilution flows are difficult in devnode; a placeholder test is provided (commented) for a
> production Bee that supports the relevant API.

### 4) `listFiles()` behavior

- Uploads folders with various structures and checks that `listFiles()` returns accurate **relative paths** and **fork
  references**.
- Validates behavior for an **empty folder** (throws on upload / returns empty list).
- Deeply nested paths are preserved (e.g. `level1/level2/level3/d.txt`).
- Entries with **empty paths** are **ignored**.

### 5) `upload()` flows

- Uploading a directory produces a `FileInfo` entry; **re-uploads** using same topic increment the **feed index**
  without creating duplicate entries.
- **Metadata-only updates** do not cause re-uploads of the same manifest (file refs remain identical).
- `previewPath` is supported (if the implementation stores the preview reference, the test asserts presence; otherwise
  logs a warning).
- Validates the invariant: `topic` and `actHistoryAddress` must be provided **together**, else `FileInfoError` is
  thrown.

### 6) Download

- Downloads **all** files from a manifest and compares contents.
- Downloads **specific forks** by path selection.
- Handles **empty manifests** by returning an empty array.

### 7) File lifecycle

- **Trash** (soft-delete) flips status to `Trashed` and bumps version; subsequent re-initialization observes persisted
  status.
- **Recover** from `Trashed` to `Active` and bump version.
- **Forget** (hard-delete) removes the `FileInfo` from local lists and persists the drive list.
- Guards against **duplicate topics/entries** when trashing/restoring multiple times.

### 8) Version control

- `getVersion()` rejects invalid indices (negative or out-of-range).
- Sequential uploads result in proper **slot indices** (`FeedIndex` 0,1,2…).
- `getVersion() + download()` returns correct **subset** of bytes when a path list is supplied.
- Returns **cached** head `FileInfo` without re-fetching when the requested version equals head.
- **Restore** an old version creates a **new head** that points at the historical reference.
- Restoring the current head is a no‑op.

### 9) Grantees / Sharing metadata

- `getGrantees()` throws a friendly error when the file's topic is not found in the drive list (missing grantee list).

### 10) E2E workflow

- Full user path: create drive → upload single file → upload project folder → re-upload folder "in place" (not
  supported, so original manifest remains) → upload a new **version** folder → list & download from that new version
  manifest.
- Validates path preservation, version semantics, and ACT download parameters (`actHistoryAddress`, `actPublisher`).

### 11) AbortController

- `upload()`, `download()`, and `listFiles()` all accept `requestOptions.signal`.
- A pre-aborted signal fails fast with a "Request aborted"-style error.
- Aborting mid-flight surfaces a `BeeResponseError` (or equivalent) instead of hanging.
- Independent `AbortController`s used across concurrent calls don't interfere with each other.
- Calls proceed normally when the signal is never aborted.

---

## Unit tests — what they verify

Located in `tests/unit/` and focused on behavior of `FileManagerBase` **without** hitting the network.

Key strategies:

- Replace `getFeedData`, `getWrappedData`, `fetchStamp`, `generateRandomBytes` with jest mocks; `@/utils/mantaray` is
  fully auto-mocked (`loadMantaray` returns a fixture `MantarayNode`, `getForksMap`'s real implementation is restored
  per-`describe` block where needed).
- Spy on the shared bee-js v13 namespace prototypes (`bee.data`, `bee.feed`, `bee.stamp`, `bee.status`,
  `bee.connectivity`, ...) via `mockHelpers.ts` — bee-js v13 doesn't export those namespace classes directly, so their
  prototypes are obtained from a throwaway `Bee` instance instead (see `StatusPrototype`, `DataPrototype`, etc. in
  `tests/mockHelpers.ts`).

### Constructor & initialization

- Creating `FileManagerBase` without a signer fails with `SignerError`.
- Proper init emits `INITIALIZED` once; subsequent calls log "already initialized" / "being initialized".

### Reinitialization

- Covers the same admin-stamp revalidation matrix as the integration suite (state preserved on valid stamp, cleared +
  `STATE_INVALID` on invalid stamp, `INITIALIZED` flag tracked correctly across sequential reinitializations).

### Download + listFiles

- Asserts mantaray **`collectAndMap()`** is called.
- For a selected path (e.g. `/root/2.txt`) only the **correct fork** reference is downloaded.
- When collecting all forks, each ref is passed to `bee.data.download()` and the returned `Bytes` array is propagated.
- `listFiles()` returns a **path → reference** map (`{'/root/2.txt': '…'}`).

### Upload

- Chooses the right **upload path** depending on inputs (`path`, `previewPath`).
- Throws when `topic` and `historyRef`/`actHistoryAddress` are not supplied together.
- Ensures **no duplicate entries** are added when re‑uploading the same topic; instead only the `version` is
  incremented.

### Version control

- `getVersion()` orchestrates `getFeedData` + `fetchFileInfo` and returns a `FileInfo` for indexed or head fetch.
- Chaining `getVersion()` and `download()` forwards ACT options and returns byte arrays.
- Missing feeds throw a helpful "File info not found for topic" message.
- Restoring the current head **does not emit** a `FILE_VERSION_RESTORED` event; restoring an older version does.

### Drive handling

- Creating an **admin drive** normalizes the name to the admin label and sets flags accordingly.
- Creating a normal drive persists id/batch/owner metadata.
- Creating a drive with duplicate **name** or **batchId** throws `DriveError`.
- Destroying a drive calls `bee.stamp.dilute(batchId, depth + halvings)`.
- Attempting to destroy the admin drive/stamp throws `DriveError`.
- `forgetDrive()` removes a user drive, prunes its files, persists, and emits `DRIVE_FORGOTTEN`; throws for an
  unknown drive.

### File operations

- **Trash** emits `FILE_TRASHED`, bumps `timestamp`, and persists the new `FileInfo` slot.
- **Recover** emits `FILE_RECOVERED` with a later `timestamp`.
- **Forget** removes the file from lists, saves owner feed, and emits `FILE_FORGOTTEN`.

### getGranteesOfFile

- `getGrantees()` throws `GranteeError` when the file's topic isn't found in the drive list.

### Events

- `FILE_UPLOADED` payload is **deterministic**: tests pin system time to assert `timestamp` precisely.
- `INITIALIZED` fires once per "cold" initialization.

### AbortController

- Verifies `requestOptions` (with `signal`) is forwarded from `upload()`/`download()`/`listFiles()` into the
  underlying `uploadFilesFromDirectory`/`uploadFile`/`getWrappedData`/`loadMantaray` calls, and that omitting
  `requestOptions` doesn't forward `undefined` incorrectly.

---

## Writing new tests

- **When to choose unit vs. integration**
  - If logic depends on **Bee responses** (feeds, ACT, mantaray), prefer **integration** tests using `BeeDev`.
  - If you’re validating **pure FileManagerBase behavior** or edge branches, mock out Bee and write **unit** tests.

- **Use ACT options correctly** when downloading in integration tests:

  ```ts
  const files = await fm.download(fi, ['path.txt'], {
    actHistoryAddress: fi.file.historyRef,
    actPublisher: fi.actPublisher, // usually from bee.connectivity.getNodeAddresses().publicKey
  });
  ```

- **Add fixtures** under `tests/fixtures/` and keep them small to make the suite fast.

- **Prefer explicit errors**: if a code path is expected to throw, assert both **type** and **message** so regressions
  are easier to spot.

---

## Troubleshooting test failures

- **ACT unwrap (404/500) or permission errors**  
  Check you are passing **both** `actPublisher` and `actHistoryAddress` from the same context as the uploader.
- **CORS or port issues**  
  Ensure you dont have an existing bee node running on ports 1633 or 1733
- **Empty manifest or upload 400**  
  Ensure source directories are non-empty and readable; verify permissions.
- **Version assertions fail**  
  Re-check that the test uses the **historyRef** when bumping versions.

---

## Mapping: Features → Tests

| Feature                                    | Where it's tested                                            |
| ------------------------------------------ | ------------------------------------------------------------- |
| Initialization & admin stamp               | `integration: FileManager initialization`                     |
| Reinitialization / state revalidation      | `integration: FileManager reinitialization`, `unit: reinitialization` |
| Upload (dir/file)                          | `integration: FileManager upload`, `unit: upload`              |
| List files (mantaray)                      | `integration: FileManager listFiles`, `unit: listFiles`        |
| Download (all / subset)                    | `integration: FileManager download`, `unit: download`          |
| Versioning (get/restore/cache)             | `integration: FileManager version control`, `unit: version control` |
| Drive create/destroy/forget                | `integration: FileManager drive handling`, `unit: drive handling` |
| File lifecycle (trash/recover/forget)      | `integration: FileManager file operations`, `unit: file operations` |
| Grantees / sharing lookup                  | `integration: FileManager getGranteesOfFile`, `unit: getGranteesOfFile` |
| Events                                     | `unit: eventEmitter`, `integration: FileManager initialization` |
| AbortController / request cancellation     | `integration: FileManager AbortController`, `unit: AbortController` |
| End-to-end workflow                        | `integration: FileManager End-to-End User Workflow`            |

---

## Notes on Bee mainnet

These tests are designed for a **local devnode**. Running them against mainnet:

- will be **slow**, may incur **real costs**, and may **pollute** your feed history
- may produce **intermittent failures** due to network conditions or ACT publisher contexts

If you still need to point integration tests to a remote Bee, isolate those runs and supply appropriate **stamps**,
**signers**, and **ACT** parameters.

---
