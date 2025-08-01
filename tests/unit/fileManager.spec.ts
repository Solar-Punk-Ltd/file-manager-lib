import {
  BatchId,
  Bee,
  Bytes,
  DownloadOptions,
  FeedIndex,
  MantarayNode,
  Reference,
  STAMPS_DEPTH_MAX,
  Topic,
} from '@ethersphere/bee-js';

import { FileManagerBase } from '../../src/fileManager';
import { getFeedData } from '../../src/utils/common';
import { FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { SignerError } from '../../src/utils/errors';
import { EventEmitterBase } from '../../src/utils/eventEmitter';
import { FileManagerEvents } from '../../src/utils/events';
import { FeedPayloadResult, FileInfo, WrappedUploadResult } from '../../src/utils/types';
import {
  createInitializedFileManager,
  createInitMocks,
  createMockFeedWriter,
  createMockFileInfo,
  createMockMantarayNode,
  createUploadDataSpy,
  createUploadFilesFromDirectorySpy,
  createUploadFileSpy,
  MOCK_BATCH_ID,
} from '../mockHelpers';
import { BEE_URL, MOCK_SIGNER } from '../utils';

jest.mock('../../src/utils/common', () => ({
  ...jest.requireActual('../../src/utils/common'),
  getFeedData: jest.fn(),
  getWrappedData: jest.fn(),
  generateTopic: jest.fn(),
}));
jest.mock('../../src/utils/mantaray');

describe('FileManager', () => {
  let mockSelfAddr: Reference;

  beforeEach(async () => {
    jest.resetAllMocks();
    createInitMocks();

    (getFeedData as jest.Mock).mockResolvedValue({
      feedIndex: FEED_INDEX_ZERO,
      feedIndexNext: FeedIndex.fromBigInt(1n),
      payload: {
        toUint8Array: () => SWARM_ZERO_ADDRESS.toUint8Array(),
        toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
      },
    });

    const mokcMN = createMockMantarayNode(true);
    mockSelfAddr = await mokcMN.calculateSelfAddress();

    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { generateTopic, getWrappedData } = require('../../src/utils/common');
    getWrappedData.mockResolvedValue({
      uploadFilesRes: mockSelfAddr.toString(),
    } as WrappedUploadResult);
    generateTopic.mockReturnValue(new Topic('1'.repeat(64)));

    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { loadMantaray } = require('../../src/utils/mantaray');
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
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const eventHandler = jest.fn((_) => {});
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });

    it('should not initialize, if already initialized', async () => {
      const logSpy = jest.spyOn(console, 'debug');
      const eventHandler = jest.fn((_) => {});
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);

      const fm = await createInitializedFileManager(new Bee(BEE_URL, { signer: MOCK_SIGNER }), emitter);
      expect(eventHandler).toHaveBeenCalledWith(true);
      await fm.initialize();
      expect(logSpy).toHaveBeenCalledWith('FileManager is already initialized');
    });

    it('should not initialize, if currently being initialized', async () => {
      const logSpy = jest.spyOn(console, 'debug');
      const eventHandler = jest.fn((_) => {});
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);

      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManagerBase(bee, emitter);
      fm.initialize();
      fm.initialize();

      expect(logSpy).toHaveBeenCalledWith('FileManager is being initialized');
    });
  });

  describe('download', () => {
    beforeEach(() => {
      const { getForkAddresses } = jest.requireActual('../../src/utils/mantaray');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/mantaray'), 'getForkAddresses').mockImplementation(getForkAddresses);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should call mantaray.collect()', async () => {
      createInitMocks();
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee);
      const mockFi = await createMockFileInfo(bee, mockSelfAddr.toString());
      const mantarayCollectSpy = jest.spyOn(MantarayNode.prototype, 'collect');
      await fm.download(mockFi);

      expect(mantarayCollectSpy).toHaveBeenCalled();
    });

    it('should call bee.downloadData with only correct fork reference', async () => {
      createInitMocks();
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee);
      const downloadDataSpy = jest.spyOn(Bee.prototype, 'downloadData');
      const mockFi = await createMockFileInfo(bee, mockSelfAddr.toString());

      const mockMantarayNode = createMockMantarayNode(false);
      jest.spyOn(MantarayNode, 'unmarshal').mockResolvedValue(new MantarayNode());
      jest.spyOn(MantarayNode.prototype, 'collect').mockReturnValue(mockMantarayNode.collect());

      await fm.download(mockFi, ['/root/2.txt']);

      expect(downloadDataSpy).toHaveBeenCalledWith('2'.repeat(64), undefined);
    });

    it('should call download for all of forks', async () => {
      const mockForkRef = new Reference('4'.repeat(64));
      createInitMocks(mockForkRef);
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee);
      const mockFi = await createMockFileInfo(bee, mockSelfAddr.toString());

      const downloadDataSpy = jest.spyOn(Bee.prototype, 'downloadData');

      const { settlePromises } = jest.requireActual('../../src/utils/common');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/common'), 'settlePromises').mockImplementation(settlePromises);

      const fileStrings = await fm.download(mockFi);

      expect(downloadDataSpy).toHaveBeenCalledWith('1'.repeat(64), undefined);
      expect(downloadDataSpy).toHaveBeenCalledWith('2'.repeat(64), undefined);
      expect(downloadDataSpy).toHaveBeenCalledWith('3'.repeat(64), undefined);

      expect(fileStrings[0]).toEqual(mockForkRef);
      expect(fileStrings[1]).toEqual(mockForkRef);
      expect(fileStrings[2]).toEqual(mockForkRef);
    });
  });

  describe('listFiles', () => {
    it('should return correct ReferenceWithPath', async () => {
      createInitMocks();
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee);
      const mockMantarayNode = createMockMantarayNode(false);
      jest.spyOn(MantarayNode, 'unmarshal').mockResolvedValue(new MantarayNode());
      jest.spyOn(MantarayNode.prototype, 'collect').mockReturnValue(mockMantarayNode.collect());

      const mockFi = await createMockFileInfo();

      jest
        .spyOn(Bee.prototype, 'downloadData')
        .mockResolvedValueOnce(Bytes.fromUtf8(JSON.stringify({ uploadFilesRes: '1'.repeat(64) })));
      const result = await fm.listFiles(mockFi);
      expect(result).toEqual([
        {
          path: '/root/2.txt',
          reference: new Reference('2'.repeat(64)),
        },
      ]);
    });
  });

  describe('upload', () => {
    it('should call uploadFilesFromDirectory', async () => {
      const fm = await createInitializedFileManager();
      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      await fm.upload({ info: { batchId: new BatchId(MOCK_BATCH_ID), name: 'tests' }, path: './tests' });
      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
    });

    it('should call uploadFileOrDirectory if previewPath is provided', async () => {
      const fm = await createInitializedFileManager();
      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      const uploadFileOrDirectoryPreviewSpy = createUploadFilesFromDirectorySpy('6');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      await fm.upload({ info: { batchId: new BatchId(MOCK_BATCH_ID), name: 'tests' }, path: './tests' });

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
      expect(uploadFileOrDirectoryPreviewSpy).toHaveBeenCalled();
    });

    it('should throw error if infoTopic and historyRef are not provided at the same time', async () => {
      const fm = await createInitializedFileManager();

      await expect(async () => {
        await fm.upload({
          info: {
            batchId: new BatchId(MOCK_BATCH_ID),
            name: 'tests',
            topic: 'topic',
          },
          path: './tests',
        });
      }).rejects.toThrow('Options topic and historyRef have to be provided at the same time.');
    });
  });

  describe('version control', () => {
    let fm: FileManagerBase;

    const dummyTopic = Topic.fromString('deadbeef').toString();
    const dummyFi = {
      topic: dummyTopic,
      file: { historyRef: '00'.repeat(32), reference: '11'.repeat(32) },
      owner: '',
      batchId: { toString: () => 'aa'.repeat(32) },
      name: 'x',
      actPublisher: 'ff'.repeat(66),
      version: '0',
    } as FileInfo;

    beforeEach(async () => {
      fm = await createInitializedFileManager();
    });

    afterEach(() => {
      jest.resetAllMocks();
    });

    it('getVersion should call fetchFileInfo and return FileInfo', async () => {
      const fakeFi = { ...dummyFi, version: '1' };

      const rawMock: FeedPayloadResult = {
        feedIndex: FeedIndex.fromBigInt(1n),
        feedIndexNext: FeedIndex.fromBigInt(2n),
        reference: new Bytes(new Reference('f'.repeat(64)).toUint8Array()),
      } as any;
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/common'), 'getFeedData').mockResolvedValue(rawMock);

      const spyFetch = jest.spyOn(FileManagerBase.prototype as any, 'fetchFileInfo').mockResolvedValue(fakeFi);
      let got = await fm.getVersion(dummyFi, FeedIndex.fromBigInt(1n));

      expect(spyFetch).toHaveBeenCalledWith(dummyFi, rawMock, true);
      expect(got).toBe(fakeFi);

      got = await fm.getVersion(dummyFi);
      expect(spyFetch).toHaveBeenCalledWith(dummyFi, rawMock, false);
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
      jest.spyOn(require('../../src/utils/common'), 'getFeedData').mockResolvedValue({
        feedIndex: head,
        feedIndexNext: FeedIndex.fromBigInt(6n),
        payload: SWARM_ZERO_ADDRESS,
      } as any);

      const spyEmit = jest.spyOn(fm.emitter, 'emit');

      await fm.restoreVersion(dummyFi);

      expect(spyEmit).not.toHaveBeenCalledWith(FileManagerEvents.FILE_VERSION_RESTORED, expect.anything());
    });

    it('restoreVersion() when versionToRestore.version === headSlot is a no-op', async () => {
      const head = FeedIndex.fromBigInt(3n);
      const fakeFeedData = {
        feedIndex: head,
        feedIndexNext: FeedIndex.fromBigInt(4n),
        reference: SWARM_ZERO_ADDRESS,
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/common'), 'getFeedData').mockResolvedValueOnce(fakeFeedData as any);

      const spyEmit = jest.spyOn(fm.emitter, 'emit');

      const dummyFiWithHead = {
        ...dummyFi,
        version: head.toString(),
      };

      await fm.restoreVersion(dummyFiWithHead);

      expect(spyEmit).not.toHaveBeenCalledWith(FileManagerEvents.FILE_VERSION_RESTORED, expect.anything());
    });
  });

  describe('destroyVolume', () => {
    it('should call diluteBatch with batchId and MAX_DEPTH', async () => {
      const diluteSpy = jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(new BatchId('1234'.repeat(16)));
      const fm = await createInitializedFileManager();

      await fm.destroyVolume(new BatchId('1234'.repeat(16)));

      expect(diluteSpy).toHaveBeenCalledWith(new BatchId('1234'.repeat(16)), STAMPS_DEPTH_MAX);
    });

    it('should throw error if trying to destroy OwnerFeedStamp', async () => {
      const batchId = new BatchId('3456'.repeat(16));
      jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(new BatchId('1234'.repeat(16)));
      const fm = await createInitializedFileManager();

      await expect(async () => {
        await fm.destroyVolume(batchId);
      }).rejects.toThrow(`Cannot destroy owner stamp, batchId: ${batchId.toString()}`);
    });
  });

  describe('getGranteesOfFile', () => {
    it('should throw grantee list not found if the topic not found in ownerFeedList', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee);

      const actPublisher = (await bee.getNodeAddresses()).publicKey.toCompressedHex();
      const fileInfo = {
        batchId: new BatchId(MOCK_BATCH_ID),
        name: 'john doe',
        owner: MOCK_SIGNER.publicKey().address().toString(),
        actPublisher,
        topic: Topic.fromString('example'),
        file: {
          reference: new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68'),
          historyRef: new Reference(SWARM_ZERO_ADDRESS),
        },
      } as FileInfo;

      await expect(async () => {
        await fm.getGrantees(fileInfo);
      }).rejects.toThrow(`Grantee list not found for file eReference: ${fileInfo.topic!.toString()}`);
    });
  });

  describe('eventEmitter', () => {
    it('should send event after upload happens', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const emitter = new EventEmitterBase();
      const uploadHandler = jest.fn((_) => {});

      const fm = await createInitializedFileManager(bee, emitter);
      fm.emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);
      createUploadFilesFromDirectorySpy('1');

      (getFeedData as jest.Mock).mockResolvedValueOnce({
        feedIndex: FeedIndex.fromBigInt(-1n),
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      });

      const actPublisher = (await bee.getNodeAddresses()).publicKey.toCompressedHex();
      const expectedFileInfo = {
        batchId: MOCK_BATCH_ID,
        customMetadata: undefined,
        file: {
          historyRef: SWARM_ZERO_ADDRESS.toString(),
          reference: SWARM_ZERO_ADDRESS.toString(),
        },
        actPublisher,
        version: FEED_INDEX_ZERO.toString(),
        name: 'tests',
        owner: MOCK_SIGNER.publicKey().address().toString(),
        preview: undefined,
        redundancyLevel: undefined,
        shared: false,
        timestamp: expect.any(Number),
        topic: expect.any(String),
      } as FileInfo;

      await fm.upload({ info: { batchId: new BatchId(MOCK_BATCH_ID), name: 'tests' }, path: './tests' });
      fm.emitter.off(FileManagerEvents.FILE_UPLOADED, uploadHandler);

      expect(uploadHandler).toHaveBeenCalledWith({
        fileInfo: expectedFileInfo,
      });
    });

    it('should send an event after the fileManager is initialized', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const eventHandler = jest.fn((_) => {});
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });
  });
});
