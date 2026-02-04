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
npm install @solarpunkltd/file-manager-lib
```

Peer dependency: `@ethersphere/bee-js`

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
npm install -g @ethersphere/swarm-cli
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
import { Bee } from '@ethersphere/bee-js';
import { FileManagerBase } from '@solarpunkltd/file-manager-lib';

const bee = new Bee('http://localhost:1633', { signer });
const fm = new FileManagerBase(bee);
const adminBatchId = new BatchId('your-admin-batchId');
// purchase an 'admin' stamp, and a 'My Drive' stamp in the background,
// or use beeApi to purchase the stamp inline before initialization
// initialize drives & topics
await fm.initialize(adminBatchId);

// create an admin drive
await fm.createDrive(adminBatchId, 'admin', true);
// create a drive (non-admin)
await fm.createDrive('<BATCH_ID>', 'My Drive', false);

// upload directory
const uploaded = await fm.upload(fm.driveList[0], { info: { name: 'docs' }, path: './docs' });

// list + download
const fi = fm.fileInfoList.find((f) => f.name === 'docs')!;
const list = await fm.listFiles(fi, {
  actHistoryAddress: fi.file.historyRef,
  actPublisher: fi.actPublisher,
});
const data = await fm.download(fi, ['README.md'], {
  actHistoryAddress: fi.file.historyRef,
  actPublisher: fi.actPublisher,
});
```

### Browser differences

- Use `{ files: FileList }` instead of `{ path }`.
- `download()` returns `ReadableStream[]` instead of `Bytes[]`.

---

## Scripts

From `package.json`:

- `npm run build` → compile Node + browser + types.
- `npm test` → run Jest integration tests (see [TESTS.md](TESTS.md)).
- `npm run lint` / `npm run lint:fix` → linting.
- `npm run build:browser` → bundle with Vite.

---

## Troubleshooting

- **Admin stamp not found** → buy a new stamp and label it `admin`.
- **File not found** → ensure correct directory path or FileList provided.
- **Postage expired** → buy a new one and re-initialize.
- **CORS mismatch** → align `--cors-allowed-origins` in Bee with your frontend origin.
- **ACT unwrap errors** → ensure both `actPublisher` and `actHistoryAddress` are passed.

---

## License

TBD
