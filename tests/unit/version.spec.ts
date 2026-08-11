import { Bytes, FeedIndex, Identifier, PublicKey, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import { createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { applyDefaultMocks, createMockNodeAddresses, seedRecords } from './mock';

import { type FileManagerBase } from '@/fileManager';
import { type FileRecord, NodeType } from '@/types';
import { type FeedResultWithIndex } from '@/types/utils';
import { FileManagerEvents } from '@/utils';
import { getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from '@/utils/constants';

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
  });
});
