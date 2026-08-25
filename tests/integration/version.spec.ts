import { type BatchId, type Bee, FeedIndex, type PrivateKey, Topic } from '@ethersphere/bee-js';

import {
  buyStampSerialized,
  createInitializedFileManager,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  retryOnPropagationDelay,
  streamToUint8Array,
} from '../utils';

import { setupUserDrive, tempFileRegistry } from './setup/utils';

import { FileManagerBase } from '@/fileManager';
import { type DriveInfo, type FileRecord, ListDepth } from '@/types';
import { getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, ROOT_PATH } from '@/utils/constants';

describe('Version control', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  let signer: PrivateKey;
  let ownerStamp: BatchId;
  const { writeTempFile, cleanup } = tempFileRegistry();

  // helper to ensure at least one base FileRecord exists.
  // Flat drive-manifest fork name (`name`) with the on-disk source (`src`) kept separate: the
  // disk fixture lives under tests/integration/tmp/ while the manifest fork stays a bare leaf.
  const ensureBase = async (name = `versioned-file-${Date.now()}`, di: DriveInfo = drive): Promise<FileRecord> => {
    const existing = fileManager.recordList.find((f) => f.path === name);
    if (existing) return existing;
    const src = writeTempFile(name, 'seed');
    await fileManager.uploadFile(di.id, { path: name, sourcePath: src });
    return fileManager.recordList.at(-1)!;
  };

  beforeAll(async () => {
    ({ bee, fileManager, drive, signer, ownerStamp } = await setupUserDrive('versioncontrol', {
      stampLabel: 'versioningStamp',
    }));
  });

  afterAll(cleanup);

  it('throws on invalid version index', async () => {
    const base = await ensureBase();
    await expect(fileManager.getFileVersion(base, BigInt(999).toString())).rejects.toThrow();
    await expect(fileManager.getFileVersion(base, BigInt(-1).toString())).rejects.toThrow();
  });

  it('handles sequential uploads with proper slot indices', async () => {
    const name = `parallel-${Date.now()}`;
    const src = writeTempFile(name, 'v0');
    await fileManager.uploadFile(drive.id, { path: name, sourcePath: src });
    const base = fileManager.recordList.at(-1)!;

    let latestVersion = BigInt(base.version!.toString());

    for (const i of [1, 2, 3]) {
      writeTempFile(name, `v${i}`);
      await fileManager.updateFile(drive.id, base, { item: { sourcePath: src } });

      latestVersion = BigInt(i);
    }

    expect(latestVersion).toBe(BigInt(base.version!.toString()) + 3n);

    for (let i = 0n; i < latestVersion; i++) {
      const fr = await fileManager.getFileVersion(base, FeedIndex.fromBigInt(i));
      expect(fr.version).toBe(FeedIndex.fromBigInt(i).toString());
    }

    // Fetch the current head without specifying an index
    const newLatest = await fileManager.getFileVersion(base);
    expect(newLatest.version).toBe(FeedIndex.fromBigInt(latestVersion).toString());
  });

  it('updateFile lazy-loads the record on a cold cache (fresh instance, no prior listing)', async () => {
    const NAME = `cold-update-${Date.now()}`;
    const src = writeTempFile(NAME, 'cold v0');
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: src });
    const base = fileManager.recordList.find((fr) => fr.path === NAME)!;
    expect(base.version).toBe(FEED_INDEX_ZERO.toString());

    // Fresh instance shares the signer/state but never listed the folder — its record cache is empty.
    const fm2 = new FileManagerBase(bee);
    await fm2.initialize();
    expect(fm2.recordList.find((fr) => fr.topic === base.topic)).toBeUndefined();

    writeTempFile(NAME, 'cold v1');
    const updated = await fm2.updateFile(drive.id, base, { item: { sourcePath: src } });

    // Re-versioned via lazy hydration; the record is now present in the fresh instance's cache.
    expect(updated.version).toBe(FeedIndex.fromBigInt(1n).toString());
    expect(updated.driveId).toBe(drive.id);
    expect(fm2.recordList.filter((fr) => fr.topic === base.topic)).toHaveLength(1);
  });

  it('updateFile throws when the record belongs to a different drive', async () => {
    const base = await ensureBase();

    const otherBatch = await buyStampSerialized(
      bee,
      DEFAULT_BATCH_AMOUNT,
      DEFAULT_BATCH_DEPTH,
      `mismatchStamp-${Date.now()}`,
    );
    await fileManager.createDrive(otherBatch, `other-drive-${Date.now()}`);
    const otherDrive = fileManager.driveList.at(-1)!;

    // base was uploaded into `drive`, not `otherDrive`.
    await expect(fileManager.updateFile(otherDrive.id, base, { customMetadata: { x: '1' } })).rejects.toThrow(
      /does not belong to drive/,
    );
  });

  it('getFileVersion returns independently downloadable, version-correct bytes', async () => {
    const NAME = `version-bytes-${Date.now()}`;
    const src = writeTempFile(NAME, 'Version bytes v0');
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: src });
    const v0Fi = fileManager.recordList.at(-1)!;

    writeTempFile(NAME, 'Version bytes v1');
    await fileManager.updateFile(drive.id, v0Fi, { item: { sourcePath: src } });

    const v0 = await fileManager.getFileVersion(v0Fi, FEED_INDEX_ZERO);
    const head = await fileManager.getFileVersion(v0Fi);

    expect(v0.content.reference).not.toBe(head.content.reference);

    const v0Bytes = await retryOnPropagationDelay(async () => {
      return streamToUint8Array(
        await bee.data.downloadReadable(v0.content.reference, {
          actHistoryAddress: v0.content.historyRef,
          actPublisher: v0.actPublisher,
        }),
      );
    });
    expect(Buffer.from(v0Bytes).toString('utf-8')).toBe('Version bytes v0');

    const headBytes = await retryOnPropagationDelay(async () => {
      return streamToUint8Array(
        await bee.data.downloadReadable(head.content.reference, {
          actHistoryAddress: head.content.historyRef,
          actPublisher: head.actPublisher,
        }),
      );
    });
    expect(Buffer.from(headBytes).toString('utf-8')).toBe('Version bytes v1');
  });

  it('returns the cached FileRecord for the current head without refetching', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const spyGetFeedData = jest.spyOn(require('@/utils/bee'), 'getFeedData');

    const base = await ensureBase('cache-test');

    const cached = fileManager.recordList.find((f) => f.topic === base.topic)!;
    expect(cached).toBeDefined();

    spyGetFeedData.mockClear();

    const headSlot = FeedIndex.fromBigInt(BigInt(base.version!.toString()));
    const result = await fileManager.getFileVersion(base, headSlot);

    expect(result).toBe(cached);

    expect(spyGetFeedData).not.toHaveBeenCalled();
  });

  it('uploads multiple versions, counts them, fetches an old version and downloads it', async () => {
    const NAME = `versioned-file-${Date.now()}`;
    const content = 'Version 0 content';
    const src = writeTempFile(NAME, content);
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: src });
    const v0Fi = fileManager.recordList.at(-1)!;
    const initialVersion = BigInt(v0Fi.version!);

    writeTempFile(NAME, 'Version 1 content');
    await fileManager.updateFile(drive.id, v0Fi, { item: { sourcePath: src } });

    const countAfterV1 = await getFeedData(bee, new Topic(v0Fi.topic), signer.publicKey().address().toString());
    const latestFi = await fileManager.getFileVersion(v0Fi, countAfterV1.feedIndex);
    writeTempFile(NAME, 'Version 2 content');
    await fileManager.updateFile(drive.id, latestFi, { item: { sourcePath: src } });

    // Raw feed reads are eventually consistent; under parallel node load the last write may not be
    // visible immediately. Retry until the feed reflects all three writes (v0 + two updates).
    const count = await retryOnPropagationDelay(async () => {
      const c = await getFeedData(bee, new Topic(v0Fi.topic), signer.publicKey().address().toString());
      if (c.feedIndexNext.toBigInt() !== initialVersion + 3n) {
        throw new Error(`feed not yet propagated: feedIndexNext=${c.feedIndexNext.toBigInt()}`);
      }
      return c;
    }, 10);
    expect(count.feedIndexNext.toBigInt()).toEqual(initialVersion + 3n);

    const v0 = await fileManager.getFileVersion(v0Fi, FEED_INDEX_ZERO);
    expect(v0.version).toBeDefined();
    expect(v0.version).toBe(FEED_INDEX_ZERO.toString());
  });

  it('can restore a prior version and make it the new head', async () => {
    // Re-upload must reuse the exact drive path ensureBase() uploaded with — see ensureBase() comment above.
    const NAME = 'restore-file';
    const base = await ensureBase(NAME);
    const initialVersion = BigInt(base.version!.toString());
    const firstRef = base.content.reference;

    const src = writeTempFile(NAME, 'second');
    await fileManager.updateFile(drive.id, base, { item: { sourcePath: src } });

    await fileManager.restoreFileVersion(base);

    // Eventually consistent: retry until the restore's new head slot is visible.
    const { feedIndex: current } = await retryOnPropagationDelay(async () => {
      const fd = await getFeedData(bee, new Topic(base.topic), signer.publicKey().address().toString());
      if (fd.feedIndex.toBigInt() !== initialVersion + 2n) {
        throw new Error(`restore not yet propagated: feedIndex=${fd.feedIndex.toBigInt()}`);
      }
      return fd;
    }, 10);

    expect(BigInt(current.toBigInt())).toBe(initialVersion + 2n);

    const restored = await fileManager.getFileVersion(base, current);

    expect(restored.content.reference).toBe(firstRef);
    expect(BigInt(restored.version!.toString())).toBe(initialVersion + 2n);
  });

  it('restoring on a single version file reaffirms the head', async () => {
    const NAME = 'noop-restore';
    const base = await ensureBase(NAME);
    const src = writeTempFile(NAME, 'B');
    await fileManager.updateFile(drive.id, base, { item: { sourcePath: src } });

    const currentHead = await fileManager.getFileVersion(base, base.version);

    await fileManager.restoreFileVersion(currentHead);

    const reHead = await fileManager.getFileVersion(base, base.version!);
    expect(reHead.version).toBe(currentHead.version);
    expect(reHead.content.reference).toBe(currentHead.content.reference);
  });

  it('restoring the current head does nothing', async () => {
    const base = await ensureBase('noop-default');
    const headIdx = FeedIndex.fromBigInt(BigInt(base.version!.toString()));
    const before = await fileManager.getFileVersion(base, headIdx);

    await expect(fileManager.restoreFileVersion(before)).rejects.toThrow(
      `Head Slot cannot be restored. Please select a version lesser than: ${before.version?.toString()}`,
    );

    const after = await fileManager.getFileVersion(base, headIdx);
    expect(after.version).toBe(before.version);
    expect(after.content.reference).toBe(before.content.reference);
  });

  it("restoring an old version keeps the current (post-move) location, not the version's recorded path", async () => {
    const NAME = 'restore-move-file.txt';
    const src = writeTempFile(NAME, 'Restore Move V0 Content');
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: src });
    const base = fileManager.recordList.at(-1)!;
    const topic = base.topic.toString();

    writeTempFile(NAME, 'Restore Move V1 Content');
    await fileManager.updateFile(drive.id, base, { item: { sourcePath: src } });

    await fileManager.createFolder(drive.id, ROOT_PATH, 'restore-move-dest');
    const destPath = 'restore-move-dest/restore-move-file.txt';
    await fileManager.move(NAME, destPath, drive.id);

    const v0 = await fileManager.getFileVersion(base, FEED_INDEX_ZERO);
    expect(v0.version).toBe(FEED_INDEX_ZERO.toString());

    const { feedIndex: headBeforeRestore } = await getFeedData(
      bee,
      new Topic(topic),
      signer.publicKey().address().toString(),
    );

    await fileManager.restoreFileVersion(v0);

    const cached = fileManager.recordList.find((f) => f.topic.toString() === topic)!;
    expect(cached).toBeDefined();
    // Restoring content must not regress the tree position back to v0's own recorded name.
    expect(cached.path).toBe(destPath);
    expect(cached.name).toBe('restore-move-file.txt');

    const { feedIndex: headAfterRestore } = await retryOnPropagationDelay(async () => {
      const result = await getFeedData(bee, new Topic(topic), signer.publicKey().address().toString());
      if (!(result.feedIndex.toBigInt() > headBeforeRestore.toBigInt())) {
        throw new Error('feed head has not advanced yet');
      }
      return result;
    });
    expect(headAfterRestore.toBigInt()).toBeGreaterThan(headBeforeRestore.toBigInt());

    const downloadResults = await retryOnPropagationDelay(() =>
      fileManager.downloadFolder(drive.id, 'restore-move-dest'),
    );
    const downloaded = downloadResults.succeeded.find((d) => d.path === destPath);
    expect(downloaded).toBeDefined();
    expect(downloadResults.failed).toEqual([]);
    expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Restore Move V0 Content');
  });

  it('restores an old version from a cold instance without disturbing a same-named file at the root', async () => {
    const NAME = `cold-restore-${Date.now()}.txt`;
    const src = writeTempFile(NAME, 'Cold V0');
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: src });
    const base = fileManager.recordList.find((f) => f.path === NAME)!;
    const topic = base.topic.toString();

    writeTempFile(NAME, 'Cold V1');
    await fileManager.updateFile(drive.id, base, { item: { sourcePath: src } });

    await fileManager.createFolder(drive.id, ROOT_PATH, 'coldsub');
    const destPath = 'coldsub/moved.txt';
    await fileManager.move(NAME, destPath, drive.id);

    // A rename/move writes no record, so every version's payload — including the head's — still
    // carries the pre-move leaf name. A decoy now occupies exactly that name at the root.
    const decoySrc = writeTempFile(`decoy-${NAME}`, 'Decoy Content');
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: decoySrc });
    const decoy = fileManager.recordList.find((f) => f.path === NAME)!;
    expect(decoy.topic.toString()).not.toBe(topic);

    const movedRecord = await retryOnPropagationDelay(async () => {
      const reader = await createInitializedFileManager(bee, ownerStamp);
      const entries = (await reader.listFolder(drive.id, 'coldsub', ListDepth.Shallow)).entries;
      const found = entries.find((e) => e.path === destPath);
      if (!found) {
        throw new Error('move not yet propagated to a fresh instance');
      }
      return found as FileRecord;
    });

    // A cold instance: it never listed the drive, so nothing hydrates the record's absolute path
    // except the record the caller hands in.
    const coldFm = await createInitializedFileManager(bee, ownerStamp);
    expect(coldFm.recordList.find((f) => f.topic.toString() === topic)).toBeUndefined();

    const v0 = await coldFm.getFileVersion(movedRecord, FEED_INDEX_ZERO);
    expect(v0.version).toBe(FEED_INDEX_ZERO.toString());
    expect(v0.path).toBe(destPath);
    expect(v0.name).toBe('moved.txt');

    await coldFm.restoreFileVersion(v0);

    // The restore landed on the moved file.
    const restoredContent = await retryOnPropagationDelay(async () => {
      const downloads = await coldFm.downloadFolder(drive.id, 'coldsub');
      const got = downloads.succeeded.find((d) => d.path === destPath);
      if (!got) {
        throw new Error('restored file not yet downloadable');
      }
      return Buffer.from(await streamToUint8Array(got.result)).toString('utf-8');
    });
    expect(restoredContent).toBe('Cold V0');

    // The decoy sharing the leaf name kept its own topic, version and bytes.
    const verifier = await createInitializedFileManager(bee, ownerStamp);
    const rootEntries = await retryOnPropagationDelay(() =>
      verifier.listFolder(drive.id, ROOT_PATH, ListDepth.Shallow).then((r) => r.entries),
    );
    const decoySeen = rootEntries.find((e) => e.path === NAME);
    expect(decoySeen).toBeDefined();
    expect(decoySeen!.path).toBe(NAME);
    expect(decoySeen!.topic.toString()).toBe(decoy.topic.toString());
    expect(decoySeen!.version).toBe(decoy.version);

    const decoyDownload = await verifier.downloadFile(decoySeen as FileRecord);
    expect(Buffer.from(await streamToUint8Array(decoyDownload.result)).toString('utf-8')).toBe('Decoy Content');
  });
});
