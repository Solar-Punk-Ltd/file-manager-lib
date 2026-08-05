import { Bee, FeedIndex, Topic } from '@ethersphere/bee-js';

import {
  buyStamp,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  retryOnPropagationDelay,
  streamToUint8Array,
} from '../utils';

import { setupUserDrive, tempFileRegistry } from './setup/utils';

import { FileManagerBase } from '@/fileManager';
import { BeeClient } from '@/swarm';
import { DriveInfo, FileRecord } from '@/types';
import { getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, ROOT_PATH } from '@/utils/constants';

describe('Version control', () => {
  let client: BeeClient;
  let bee: Bee;
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, cleanup } = tempFileRegistry();

  // helper to ensure at least one base FileRecord exists.
  // Flat, cwd-relative name: upload()'s `path` doubles as both the on-disk source and the
  // top-level drive manifest fork name, so it must resolve with zero intermediate segments.
  const ensureBase = async (name = `versioned-file-${Date.now()}`, di: DriveInfo = drive): Promise<FileRecord> => {
    const existing = fileManager.recordList.find((f) => f.path === name);
    if (existing) return existing;
    writeTempFile(name, 'seed');
    await fileManager.uploadFile(di.id, { path: name, sourcePath: name });
    return fileManager.recordList.at(-1)!;
  };

  beforeAll(async () => {
    const {
      client: bc,
      fileManager: fm,
      drive: d,
      bee: beeDev,
    } = await setupUserDrive('versioncontrol', {
      stampLabel: 'versioningStamp',
    });

    bee = beeDev;
    fileManager = fm;
    drive = d;
    client = bc;
  });

  afterAll(cleanup);

  it('throws on invalid version index', async () => {
    const base = await ensureBase();
    await expect(fileManager.getFileVersion(base, BigInt(999).toString())).rejects.toThrow();
    await expect(fileManager.getFileVersion(base, BigInt(-1).toString())).rejects.toThrow();
  });

  it('handles sequential uploads with proper slot indices', async () => {
    const name = `parallel-${Date.now()}`;
    writeTempFile(name, 'v0');
    await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
    const base = fileManager.recordList.at(-1)!;

    let latestVersion = BigInt(base.version!.toString());

    for (const i of [1, 2, 3]) {
      writeTempFile(name, `v${i}`);
      await fileManager.updateFile(drive.id, base, { item: { sourcePath: name } });

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
    writeTempFile(NAME, 'cold v0');
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: NAME });
    const base = fileManager.recordList.find((fr) => fr.path === NAME)!;
    expect(base.version).toBe(FEED_INDEX_ZERO.toString());

    // Fresh instance shares the signer/state but never listed the folder — its record cache is empty.
    const fm2 = new FileManagerBase(client);
    await fm2.initialize();
    expect(fm2.recordList.find((fr) => fr.topic === base.topic)).toBeUndefined();

    writeTempFile(NAME, 'cold v1');
    const updated = await fm2.updateFile(drive.id, base, { item: { sourcePath: NAME } });

    // Re-versioned via lazy hydration; the record is now present in the fresh instance's cache.
    expect(updated.version).toBe(FeedIndex.fromBigInt(1n).toString());
    expect(updated.driveId).toBe(drive.id);
    expect(fm2.recordList.filter((fr) => fr.topic === base.topic)).toHaveLength(1);
  });

  it('updateFile throws when the record belongs to a different drive', async () => {
    const base = await ensureBase();

    const otherBatch = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, `mismatchStamp-${Date.now()}`);
    await fileManager.createDrive(otherBatch, `other-drive-${Date.now()}`);
    const otherDrive = fileManager.driveList.at(-1)!;

    // base was uploaded into `drive`, not `otherDrive`.
    await expect(fileManager.updateFile(otherDrive.id, base, { customMetadata: { x: '1' } })).rejects.toThrow(
      /does not belong to drive/,
    );
  });

  it('getFileVersion returns independently downloadable, version-correct bytes', async () => {
    const NAME = `version-bytes-${Date.now()}`;
    writeTempFile(NAME, 'Version bytes v0');
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: NAME });
    const v0Fi = fileManager.recordList.at(-1)!;

    writeTempFile(NAME, 'Version bytes v1');
    await fileManager.updateFile(drive.id, v0Fi, { item: { sourcePath: NAME } });

    const v0 = await fileManager.getFileVersion(v0Fi, FEED_INDEX_ZERO);
    const head = await fileManager.getFileVersion(v0Fi);

    expect(v0.content.reference).not.toBe(head.content.reference);

    const v0Bytes = await retryOnPropagationDelay(async () => {
      return streamToUint8Array(
        await bee.downloadReadableData(v0.content.reference, {
          actHistoryAddress: v0.content.historyRef,
          actPublisher: v0.actPublisher,
        }),
      );
    });
    expect(Buffer.from(v0Bytes).toString('utf-8')).toBe('Version bytes v0');

    const headBytes = await retryOnPropagationDelay(async () => {
      return streamToUint8Array(
        await bee.downloadReadableData(head.content.reference, {
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
    writeTempFile(NAME, content);
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: NAME });
    const v0Fi = fileManager.recordList.at(-1)!;
    const initialVersion = BigInt(v0Fi.version!);

    writeTempFile(NAME, 'Version 1 content');
    await fileManager.updateFile(drive.id, v0Fi, { item: { sourcePath: NAME } });

    const countAfterV1 = await getFeedData(client, new Topic(v0Fi.topic), client.owner);
    const latestFi = await fileManager.getFileVersion(v0Fi, countAfterV1.feedIndex);
    writeTempFile(NAME, 'Version 2 content');
    await fileManager.updateFile(drive.id, latestFi, { item: { sourcePath: NAME } });

    const count = await getFeedData(client, new Topic(v0Fi.topic), client.owner);
    expect(count.feedIndexNext.toBigInt()).toEqual(initialVersion + 3n);

    const v0 = await fileManager.getFileVersion(v0Fi, FEED_INDEX_ZERO);
    expect(v0.version).toBeDefined();
    expect(v0.version).toBe(FEED_INDEX_ZERO.toString());
  });

  it('can restore a prior version and make it the new head', async () => {
    // Re-upload must reuse the exact path ensureBase() uploaded with — see ensureBase() comment above.
    const NAME = 'restore-file';
    const base = await ensureBase(NAME);
    const initialVersion = BigInt(base.version!.toString());
    const firstRef = base.content.reference;

    writeTempFile(NAME, 'second');
    await fileManager.updateFile(drive.id, base, { item: { sourcePath: NAME } });

    await fileManager.restoreFileVersion(base);

    const { feedIndex: current } = await getFeedData(client, new Topic(base.topic), client.owner);

    expect(BigInt(current.toBigInt())).toBe(initialVersion + 2n);

    const restored = await fileManager.getFileVersion(base, current);

    expect(restored.content.reference).toBe(firstRef);
    expect(BigInt(restored.version!.toString())).toBe(initialVersion + 2n);
  });

  it('restoring on a single version file reaffirms the head', async () => {
    const NAME = 'noop-restore';
    const base = await ensureBase(NAME);
    writeTempFile(NAME, 'B');
    await fileManager.updateFile(drive.id, base, { item: { sourcePath: NAME } });

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
    writeTempFile(NAME, 'Restore Move V0 Content');
    await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: NAME });
    const base = fileManager.recordList.at(-1)!;
    const topic = base.topic.toString();

    writeTempFile(NAME, 'Restore Move V1 Content');
    await fileManager.updateFile(drive.id, base, { item: { sourcePath: NAME } });

    await fileManager.createFolder(drive.id, ROOT_PATH, 'restore-move-dest');
    const destPath = 'restore-move-dest/restore-move-file.txt';
    await fileManager.move(NAME, destPath, drive.id);

    const v0 = await fileManager.getFileVersion(base, FEED_INDEX_ZERO);
    expect(v0.version).toBe(FEED_INDEX_ZERO.toString());

    const { feedIndex: headBeforeRestore } = await getFeedData(client, new Topic(topic), client.owner);

    await fileManager.restoreFileVersion(v0);

    const cached = fileManager.recordList.find((f) => f.topic.toString() === topic)!;
    expect(cached).toBeDefined();
    // Restoring content must not regress the tree position back to v0's own recorded path.
    expect(cached.path).toBe(destPath);

    const { feedIndex: headAfterRestore } = await retryOnPropagationDelay(async () => {
      const result = await getFeedData(client, new Topic(topic), client.owner);
      if (!(result.feedIndex.toBigInt() > headBeforeRestore.toBigInt())) {
        throw new Error('feed head has not advanced yet');
      }
      return result;
    });
    expect(headAfterRestore.toBigInt()).toBeGreaterThan(headBeforeRestore.toBigInt());

    const downloadResults = await retryOnPropagationDelay(() =>
      fileManager.downloadFolder(drive.id, 'restore-move-dest'),
    );
    const downloaded = downloadResults.find((d) => d.path === destPath);
    expect(downloaded).toBeDefined();
    expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Restore Move V0 Content');
  });
});
