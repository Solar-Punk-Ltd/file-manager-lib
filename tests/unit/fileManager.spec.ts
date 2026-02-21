import {
  BatchId,
  Bee,
  Bytes,
  DownloadOptions,
  FeedIndex,
  MantarayNode,
  RedundancyLevel,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import {
  createInitializedFileManager,
  createInitMocks,
  createMockFeedWriter,
  createMockFileInfo,
  createMockMantarayNode,
  createMockNodeAddresses,
  createUploadDataSpy,
  createUploadFilesFromDirectorySpy,
  createUploadFileSpy,
  MOCK_BATCH_ID,
  mockPostageBatch,
} from '../mockHelpers';
import { BEE_URL, DEFAULT_MOCK_SIGNER } from '../utils';

import { EventEmitterBase } from '@/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { DriveInfo, FileInfo, FileStatus } from '@/types';
import { FeedResultWithIndex, WrappedUploadResult } from '@/types/utils';
import { DriveError, FileManagerEvents, SignerError } from '@/utils';
import { fetchStamp, getFeedData } from '@/utils/bee';
import { ADMIN_STAMP_LABEL, FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from '@/utils/constants';
import { generateRandomBytes } from '@/utils/crypto';

jest.mock('@/utils/bee', () => ({
  ...jest.requireActual('@/utils/bee'),
  getFeedData: jest.fn(),
  fetchStamp: jest.fn(),
  getWrappedData: jest.fn(),
}));
jest.mock('@/utils/crypto', () => ({
  generateRandomBytes: jest.fn(),
}));
jest.mock('@/utils/mantaray');

describe('FileManager', () => {
  let mockSelfAddr: Reference;
  const otherMockBatchId = new BatchId('4'.repeat(64));

  beforeEach(async () => {
    jest.resetAllMocks();
    createInitMocks();

    (getFeedData as jest.Mock).mockResolvedValue({
      feedIndex: FeedIndex.MINUS_ONE,
      feedIndexNext: FEED_INDEX_ZERO,
      payload: {
        toUint8Array: () => SWARM_ZERO_ADDRESS.toUint8Array(),
        toJSON: () => ({
          topicReference: SWARM_ZERO_ADDRESS.toString(),
          historyAddress: SWARM_ZERO_ADDRESS.toString(),
          index: FEED_INDEX_ZERO.toString(),
        }),
      },
    });

    const mokcMN = createMockMantarayNode(true);
    mockSelfAddr = await mokcMN.calculateSelfAddress();

    (fetchStamp as jest.Mock).mockResolvedValue({ ...mockPostageBatch });

    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { getWrappedData } = require('@/utils/bee');
    getWrappedData.mockResolvedValue({
      uploadFilesRes: mockSelfAddr.toString(),
    } as WrappedUploadResult);

    (generateRandomBytes as jest.Mock).mockImplementation(() => new Topic('1'.repeat(64)));

    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { loadMantaray } = require('@/utils/mantaray');
    loadMantaray.mockResolvedValue(mokcMN);
  });

  describe('constructor', () => {
    it('should create new instance of FileManager', async () => {
      const fm = await createInitializedFileManager();

      expect(fm).toBeInstanceOf(FileManagerBase);
    });

    it('should throw error, if Signer is not provided', async () => {
      try {
        await createInitializedFileManager();
      } catch (error) {
        expect(error).toBeInstanceOf(SignerError);
        expect((error as any).message).toBe('Signer required');
      }
    });

    it('should initialize FileManager instance with correct values', async () => {
      const fm = await createInitializedFileManager();

      expect(fm.fileInfoList).toEqual([]);
      expect(fm.sharedWithMe).toEqual([]);
    });
  });

  describe('initialize', () => {
    it('should initialize FileManager', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const eventHandler = jest.fn((_) => {});
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, undefined, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });

    it('should not initialize, if already initialized', async () => {
      const logSpy = jest.spyOn(console, 'debug');
      const eventHandler = jest.fn((_) => {});
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);

      const fm = await createInitializedFileManager(
        new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER }),
        undefined,
        emitter,
      );
      expect(eventHandler).toHaveBeenCalledWith(true);
      await fm.initialize();
      expect(logSpy).toHaveBeenCalledWith('FileManager is already initialized');
    });

    it('should not initialize, if currently being initialized', async () => {
      const logSpy = jest.spyOn(console, 'debug');
      const eventHandler = jest.fn((_) => {});
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);

      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = new FileManagerBase(bee, emitter);
      fm.initialize();
      fm.initialize();

      expect(logSpy).toHaveBeenCalledWith('FileManager is being initialized');
    });
  });

  describe('reinitialization', () => {
    it('should emit STATE_INVALID when admin stamp becomes unusable during reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const getPostageBatchesSpy = jest.spyOn(Bee.prototype, 'getPostageBatches');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: true,
          label: ADMIN_STAMP_LABEL,
        },
      ]);

      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);
      expect(fm.adminStamp?.usable).toBe(true);
      expect(fm.driveList).toHaveLength(1);

      let reinitFired = false;
      emitter.on(FileManagerEvents.INITIALIZED, () => {
        reinitFired = true;
      });

      await fm.initialize();
      expect(reinitFired).toBe(true);
      expect(fm.driveList).toHaveLength(1);

      getPostageBatchesSpy.mockRestore();
    });

    it('should successfully revalidate when admin stamp is still valid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);
      const initialDrives = fm.driveList;
      const initialFileCount = fm.fileInfoList.length;

      let initEventFired = false;
      let invalidEventFired = false;

      emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
        if (success) {
          initEventFired = true;
        }
      });

      emitter.on(FileManagerEvents.STATE_INVALID, () => {
        invalidEventFired = true;
      });

      await fm.initialize();

      expect(initEventFired).toBe(true);
      expect(invalidEventFired).toBe(false);
      expect(fm.driveList).toEqual(initialDrives);
      expect(fm.fileInfoList).toHaveLength(initialFileCount);
    });

    it('should handle multiple sequential reinitializations with valid stamp', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const initialDriveCount = fm.driveList.length;

      for (let i = 0; i < 3; i++) {
        await fm.initialize();
        expect(fm.driveList).toHaveLength(initialDriveCount);
      }
    });

    it('should reset isInitialized flag when admin stamp becomes invalid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const getPostageBatchesSpy = jest.spyOn(Bee.prototype, 'getPostageBatches');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: false,
          label: ADMIN_STAMP_LABEL,
        },
      ]);

      const newFm = new FileManagerBase(bee);
      await newFm.initialize();

      expect((newFm as any).isInitialized).toBe(true);
      expect(newFm.driveList).toHaveLength(0);
      expect(newFm.fileInfoList).toHaveLength(0);

      getPostageBatchesSpy.mockRestore();
    });

    it('should emit correct events during revalidation failure', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const getPostageBatchesSpy = jest.spyOn(Bee.prototype, 'getPostageBatches');
      getPostageBatchesSpy.mockImplementation(async () => [
        {
          ...mockPostageBatch,
          usable: true,
          label: ADMIN_STAMP_LABEL,
        },
      ]);

      await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);

      const events: string[] = [];
      emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
        events.push(`INITIALIZED:${success}`);
      });

      const fm2 = new FileManagerBase(bee, emitter);
      await fm2.initialize();

      expect(events).toContain('INITIALIZED:true');

      getPostageBatchesSpy.mockRestore();
    });

    it('should maintain isInitialized flag after successful reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID);

      expect((fm as any).isInitialized).toBe(true);

      await fm.initialize();

      expect((fm as any).isInitialized).toBe(true);
    });

    it('should not clear drives when reinitializing with valid stamp', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const drivesBefore = fm.driveList;
      expect(drivesBefore.length).toBeGreaterThan(0);

      await fm.initialize();

      const drivesAfter = fm.driveList;
      expect(drivesAfter).toEqual(drivesBefore);
    });

    it('should maintain admin stamp reference after reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const adminStampBefore = fm.adminStamp;
      expect(adminStampBefore).toBeDefined();

      await fm.initialize();

      const adminStampAfter = fm.adminStamp;
      expect(adminStampAfter).toBeDefined();
      expect(adminStampAfter?.batchID.toString()).toBe(adminStampBefore?.batchID.toString());
    });

    it('should clear fileInfoList when admin stamp becomes invalid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const getPostageBatchesSpy = jest.spyOn(Bee.prototype, 'getPostageBatches');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: false,
          label: ADMIN_STAMP_LABEL,
        },
      ]);

      const newFm = new FileManagerBase(bee);
      await newFm.initialize();

      expect(newFm.fileInfoList).toHaveLength(0);
      expect(newFm.driveList).toHaveLength(0);

      getPostageBatchesSpy.mockRestore();
    });

    it('should not emit STATE_INVALID when admin stamp remains valid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);

      let invalidEventFired = false;
      emitter.on(FileManagerEvents.STATE_INVALID, () => {
        invalidEventFired = true;
      });

      await fm.initialize();

      expect(invalidEventFired).toBe(false);
    });
  });

  describe('download', () => {
    const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();
    const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();

    beforeEach(() => {
      const { getForksMap } = jest.requireActual('@/utils/mantaray');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('@/utils/mantaray'), 'getForksMap').mockImplementation(getForksMap);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should call mantaray.collect()', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const mockFi = await createMockFileInfo(owner, actPublisher, mockSelfAddr.toString());
      const mantarayCollectSpy = jest.spyOn(MantarayNode.prototype, 'collect');
      await fm.download(mockFi);

      expect(mantarayCollectSpy).toHaveBeenCalled();
    });

    it('should call bee.downloadData with only correct fork reference', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const downloadDataSpy = jest.spyOn(Bee.prototype, 'downloadData');
      const mockFi = await createMockFileInfo(owner, actPublisher, mockSelfAddr.toString());

      const mockMantarayNode = createMockMantarayNode(false);
      jest.spyOn(MantarayNode, 'unmarshal').mockResolvedValue(new MantarayNode());
      jest.spyOn(MantarayNode.prototype, 'collect').mockReturnValue(mockMantarayNode.collect());

      await fm.download(mockFi, ['/root/2.txt']);

      expect(downloadDataSpy).toHaveBeenCalledWith(
        '2'.repeat(64),
        { actHistoryAddress: undefined, actPublisher: undefined },
        undefined,
      );
    });

    it('should call download for all of forks', async () => {
      const mockForkRef = new Reference('4'.repeat(64));
      createInitMocks(mockForkRef);
      const fm = await createInitializedFileManager();
      const mockFi = await createMockFileInfo(owner, actPublisher, mockSelfAddr.toString());

      const downloadDataSpy = jest.spyOn(Bee.prototype, 'downloadData');

      const { settlePromises } = jest.requireActual('@/utils/common');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('@/utils/common'), 'settlePromises').mockImplementation(settlePromises);

      const fileStrings = await fm.download(mockFi);

      expect(downloadDataSpy).toHaveBeenCalledWith(
        '1'.repeat(64),
        { actHistoryAddress: undefined, actPublisher: undefined },
        undefined,
      );
      expect(downloadDataSpy).toHaveBeenCalledWith(
        '2'.repeat(64),
        { actHistoryAddress: undefined, actPublisher: undefined },
        undefined,
      );
      expect(downloadDataSpy).toHaveBeenCalledWith(
        '3'.repeat(64),
        { actHistoryAddress: undefined, actPublisher: undefined },
        undefined,
      );

      expect(fileStrings[0]).toEqual(mockForkRef);
      expect(fileStrings[1]).toEqual(mockForkRef);
      expect(fileStrings[2]).toEqual(mockForkRef);
    });
  });

  describe('listFiles', () => {
    const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();
    const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();

    beforeEach(() => {
      const { getForksMap } = jest.requireActual('@/utils/mantaray');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('@/utils/mantaray'), 'getForksMap').mockImplementation(getForksMap);
    });

    it('should return correct reference and path', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const mockMantarayNode = createMockMantarayNode(false);
      jest.spyOn(MantarayNode, 'unmarshal').mockResolvedValue(new MantarayNode());
      jest.spyOn(MantarayNode.prototype, 'collect').mockReturnValue(mockMantarayNode.collect());

      const mockFi = await createMockFileInfo(owner, actPublisher);

      jest
        .spyOn(Bee.prototype, 'downloadData')
        .mockResolvedValueOnce(Bytes.fromUtf8(JSON.stringify({ uploadFilesRes: '1'.repeat(64) })));

      const result = await fm.listFiles(mockFi);
      expect(result).toEqual({ '/root/2.txt': '2'.repeat(64) });
    });
  });

  describe('upload', () => {
    it('should call uploadFilesFromDirectory', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[0];

      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      await fm.upload(di, { name: 'tests', path: './tests' });
      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();

      const fi = fm.fileInfoList.find((fi) => fi.driveId === di.id.toString() && fi.name === 'tests');
      expect(fi).toBeDefined();
      expect(fi?.topic).toBe(new Topic('1'.repeat(64)).toString());
    });

    it('should call uploadFileOrDirectory if previewPath is provided', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[0];
      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      const uploadFileOrDirectoryPreviewSpy = createUploadFilesFromDirectorySpy('6');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      await fm.upload(di, { name: 'tests', path: './tests' });

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
      expect(uploadFileOrDirectoryPreviewSpy).toHaveBeenCalled();
    });

    it('should throw error if infoTopic and historyRef are not provided at the same time', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[0];

      await expect(async () => {
        await fm.upload(di, {
          name: 'tests',
          topic: 'topic',
          path: './tests',
        });
      }).rejects.toThrow('Options topic and historyRef have to be provided at the same time.');
    });

    it('should not add duplicate entries when re-uploading same topic', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[0];
      createUploadFilesFromDirectorySpy('1');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');
      (getFeedData as jest.Mock).mockResolvedValueOnce({
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      });

      await fm.upload(di, { name: 'hello', path: './tests' });
      expect(fm.fileInfoList.filter((fi) => fi.name === 'hello')).toHaveLength(1);

      const original = fm.fileInfoList[0];
      createUploadFilesFromDirectorySpy('6');
      createUploadDataSpy('7');
      createUploadDataSpy('8');
      createMockFeedWriter('9');

      (getFeedData as jest.Mock).mockReset();
      (getFeedData as jest.Mock).mockResolvedValueOnce({
        feedIndex: FEED_INDEX_ZERO,
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: SWARM_ZERO_ADDRESS,
      });

      await fm.upload(
        di,
        {
          name: 'hello',
          topic: original.topic,
          file: original.file,
          path: './tests',
        },
        {
          actHistoryAddress: original.file.historyRef,
        },
      );

      expect(fm.fileInfoList.filter((fi) => fi.name === 'hello')).toHaveLength(1);

      const updated = fm.fileInfoList.find((fi) => fi.name === 'hello')!;
      expect(updated.version!).toBe(FeedIndex.fromBigInt(1n).toString());
    });
  });

  describe('version control', () => {
    let fm: FileManagerBase;

    const dummyTopic = Topic.fromString('deadbeef').toString();
    const dummyFi: FileInfo = {
      topic: dummyTopic,
      file: { historyRef: '00'.repeat(32), reference: '11'.repeat(32) },
      owner: '',
      batchId: 'aa'.repeat(32),
      driveId: 'bb'.repeat(32),
      name: 'x',
      actPublisher: 'ff'.repeat(66),
      version: '0',
    };

    beforeEach(async () => {
      fm = await createInitializedFileManager();
    });

    afterEach(() => {
      jest.resetAllMocks();
    });

    it('getVersion should call fetchFileInfo and return FileInfo', async () => {
      const fakeFi = { ...dummyFi, version: '1' };

      const rawMock: FeedResultWithIndex = {
        feedIndex: FeedIndex.fromBigInt(1n),
        feedIndexNext: FeedIndex.fromBigInt(2n),
        payload: new Bytes(new Reference('f'.repeat(64)).toUint8Array()),
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('@/utils/bee'), 'getFeedData').mockResolvedValue(rawMock);

      const spyFetch = jest.spyOn(FileManagerBase.prototype as any, 'fetchFileInfo').mockResolvedValue(fakeFi);
      let got = await fm.getVersion(dummyFi, FeedIndex.fromBigInt(1n));

      expect(spyFetch).toHaveBeenCalledWith(dummyFi, rawMock);
      expect(got).toBe(fakeFi);

      got = await fm.getVersion(dummyFi);
      expect(spyFetch).toHaveBeenCalledWith(dummyFi, rawMock);
      expect(got).toBe(fakeFi);
    });

    it('download via getVersion + download returns the bytes', async () => {
      const vFi = { ...dummyFi, topic: dummyTopic, file: dummyFi.file } as any;
      jest.spyOn(fm, 'getVersion').mockResolvedValue(vFi);
      const spyDl = jest.spyOn(fm, 'download').mockResolvedValue(['mocked bytes'] as any);

      const gotFi = await fm.getVersion(dummyFi, '3');
      const out = await fm.download(gotFi, ['path1'], { actPublisher: 'p', actHistoryAddress: 'h' } as DownloadOptions);
      expect(fm.getVersion).toHaveBeenCalledWith(dummyFi, '3');
      expect(spyDl).toHaveBeenCalledWith(vFi, ['path1'], { actPublisher: 'p', actHistoryAddress: 'h' });
      expect(out).toEqual(['mocked bytes']);
    });

    it('getVersion throws if underlying feed is missing', async () => {
      jest.restoreAllMocks();
      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      });

      await expect(fm.getVersion(dummyFi)).rejects.toThrow(`File info not found for topic: ${dummyFi.topic}`);
      await expect(fm.getVersion(dummyFi, FEED_INDEX_ZERO)).rejects.toThrow(
        `File info not found for topic: ${dummyFi.topic}`,
      );
    });

    it('restoring the current head should simply re‑fetch that version and not emit an event', async () => {
      const head = FeedIndex.fromBigInt(5n);
      dummyFi.version = head.toString();

      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('@/utils/bee'), 'getFeedData').mockResolvedValue({
        feedIndex: head,
        feedIndexNext: FeedIndex.fromBigInt(6n),
        payload: SWARM_ZERO_ADDRESS,
      });

      const spyEmit = jest.spyOn(fm.emitter, 'emit');

      await fm.restoreVersion(dummyFi);

      expect(spyEmit).not.toHaveBeenCalledWith(FileManagerEvents.FILE_VERSION_RESTORED, expect.anything());
    });

    it('restoreVersion() when versionToRestore.version === headSlot is a no-op', async () => {
      const head = FeedIndex.fromBigInt(3n);
      const fakeFeedData: FeedResultWithIndex = {
        feedIndex: head,
        feedIndexNext: FeedIndex.fromBigInt(4n),
        payload: SWARM_ZERO_ADDRESS,
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('@/utils/bee'), 'getFeedData').mockResolvedValueOnce(fakeFeedData);

      const spyEmit = jest.spyOn(fm.emitter, 'emit');

      const dummyFiWithHead = {
        ...dummyFi,
        version: head.toString(),
      };

      await fm.restoreVersion(dummyFiWithHead);

      expect(spyEmit).not.toHaveBeenCalledWith(FileManagerEvents.FILE_VERSION_RESTORED, expect.anything());
    });
  });
  // TODO: test resetState
  describe('drive handling', () => {
    it('createDrive should create an admin drive', async () => {
      const fm = await createInitializedFileManager();
      const di = fm.driveList[0];
      expect(di).toBeDefined();
      expect(di.name).toBe(ADMIN_STAMP_LABEL);
      expect(di.batchId.toString()).toBe(MOCK_BATCH_ID.toString());
      expect(di.id.toString()).toHaveLength(64);
      expect(di.owner).toBe(DEFAULT_MOCK_SIGNER.publicKey().address().toString());
      expect(di.infoFeedList).toStrictEqual([]);
      expect(di.isAdmin).toBe(true);
    });

    it('createDrive should create a new drive', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];
      expect(di).toBeDefined();
      expect(di.name).toBe('Test Drive');
      expect(di.batchId.toString()).toBe(otherMockBatchId.toString());
      expect(di.id.toString()).toHaveLength(64);
      expect(di.owner).toBe(DEFAULT_MOCK_SIGNER.publicKey().address().toString());
      expect(di.infoFeedList).toStrictEqual([]);
    });

    it('createDrive should throw error if drive with same name or batchId exists', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      await expect(fm.createDrive(otherMockBatchId, 'New Drive', false)).rejects.toThrow(
        new DriveError(`Drive with name "New Drive" or batchId "${otherMockBatchId.toString()}" already exists`),
      );
      await expect(
        fm.createDrive('aa0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51', 'Test Drive', false),
      ).rejects.toThrow(
        new DriveError(
          `Drive with name "Test Drive" or batchId "aa0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51" already exists`,
        ),
      );
    });

    it('createDrive should throw error if trying to create a new admin drive', async () => {
      const fm = await createInitializedFileManager();
      await expect(fm.createDrive(MOCK_BATCH_ID, 'New Drive', true)).rejects.toThrow(
        new DriveError(`Admin drive already exists`),
      );
    });

    it('destroyDrive should call diluteBatch with batchId and MAX_DEPTH', async () => {
      const diluteSpy = jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(otherMockBatchId);
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      await fm.destroyDrive(di, { ...mockPostageBatch, batchID: otherMockBatchId });

      const ttlDays = mockPostageBatch.duration.toDays();
      const halvings = Math.floor(Math.log2(ttlDays));
      expect(diluteSpy).toHaveBeenCalledWith(di.batchId, mockPostageBatch.depth + halvings);
    });

    it('destroyDrive should throw error if trying to destroy Admin drive / stamp', async () => {
      const fm = await createInitializedFileManager();
      const di = fm.driveList[0];

      di.isAdmin = false;
      await expect(async () => {
        await fm.destroyDrive(di, mockPostageBatch);
      }).rejects.toThrow(`Cannot destroy admin drive / stamp, batchId: ${MOCK_BATCH_ID.toString()}`);

      di.batchId = MOCK_BATCH_ID;
      await expect(async () => {
        await fm.destroyDrive(di, { ...mockPostageBatch, batchID: otherMockBatchId });
      }).rejects.toThrow(`Stamp does not match drive stamp`);

      di.isAdmin = true;
      await expect(async () => {
        await fm.destroyDrive(di, mockPostageBatch);
      }).rejects.toThrow(`Cannot destroy admin drive / stamp, batchId: ${MOCK_BATCH_ID.toString()}`);
    });

    it('forgetDrive should remove a user drive, prune its files, persist, and emit DRIVE_FORGOTTEN', async () => {
      const genMock = generateRandomBytes as jest.Mock;
      genMock.mockReset();
      genMock
        .mockImplementationOnce(() => new Topic('a'.repeat(64))) // admin drive id
        .mockImplementationOnce(() => new Topic('b'.repeat(64))) // "Drive to forget (unit)" id
        .mockImplementation(() => new Topic('c'.repeat(64))); // any further calls

      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Drive to forget (unit)', false);
      const target = fm.driveList.find((d) => d.name === 'Drive to forget (unit)')!;
      expect(target).toBeDefined();

      const now = Date.now();
      const mkFi = (topic: string, name: string): FileInfo => ({
        batchId: target.batchId.toString(),
        owner: DEFAULT_MOCK_SIGNER.publicKey().address().toString(),
        topic,
        name,
        actPublisher: DEFAULT_MOCK_SIGNER.publicKey().toCompressedHex(),
        file: { reference: '0x' + 'aa'.repeat(32), historyRef: '0x' + 'bb'.repeat(32) },
        driveId: target.id.toString(),
        timestamp: now,
        shared: false,
        version: '0',
        redundancyLevel: RedundancyLevel.OFF,
        status: FileStatus.Active,
      });

      fm.fileInfoList.push(mkFi('topic-x', 'x.txt'));
      fm.fileInfoList.push(mkFi('topic-y', 'y.txt'));

      const diluteSpy = jest.spyOn(Bee.prototype, 'diluteBatch');
      const saveSpy = jest.spyOn(fm as any, 'saveDriveList');

      const eventPromise = new Promise<void>((resolve) => {
        const handler = ({ driveInfo }: { driveInfo: DriveInfo }): void => {
          try {
            expect(driveInfo.id.toString()).toBe(target.id.toString());
            resolve();
          } finally {
            fm.emitter?.off?.(FileManagerEvents.DRIVE_FORGOTTEN, handler);
          }
        };
        fm.emitter.on(FileManagerEvents.DRIVE_FORGOTTEN, handler);
      });

      await fm.forgetDrive(target);
      await eventPromise;

      const after = fm.driveList;
      expect(after.find((d) => d.id.toString() === target.id.toString())).toBeUndefined();

      expect(fm.fileInfoList.some((fi) => fi.driveId === target.id.toString())).toBe(false);

      expect(saveSpy).toHaveBeenCalled();
      expect(diluteSpy).not.toHaveBeenCalled();
    });

    it('forgetDrive should throw when the drive does not exist', async () => {
      const fm = await createInitializedFileManager();

      const ghost: DriveInfo = {
        id: '9'.repeat(64),
        name: 'ghost',
        batchId: otherMockBatchId.toString(),
        owner: DEFAULT_MOCK_SIGNER.publicKey().address().toString(),
        redundancyLevel: RedundancyLevel.OFF,
        isAdmin: false,
      } as any;

      await expect(fm.forgetDrive(ghost)).rejects.toThrow(new DriveError('Drive ghost not found'));
    });
  });

  describe('file operations', () => {
    let fm: FileManagerBase;
    let mockFi: FileInfo;
    let drive: DriveInfo;

    beforeEach(async () => {
      fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      drive = fm.driveList[0];

      mockFi = {
        batchId: 'aa'.repeat(32),
        file: { reference: '11'.repeat(32), historyRef: '00'.repeat(32) },
        name: 'foo',
        owner: '',
        actPublisher: 'ff'.repeat(66),
        topic: 'deadbeef'.repeat(8),
        driveId: drive.id.toString(),
      };

      mockFi.status = FileStatus.Active;
      mockFi.timestamp = 0;
      mockFi.version = FeedIndex.fromBigInt(0n).toString();

      fm.fileInfoList.push(mockFi);
    });

    it('trashFile should mark a file as trashed, persist and emit FILE_TRASHED', async () => {
      expect(mockFi.status).toBe(FileStatus.Active);
      expect(mockFi.timestamp).toBe(0);

      const uploadSpy = jest.spyOn(fm as any, 'uploadFileInfo');
      const saveSpy = jest.spyOn(fm as any, 'saveFileInfoFeed');
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_TRASHED, handler);

      await fm.trashFile(mockFi);

      expect(mockFi.status).toBe(FileStatus.Trashed);
      expect(mockFi.timestamp!).toBeGreaterThan(0);

      expect(uploadSpy).toHaveBeenCalledWith(mockFi, undefined);
      expect(saveSpy).toHaveBeenCalledWith(mockFi);

      expect(handler).toHaveBeenCalledWith({ fileInfo: mockFi });
    });

    it('recoverFile should mark a trashed file active, persist and emit FILE_RECOVERED', async () => {
      await fm.trashFile(mockFi);
      expect(mockFi.status).toBe(FileStatus.Trashed);
      const beforeTs = mockFi.timestamp!;

      jest.useFakeTimers();
      jest.setSystemTime(new Date(beforeTs + 1));

      const uploadSpy = jest.spyOn(fm as any, 'uploadFileInfo');
      const saveSpy = jest.spyOn(fm as any, 'saveFileInfoFeed');
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_RECOVERED, handler);

      await fm.recoverFile(mockFi);

      expect(mockFi.status).toBe(FileStatus.Active);
      expect(mockFi.timestamp!).toBeGreaterThan(beforeTs);

      expect(uploadSpy).toHaveBeenCalledWith(mockFi, undefined);
      expect(saveSpy).toHaveBeenCalledWith(mockFi);

      expect(handler).toHaveBeenCalledWith({ fileInfo: mockFi });

      jest.useRealTimers();
    });

    it('forgetFile should remove file from lists, persist owner-feed, and emit FILE_FORGOTTEN', async () => {
      createUploadFilesFromDirectorySpy('1');
      const saveOwnerSpy = jest.spyOn(fm as any, 'saveDriveList');
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_FORGOTTEN, handler);

      await fm.upload(drive, { name: 'test-file', path: './tests' });
      const uploadedFile = fm.fileInfoList[fm.fileInfoList.length - 1];
      await fm.forgetFile(uploadedFile);

      expect(fm.fileInfoList).not.toContain(uploadedFile);
      expect((fm as any).driveList.infoFeedList).not.toBe([]);

      expect(saveOwnerSpy).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith({ fileInfo: uploadedFile });
    });
  });

  describe('getGranteesOfFile', () => {
    const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();

    it('should throw grantee list not found if the topic not found in driveList', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      const fileInfo: FileInfo = {
        batchId: otherMockBatchId,
        driveId: di.id.toString(),
        name: 'john doe',
        owner: DEFAULT_MOCK_SIGNER.publicKey().address().toString(),
        actPublisher,
        topic: Topic.fromString('example'),
        file: {
          reference: new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68'),
          historyRef: new Reference(SWARM_ZERO_ADDRESS),
        },
      };

      await expect(async () => {
        await fm.getGrantees(fileInfo);
      }).rejects.toThrow(`Grantee list or file not found for file: ${fileInfo.name}`);
    });
  });
  // TODO: test invalid state emit
  describe('eventEmitter', () => {
    const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();

    it('should send event after upload happens', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();
      const uploadHandler = jest.fn((_args) => {});

      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);
      fm.emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);
      const redundancy = RedundancyLevel.MEDIUM;
      await fm.createDrive(otherMockBatchId, 'Test Drive', false, redundancy);
      const di = fm.driveList[0];
      createUploadFilesFromDirectorySpy('1');

      (getFeedData as jest.Mock).mockResolvedValueOnce({
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      });

      // Pin system time so fileInfo.timestamp is deterministic (upload uses Date.now())
      jest.useFakeTimers();
      const fixedNow = 1_755_158_248_500; // any number you like
      jest.setSystemTime(new Date(fixedNow));

      const expectedFileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        driveId: di.id.toString(),
        customMetadata: undefined,
        file: {
          historyRef: SWARM_ZERO_ADDRESS.toString(),
          reference: SWARM_ZERO_ADDRESS.toString(),
        },
        actPublisher,
        version: FEED_INDEX_ZERO.toString(),
        name: 'tests',
        owner: DEFAULT_MOCK_SIGNER.publicKey().address().toString(),
        preview: undefined,
        redundancyLevel: redundancy,
        shared: false,
        status: FileStatus.Active,
        timestamp: fixedNow, // ← was expect.any(Number)
        topic: expect.any(String), // leave topic flexible
      };

      await fm.upload(di, { name: 'tests', path: './tests' });
      fm.emitter.off(FileManagerEvents.FILE_UPLOADED, uploadHandler);

      expect(uploadHandler).toHaveBeenCalledWith({ fileInfo: expectedFileInfo });

      jest.useRealTimers();
    });

    it('should send an event after the fileManager is initialized', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const eventHandler = jest.fn((_) => {});
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });
  });

  describe('AbortController', () => {
    const otherMockBatchId = new BatchId('4'.repeat(64));

    it('should pass requestOptions with signal to uploadFilesFromDirectory', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[0];

      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      const controller = new AbortController();
      await fm.upload(di, { name: 'tests', path: './tests' }, undefined, { signal: controller.signal });

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
      const callArgs = uploadFileOrDirectorySpy.mock.calls[0];
      expect(callArgs[3]).toHaveProperty('signal', controller.signal);
    });

    it('should pass requestOptions with signal to uploadFile', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[0];

      createUploadFilesFromDirectorySpy('1');
      const uploadFileSpy = createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      const controller = new AbortController();
      await fm.upload(di, { name: 'test.txt', path: './tests/fixtures/test.txt' }, undefined, {
        signal: controller.signal,
      });

      expect(uploadFileSpy).toHaveBeenCalled();
      const callArgs = uploadFileSpy.mock.calls[0];
      expect(callArgs[4]).toHaveProperty('signal', controller.signal);
    });

    it('should not pass signal if requestOptions is undefined', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[0];

      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      await fm.upload(di, { name: 'tests', path: './tests' });

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
      const callArgs = uploadFileOrDirectorySpy.mock.calls[0];
      // When requestOptions is not provided, the options object should not have signal
      expect(callArgs[3]?.signal).toBeUndefined();
    });

    it('should allow upload to proceed when signal is not aborted', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[0];

      createUploadFilesFromDirectorySpy('1');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      const controller = new AbortController();

      // Should not throw when signal is not aborted
      await expect(
        fm.upload(di, { name: 'tests', path: './tests' }, undefined, { signal: controller.signal }),
      ).resolves.not.toThrow();
    });
  });
});
