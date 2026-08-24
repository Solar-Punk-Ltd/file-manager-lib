# File Manager Library

**@solarpunkltd/file-manager-lib** is a TypeScript/JavaScript library for storing and handling files on
[Swarm](https://ethersphere.github.io/swarm-home/). It builds on [Bee](https://github.com/ethersphere/bee-js) to
provide:

- **Drives** — logical containers backed by postage stamps.
- **Files** — uploaded as manifests, stored in feeds, versioned automatically.
- **Access Control (ACT)** — enforceable read/unwrapping via publisher + history address.
- **Versioning** — restore any historical version to head.
- **Soft delete / recover / forget** — manage lifecycle without losing underlying Swarm data.
- **Sharing** — manage grantees and share notifications.
- **Browser + Node.js support** — unified API.

> Full method-level documentation: see [REFERENCE.md](REFERENCE.md). Test coverage and usage patterns: see
> [TESTS.md](tests/TESTS.md).

---

## Installation

```bash
pnpm install @solarpunkltd/file-manager-lib
```

Dependency: `@ethersphere/bee-js` v13 (`13.0.0-upcoming.*`). Requires **Node.js ≥ 24** (see `engines` in
`package.json`).

---

## Running a Bee Node

The library requires a running [Bee](https://github.com/ethersphere/bee) node with postage stamps available.

### Local Development (Dev Mode)

```bash
bee dev --cors-allowed-origins="*"
```

- Runs with in-memory chequebook.
- Useful for testing and development.

### Mainnet / Production

```bash
bee start --config bee.yaml
```

- Requires full Bee setup (swap, chequebook, persisted DB).
- Ensure you have purchased real postage stamps with BZZ on mainnet.

---

## Postage Stamps

You need an active postage stamp to upload data.

### Install CLI

```bash
pnpm install -g @ethersphere/swarm-cli
```

### List existing stamps

```bash
swarm-cli stamp list
```

### Buy a new stamp

```bash
swarm-cli stamp buy --amount 100000000000 --depth 20 --label admin
```

- `--label admin` will make this stamp the **admin drive** automatically.

---

## Quick Start Example

```ts
import { BatchId, Bee } from '@ethersphere/bee-js';
import { FileManagerBase } from '@solarpunkltd/file-manager-lib';

const bee = new Bee('http://localhost:1633', { signer });
const fm = new FileManagerBase(bee);

// reads node addresses and, if admin state already exists on Swarm, loads
// drives + file infos; otherwise starts empty and waits for createDrive()
await fm.initialize();

// create the admin drive (owns the drive list feed) — batchId must be a real, usable stamp
const adminBatchId = new BatchId('your-admin-batchId');
await fm.createDrive(adminBatchId, 'admin', true);

// create a drive (non-admin)
await fm.createDrive('<BATCH_ID>', 'My Drive', false);

// upload a directory (Node) into that drive
const drive = fm.driveList.find((d) => d.name === 'My Drive')!;
await fm.upload(drive, { name: 'docs', path: './docs' });

// list + download
const fi = fm.fileInfoList.find((f) => f.name === 'docs')!;
const list = await fm.listFiles(fi, undefined, {
  actHistoryAddress: fi.file.historyRef,
  actPublisher: fi.actPublisher,
});
const data = await fm.download(fi, ['README.md'], {
  actHistoryAddress: fi.file.historyRef,
  actPublisher: fi.actPublisher,
});
```

`upload()` does not return the `FileInfo` — listen for `FileManagerEvents.FILE_UPLOADED`, or look it up afterwards in
`fm.fileInfoList`.

### Browser differences

- Pass `{ files: FileList | File[] }` (and optionally `preview: File`) instead of `{ path, previewPath }`.
- `download()` returns `ReadableStream[]` instead of `Bytes[]`.

---

## Scripts

From `package.json`:

- `pnpm run build` → compile types + CJS + ESM.
- `pnpm run test` → run all Jest tests (unit + integration), see [TESTS.md](tests/TESTS.md).
- `pnpm run test:ut` / `pnpm run test:it` → unit only / integration only.
- `pnpm run test:coverage` → run tests with coverage.
- `pnpm run lint` / `pnpm run lint:fix` → linting.
- `pnpm run check:types` → typecheck all build targets without emitting.
- `pnpm init:husky` → husky init
- `pnpm run depcheck` → check dependencies

---

## Troubleshooting

- **Admin stamp not found** → buy a new stamp and label it `admin`.
- **File not found** → ensure correct directory path or FileList provided.
- **Postage expired** → buy a new one and re-initialize.
- **CORS mismatch** → align `--cors-allowed-origins` in Bee with your frontend origin.
- **ACT unwrap errors** → ensure both `actPublisher` and `actHistoryAddress` are passed.

---

## License

[Apache-2.0](./LICENSE)
