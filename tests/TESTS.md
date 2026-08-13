# TESTS — @solarpunkltd/file-manager-lib

This document explains how the test-suite for **@solarpunkltd/file-manager-lib** is organized and how to run, extend,
and troubleshoot it. It covers both **unit** and **integration** tests (including an end‑to‑end workflow suite).

> For usage and API details, see: • **README.md** — install, mainnet setup

---

## At a glance

- **Jest** with three **projects** (`unit-node`, `unit-browser`, `integration`), all under **ts-jest** in a Node
  environment.
- **Unit tests** mock all Swarm/Bee internals and focus on `FileManagerBase` behavior — no network. They run **twice**:
  `unit-node` and `unit-browser` execute the same specs, the latter adding `tests/platform-browser.ts` to shim browser
  globals so the platform-split code is exercised both ways.
- **Integration tests** run against real Bee nodes provisioned by **`@ethersphere/bee-factory`** and exercise ACT
  encryption, per‑file feeds, mantaray drive manifests, versioning and the reserved `.trash` folder end‑to‑end.
- The runner uses **`--maxWorkers=4`**; integration steps lean on the 5-minute `testTimeout` + propagation retries
  rather than serial execution.
- `testTimeout` is **5 minutes** per test (integration steps wait on chunk propagation).
- Coverage is **opt-in** via `pnpm run test:coverage` (`v8` provider) into `tests/coverage`.

---

## Prerequisites

- **Node.js** — **≥ 22** (matches `engines.node`).
- **Docker** — required for integration tests. `bee-factory` spins up a local Bee cluster in containers.
- **`@ethersphere/bee-factory`** — a dev/test dependency. The integration project's `globalSetup` starts it and
  `globalTeardown` stops it automatically; you don't start Bee manually.
  - Queen node (used by tests): `http://127.0.0.1:1633` (`BEE_URL`)
  - Worker node (a non-admin peer): `http://127.0.0.1:1635` (`OTHER_BEE_URL`)
  - The image tag defaults to `v2.8.0` and can be overridden with the `BEE_FACTORY_TAG` env var.

Unit tests need none of the above — they never touch the network.

---

## Running tests

```bash
# Everything (unit-node + unit-browser + integration), verbose
pnpm test

# Only unit (both envs) / only integration
pnpm run test:ut
pnpm run test:it

# A single unit env
pnpm run test:ut:node
pnpm run test:ut:browser

# Coverage
pnpm run test:coverage
```

Scripts exposed by `package.json`:

- **`pnpm test`** → `jest --config=jest.config.ts --maxWorkers=4 --verbose --silent`
- **`pnpm run test:ut`** → `test --selectProjects=unit-node` then `test --selectProjects=unit-browser`
- **`pnpm run test:ut:node`** / **`pnpm run test:ut:browser`** → a single unit env
- **`pnpm run test:it`** → `test --selectProjects=integration`
- **`pnpm run test:coverage`** → `test --coverage`

Everything is configured in `jest.config.ts`, including the `@/*` → `src/*` path mapping used throughout the specs.

---

## Directory layout

```
tests/
├─ TESTS.md
├─ utils.ts                     # shared: URLs, signers, batch params, createInitializedFileManager, retry/stream helpers
├─ platform-browser.ts          # unit-browser setupFilesAfterEnv — shims browser globals (File/Blob/…)
├─ unit/
│   ├─ setup.ts                 # setupFilesAfterEnv — centralizes jest.mock() for @/utils/bee & @/utils/mantaray
│   ├─ mock.ts                  # applyDefaultMocks, mock factories, seedRecords, unit createInitializedFileManager
│   ├─ init.spec.ts
│   ├─ drive.spec.ts
│   ├─ file.spec.ts
│   ├─ folder.spec.ts
│   ├─ version.spec.ts
│   ├─ trash.spec.ts
│   ├─ events.spec.ts
│   └─ abort.spec.ts
└─ integration/
    ├─ setup/
    │   ├─ jestSetup.ts         # globalSetup → `npx bee-factory start --tag <tag>`
    │   ├─ jestTeardown.ts      # globalTeardown → `npx bee-factory stop`
    │   └─ utils.ts             # temporary file and stamp management
    ├─ init.spec.ts
    ├─ drive.spec.ts
    ├─ file.spec.ts
    ├─ folder.spec.ts
    ├─ version.spec.ts
    ├─ trash.spec.ts
    ├─ e2e.spec.ts
    └─ abort.spec.ts
```

Each domain area lives in its own spec file, mirrored across `unit/` and `integration/`.

### Shared helpers

**`tests/utils.ts`** (used by both projects)

- Constants: `BEE_URL`, `OTHER_BEE_URL`, `DEFAULT_MOCK_SIGNER`, `OTHER_MOCK_SIGNER`, `DUMMY_BATCH_ID`,
  `DEFAULT_BATCH_DEPTH`, `DEFAULT_BATCH_AMOUNT`.
- `createInitializedFileManager(bee?, batchId?, emitter?)` — constructs a `FileManagerBase`, initializes it, and
  bootstraps an admin drive if one isn't present.
- `retryOnPropagationDelay(fn, attempts?, delayMs?)` — retries a read until chunks propagate on the devnet.
- `streamToUint8Array`, `readFilesOrDirectory`, `getTestFile` — content/dir helpers.

**Unit — `tests/unit/setup.ts` + `tests/unit/mock.ts`**

- `setup.ts` is wired via `setupFilesAfterEnv` and holds the module-level `jest.mock()` calls for `@/utils/bee`
  (`getFeedData`, `fetchStamp`) and `@/utils/mantaray` (`loadMantaray`, `getAllNodeEntries`). Centralizing them here
  keeps every spec free of duplicated mock boilerplate.
- `mock.ts` provides `applyDefaultMocks()` (call it first in each `beforeEach` — resets mocks, installs
  `createInitMocks` and sensible default return values), mock factories (`createMockDriveInfo`, `createMockFileInfo`,
  `createMockFeedReader`, `createMockFeedWriter`, `createMockMantarayNode`, …), `seedRecords(fm, ...records)` to
  pre-populate the record cache, and a unit-local `createInitializedFileManager`.

**Integration — `tests/integration/setup/utils.ts`**

- `ensureUniqueSignerWithStamp(isNewSigner?)` — returns `{ bee, ownerStamp, signer }`, buying the admin/owner stamp once
  and caching it for the run.
- `setupUserDrive(driveName, { stampLabel?, reuseOwnerStamp? })` — the standard `beforeAll` fixture: ensures a signer,
  initializes a `FileManagerBase` (with admin drive), buys a stamp, creates the named user drive, and returns
  `{ bee, fileManager, drive, ownerStamp, batchId, signer }`.
- `tempFileRegistry()` — returns `{ writeTempFile, writeTempDir, cleanup }`. All on-disk fixtures are written under
  **`tests/integration/tmp/`** (gitignored + npmignored, never the repo root), and removed in a single
  `afterAll(cleanup)`, so **no temporary file survives the run** even if a test throws. `writeTempFile` / `writeTempDir`
  return the **absolute** on-disk path — feed that to `sourcePath`, and keep the logical drive `path` separate (they are
  decoupled: the disk fixture lives in `tmp/`, the drive path is whatever you upload it as).

---

## Domain model under test (v2)

- `FileManagerBase` exposes `recordList` (`FileRecord[]`) and `driveList` (`DriveInfo[]`); records and drives carry a
  `NodeType`.
- **Drives are mantaray manifests.** A drive's file tree is a mantaray whose forks carry per-file metadata; per-file
  version history lives in each file's own Swarm feed.
- **ACT** wraps content per file (`content.historyRef`, `actPublisher`).
- **Trash is a reserved `.trash` folder** at the drive root: trashing relocates the node's fork into it keyed by topic,
  so status is _derived_ from a node's location and a fresh instance sees it by walking the tree.
- `FileManagerConfig` lets clients cap `uploadConcurrency` and `feedFetchConcurrency`.
- Sharing / grantees are **not** part of v2 and are not tested.

---

## Integration tests — what each suite verifies

Executed against live bee-factory nodes.

- **`init.spec.ts`** — _Initialization and construction_ + _reinitialization_: default state, admin feed/topic
  stability, a non-owner failing to read the admin feed, and `INITIALIZED` / `STATE_INVALID` behavior across
  re-initialization with a valid vs. expired admin stamp (user drives and admin stamp survive re-init).
- **`drive.spec.ts`** — _Drive operations_: `createDrive` persists id/owner/batch/redundancy; forgetting a user drive
  removes it, prunes its records, emits `DRIVE_FORGOTTEN`, and persists; destroying/forgetting the **admin** drive and
  forgetting a non-existent drive throw `DriveError`.
- **`file.spec.ts`** — split into `uploadFile`, `uploadFiles`, `updateFile`, `downloadFile and downloadFiles`, `move`:
  single- and multi-file uploads (each with its own topic), implicit folder creation with batched manifest saves, the
  two-hop ACT-unwrap download round-trip, `updateFile` re-versioning (content vs. metadata-only), directory-source
  guards, rename/move within a drive, and a foreign-drive path failing to resolve (there is no cross-drive move).
- **`folder.spec.ts`** — _Folder operations_: `listFolder` (relative paths, empty folders, deep nesting, empty-path
  rejection), `downloadFolder` destination-path composition, and moving a folder as a unit.
- **`version.spec.ts`** — _Version control_: invalid index rejection, sequential slot indices, cold-cache lazy
  hydration, drive-mismatch guard, independently downloadable version bytes, cached-head fast path, restoring a prior
  version as the new head, no-op restore of the head, and restore keeping the current (post-move) location.
- **`trash.spec.ts`** — _Lifecycle management_: trash/recover round-trips through the `.trash` folder (a fresh instance
  stops listing the node and finds it via `listTrash`, **no** version bump), folder trash carrying its subtree,
  same-named nodes kept apart, recover to an explicit destination after the origin was forgotten, the write guards,
  `emptyTrash`, and `forget` (hard de-reference).
- **`abort.spec.ts`** — _Abort signal handling_: `AbortSignal` forwarding for `uploadFile`, `downloadFiles`, and
  `listFolder` — pre-aborted, mid-flight cancel, and clean completion when not aborted.
- **`e2e.spec.ts`** — _End-to-End User Workflow_: in-place folder update (one file changes, siblings untouched), adding
  a new folder version without disturbing old files, and multi-branch relative-path listing.

---

## Unit tests — what each suite verifies

Located in `tests/unit/`, all network access mocked (see `setup.ts` / `mock.ts`).

Key strategies:

- `@/utils/bee` (`getFeedData`, `fetchStamp`) and `@/utils/mantaray` (`loadMantaray`, `getAllNodeEntries`) are
  `jest.mock()`-ed in `setup.ts`; `applyDefaultMocks()` gives them default resolved values per test.
- Bee client methods are spied via `createInitMocks` (`downloadData`, `uploadData`, feed reader/writer, stamps, …).
- `seedRecords()` injects `FileRecord`s directly into the cache to test read paths without uploading.

- **`init.spec.ts`** — _constructor_ (missing signer, emitter wiring), _initialize_ (emits `INITIALIZED`; idempotent),
  _reinitialization_.
- **`drive.spec.ts`** — `creatAdminDrive`, `createDrive` (duplicate name/batchId → `DriveError`), `destroyDrive`
  (`bee.diluteBatch` / admin-stamp guard), `forgetDrive`.
- **`file.spec.ts`** — _File operations_ → `downloadFile`, `downloadFiles`, `uploadFile`, `updateFile`, `move` (correct
  ACT params, no duplicate records on re-version, directory guards).
- **`folder.spec.ts`** — `downloadFolder`, `listFolder`, `createFolder`, `move`.
- **`version.spec.ts`** — `getFileVersion` (indexed vs. head, cache reuse, missing-feed error), `restoreFileVersion`
  (head restore is a no-op / emits no event).
- **`trash.spec.ts`** — _Lifecycle management_ → `trash`, `recover`, `listTrash`, `emptyTrash`, `forget` (fork
  relocation, origin stamping and event emission).
- **`events.spec.ts`** — _Events and emitter_: deterministic `FILE_UPLOADED` payloads (system time pinned via
  `jest.useFakeTimers()`), `INITIALIZED` fired once per cold init.
- **`abort.spec.ts`** — abort-signal plumbing at the unit level.

Emitted events live in `FileManagerEvents` (`src/utils/events.ts`): `FILE_UPLOADED`, `FILE_UPDATED`, `FILE_TRASHED`,
`FILE_RECOVERED`, `FILE_FORGOTTEN`, `FILE_VERSION_RESTORED`, `FILE_MOVED`, `INITIALIZED`, `DRIVE_CREATED`,
`DRIVE_FORGOTTEN`, `FOLDER_*` (including `FOLDER_MOVED`), `FILES_UPLOADED`, `TRASH_EMPTIED`, `STATE_INVALID`. The
file/folder pairs of a path-addressed operation carry the same payload shape — see
[REFERENCE.md](../REFERENCE.md#events).

---

## Writing new tests

- **Unit vs. integration**
  - Depends on real Bee behavior (feeds, ACT, mantaray, propagation)? → **integration**, using `setupUserDrive`.
  - Validating pure `FileManagerBase` branches/edge cases? → **unit**, using `applyDefaultMocks` + `seedRecords`.

- **Integration `beforeAll` fixture** — prefer `setupUserDrive` over hand-rolling stamp/drive setup:

  ```ts
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ fileManager, drive } = await setupUserDrive('my-suite', { stampLabel: 'mySuiteStamp' }));
  });

  afterAll(cleanup);
  ```

- **On-disk fixtures** — always create them via `writeTempFile` / `writeTempDir` (they write under
  `tests/integration/tmp/` and return the absolute source path to pass as `sourcePath`). Never call
  `fs.writeFileSync`/`mkdirSync` directly in a spec, and never reuse the drive `path` string as the `sourcePath`.

- **ACT download parameters** — pass `actHistoryAddress` and `actPublisher` from the same context that uploaded:

  ```ts
  await fileManager.downloadFiles(
    [record],
    { actHistoryAddress: record.content.historyRef, actPublisher },
    { signal }, // optional requestOptions
  );
  ```

- **Propagation** — wrap reads that follow a write in `retryOnPropagationDelay(() => ...)` to avoid devnet flakiness.

- **Unit ordering** — call `applyDefaultMocks()` at the top of `beforeEach`, _before_ `createInitializedFileManager()`,
  so the mocks are in place when the manager initializes.

- **Prefer explicit errors** — assert both the error **type** and **message** so regressions are easy to spot.

---

## Troubleshooting

- **bee-factory won't start / port in use** — ensure Docker is running and nothing else is bound to `1633`/`1635`. A
  previous crashed run may leave containers up; `npx bee-factory stop` clears them.
- **ACT unwrap (404/500) / permission errors** — pass **both** `actPublisher` and `actHistoryAddress` from the
  uploader's context.
- **Version assertions fail** — confirm the test re-uploads using the **same path** the record was created with and
  reads the feed head after propagation.
- **Flaky reads right after a write** — increase the `retryOnPropagationDelay` attempts/delay for that step.
- **Leftover temp files** — shouldn't happen; every fixture goes through `tempFileRegistry()` and is removed in
  `afterAll(cleanup)`. If you added a raw `fs` write, route it through the registry.

---

## Notes on Bee mainnet

The integration suite targets a local **bee-factory** cluster. Pointing it at mainnet will be **slow**, may incur **real
costs**, may **pollute** your feed history, and can fail intermittently on network/ACT-publisher contexts. If you must,
isolate those runs and supply appropriate stamps, signers, and ACT parameters.
