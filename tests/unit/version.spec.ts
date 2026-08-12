import {
  BatchId,
  Bee,
  Bytes,
  FeedIndex,
  Identifier,
  type MantarayNode,
  PublicKey,
  RedundancyLevel,
  Topic,
} from '@ethersphere/bee-js';

import {
  createInitializedFileManager,
  DEFAULT_MOCK_SIGNER,
  DUMMY_BATCH_ID,
  getEncodedData,
  makeUploadSource,
} from '../utils';

import { applyDefaultMocks, createMockNodeAddresses, seedRecords } from './mock';

import { type FileManagerBase } from '@/fileManager';
import { type MantarayStore } from '@/mantarayStore';
import { type FileRecord, NodeType } from '@/types';
import { type FeedResultWithIndex } from '@/types/utils';
import { FileManagerEvents } from '@/utils';
import { getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, MANIFEST_METADATA_NODE_VERSION, SWARM_ZERO_ADDRESS } from '@/utils/constants';

describe('Version control', () => {
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();
  const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();
  let fm: FileManagerBase;

  const dummyTopic = Topic.fromString('deadbeef').toString();
  const dummyFi: FileRecord = {
    type: NodeType.File,
    topic: dummyTopic,
    content: { historyRef: SWARM_ZERO_ADDRESS.toString(), reference: SWARM_ZERO_ADDRESS.toString() },
    owner,
    batchId: DUMMY_BATCH_ID,
    driveId: Identifier.fromString('version-drive').toString(),
    path: 'x.txt',
    actPublisher,
    version: FeedIndex.fromBigInt(0n).toString(),
    redundancyLevel: RedundancyLevel.OFF,
  };

  beforeEach(async () => {
    applyDefaultMocks();

    fm = await createInitializedFileManager();
  });

  describe('getFileVersion', () => {
    it('calls store.getRecord with the topic and compressed actPublisher', async () => {
      const fakeFi = { ...dummyFi, version: '1' };

      const rawMock: FeedResultWithIndex = {
        feedIndex: FeedIndex.fromBigInt(1n),
        feedIndexNext: FeedIndex.fromBigInt(2n),
        payload: new Bytes(SWARM_ZERO_ADDRESS.toUint8Array()),
      };
      (getFeedData as jest.Mock).mockResolvedValue(rawMock);

      const spyFetch = jest.spyOn((fm as any).store, 'getRecord').mockResolvedValue(fakeFi);

      const got = await fm.getFileVersion(dummyFi, FeedIndex.fromBigInt(1n));

      expect(spyFetch).toHaveBeenCalledWith(
        dummyFi.topic,
        new PublicKey(actPublisher).toCompressedHex(),
        rawMock,
        { isHeadRead: false },
        undefined,
      );
      expect(got).toBe(fakeFi);

      spyFetch.mockRestore();
    });

    it('returns the cached head without a feed lookup when the requested version matches', async () => {
      const cachedVersion = FeedIndex.fromBigInt(5n).toString();
      seedRecords(fm, { ...dummyFi, version: cachedVersion });

      // Clear calls made by createInitializedFileManager()'s own bootstrap in the outer beforeEach.
      (getFeedData as jest.Mock).mockClear();

      const got = await fm.getFileVersion(dummyFi, FeedIndex.fromBigInt(5n));

      expect(got.version).toBe(cachedVersion);
      expect(getFeedData).not.toHaveBeenCalled();
    });

    it('throws if the underlying feed is missing', async () => {
      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      });

      await expect(fm.getFileVersion(dummyFi)).rejects.toThrow(
        `File feed not found for topic: ${dummyFi.topic.slice(0, 6)}`,
      );
    });

    it('stamps the passed record’s absolute path over the leaf stored in the slot', async () => {
      const storedSlot = { ...dummyFi, version: FeedIndex.fromBigInt(1n).toString(), path: 'x.txt' };
      const spyFetch = jest.spyOn((fm as any).store, 'getRecord').mockResolvedValue(storedSlot);

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(1n),
        feedIndexNext: FeedIndex.fromBigInt(2n),
        payload: new Bytes(SWARM_ZERO_ADDRESS.toUint8Array()),
      });

      const got = await fm.getFileVersion({ ...dummyFi, path: 'nested/deep/x.txt' }, FeedIndex.fromBigInt(1n));

      expect(got.path).toBe('nested/deep/x.txt');

      spyFetch.mockRestore();
    });

    it('prefers the cached head’s path, so a version fetched after a move keeps the new location', async () => {
      seedRecords(fm, { ...dummyFi, path: 'moved/x.txt', version: FeedIndex.fromBigInt(5n).toString() });

      const spyFetch = jest
        .spyOn((fm as any).store, 'getRecord')
        .mockResolvedValue({ ...dummyFi, version: FEED_INDEX_ZERO.toString(), path: 'x.txt' });

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FEED_INDEX_ZERO,
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: new Bytes(SWARM_ZERO_ADDRESS.toUint8Array()),
      });

      // An older slot than the cached head, so the cache shortcut does not apply.
      const got = await fm.getFileVersion({ ...dummyFi, path: 'stale/x.txt' }, FEED_INDEX_ZERO);

      expect(got.path).toBe('moved/x.txt');

      spyFetch.mockRestore();
    });

    it('leaves the cached head refs alone when an older version is read', async () => {
      const headRefs = { reference: 'a'.repeat(64), historyRef: 'b'.repeat(64) };
      const oldRefs = { reference: 'c'.repeat(64), historyRef: 'd'.repeat(64) };

      seedRecords(fm, { ...dummyFi, version: FeedIndex.fromBigInt(5n).toString() });
      const store = (fm as any).store as MantarayStore;
      store.setNodeRef(dummyTopic, headRefs);

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FEED_INDEX_ZERO,
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: { toJSON: () => oldRefs },
      });
      jest
        .spyOn(Bee.prototype, 'downloadData')
        .mockResolvedValue(getEncodedData(JSON.stringify({ ...dummyFi, version: FEED_INDEX_ZERO.toString() })));

      const got = await fm.getFileVersion(dummyFi, FEED_INDEX_ZERO);

      expect(got.content).toEqual(dummyFi.content);
      expect(store.getNodeRef(dummyTopic)).toEqual(headRefs);
    });

    it('refreshes the cached refs when the head itself is read', async () => {
      const staleRefs = { reference: 'a'.repeat(64), historyRef: 'b'.repeat(64) };
      const headRefs = { reference: 'c'.repeat(64), historyRef: 'd'.repeat(64) };

      const store = (fm as any).store as MantarayStore;
      store.setNodeRef(dummyTopic, staleRefs);

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(7n),
        feedIndexNext: FeedIndex.fromBigInt(8n),
        payload: { toJSON: () => headRefs },
      });
      jest
        .spyOn(Bee.prototype, 'downloadData')
        .mockResolvedValue(
          getEncodedData(JSON.stringify({ ...dummyFi, version: FeedIndex.fromBigInt(7n).toString() })),
        );

      await fm.getFileVersion(dummyFi);

      expect(store.getNodeRef(dummyTopic)).toEqual(headRefs);
    });
  });

  describe('restoreFileVersion', () => {
    it('restoring the current head is a no-op and throws', async () => {
      const head = FeedIndex.fromBigInt(5n);
      const headFi = { ...dummyFi, driveId: fm.driveList[0].id, version: head.toString() };

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: head,
        feedIndexNext: FeedIndex.fromBigInt(6n),
        payload: SWARM_ZERO_ADDRESS,
      });

      const spyEmit = jest.spyOn(fm.emitter, 'emit');

      await expect(fm.restoreFileVersion(headFi)).rejects.toThrow(
        `Head Slot cannot be restored. Please select a version lesser than: ${head.toString()}`,
      );

      expect(spyEmit).not.toHaveBeenCalledWith(FileManagerEvents.FILE_VERSION_RESTORED, expect.anything());
    });

    it('throws when the underlying feed is missing', async () => {
      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      });

      await expect(fm.restoreFileVersion({ ...dummyFi, driveId: fm.driveList[0].id, version: '2' })).rejects.toThrow(
        'Record feed not found',
      );
    });

    it('fails fast when the drive is not found, without touching the feed', async () => {
      (getFeedData as jest.Mock).mockClear();

      expect(dummyFi).toBeDefined();
      await expect(fm.restoreFileVersion({ ...dummyFi, version: '2' })).rejects.toThrow(
        `Drive with id ${dummyFi.driveId!.slice(0, 6)} not found`,
      );

      expect(getFeedData).not.toHaveBeenCalled();
    });

    it('refuses to stamp a version onto a same-named fork belonging to a different node', async () => {
      await fm.createDrive(new BatchId('4'.repeat(64)), 'Version Drive');
      const di = fm.driveList[1];
      await fm.uploadFile(di.id, { path: 'report.pdf', ...makeUploadSource('package.json') });
      const victim = fm.recordList.find((fr) => fr.path === 'report.pdf')!;

      const impostor: FileRecord = {
        ...dummyFi,
        driveId: di.id,
        topic: Topic.fromString('impostor-topic').toString(),
        path: 'report.pdf',
        version: FEED_INDEX_ZERO.toString(),
      };

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(3n),
        feedIndexNext: FeedIndex.fromBigInt(4n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });

      const saveRecordSpy = jest.spyOn((fm as any).store, 'saveRecord');

      await expect(fm.restoreFileVersion(impostor)).rejects.toThrow(/belongs to a different node/);

      // Validated before the feed write, and the victim's fork version is untouched.
      expect(saveRecordSpy).not.toHaveBeenCalled();
      const driveMantaray = (fm as any).store.getManifestCache(di.topic) as MantarayNode;
      expect(driveMantaray.find('report.pdf')?.metadata?.[MANIFEST_METADATA_NODE_VERSION]).toBe(victim.version);
    });

    it('throws when the file has no fork at its resolved path, without advancing the feed', async () => {
      await fm.createDrive(new BatchId('5'.repeat(64)), 'Ghost Drive');
      const di = fm.driveList[1];

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(3n),
        feedIndexNext: FeedIndex.fromBigInt(4n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });

      const saveRecordSpy = jest.spyOn((fm as any).store, 'saveRecord');

      await expect(
        fm.restoreFileVersion({ ...dummyFi, driveId: di.id, path: 'gone.txt', version: FEED_INDEX_ZERO.toString() }),
      ).rejects.toThrow('Path not found: gone.txt');

      expect(saveRecordSpy).not.toHaveBeenCalled();
    });
  });
});
