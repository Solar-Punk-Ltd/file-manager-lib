# v2/tests — suite reorg, bee-factory environment, CI

## Test environment (bee-factory)

- `jest.config.ts` now defines two projects, `unit` and `integration`, selectable via `--selectProjects`.
- Integration `globalSetup` / `globalTeardown` (`tests/integration/setup/jestSetup.ts` / `jestTeardown.ts`) provision
  the Bee nodes with `@ethersphere/bee-factory` — queen at `127.0.0.1:1633`, worker at `127.0.0.1:1635`. This replaces
  the shell-script bootstrap (`tests/integration/test-node-setup/*.sh` + its jest setup/teardown), which is removed.
- `package.json` gains the `bee-factory` dev dependency and the `test`, `test:ut`, `test:it`, `test:coverage` scripts.

## Suite reorganization

The monolithic `tests/integration/fileManager.spec.ts` and `tests/unit/fileManager.spec.ts` are split into
per-capability suites:

- **Integration** (`tests/integration/`): `abort`, `drive`, `e2e`, `file`, `folder`, `init`, `trash`, `version`.
- **Unit** (`tests/unit/`): `abort`, `drive`, `events`, `file`, `folder`, `init`, `trash`, `version`.

Trash suites cover the full lifecycle for both files and folders (trash / recover / forget).

## Shared fixtures & helpers

- `tests/integration/setup/utils.ts` (new) — `setupUserDrive` (single-call bee + FileManager + drive fixture),
  `tempFileRegistry` (temp files are tracked and removed by one `afterAll`, so no temporary file survives a run), and
  `ensureUniqueSignerWithStamp`.
- `tests/unit/setup.ts` (new) — centralizes `jest.mock` and exposes `applyDefaultMocks`; `tests/unit/mock.ts` (record /
  drive seeding) replaces `tests/mockHelpers.ts`.
- `tests/utils.ts` — shared node URLs, mock signers, `retryOnPropagationDelay`, and `createInitializedFileManager`.
- Static `tests/fixtures/*` inputs are removed — suites write their inputs through `tempFileRegistry` instead.

## CI (`.github/workflows/tests.yaml`)

- Unit tests run on every PR and on push to `master` / `develop`.
- Integration tests (Docker + bee-factory, resource-heavy) run only on push to `master` / `develop`, manual dispatch, a
  PR targeting `master`, or a PR carrying the `run-it` label.
- A `concurrency` group cancels superseded runs on the same ref.

## Docs

- `tests/TESTS.md` rewritten for the two-project layout, bee-factory prerequisites, the shared-helper model, and
  per-suite coverage.

## Gate

- `pnpm run lint` and `build` clean
- `pnpm run test` clean, every test case and suite passes.
