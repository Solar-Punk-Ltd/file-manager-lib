import {
  BatchId,
  Bee,
  Bytes,
  FeedIndex,
  MantarayNode,
  Reference,
  STAMPS_DEPTH_MAX,
  Topic,
  UploadResult,
} from '@ethersphere/bee-js';
import * as fs from 'fs';

import { FileManagerBase } from '../../src/fileManager';
import { getFeedData } from '../../src/utils/common';
import { SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { SignerError } from '../../src/utils/errors';
import { EventEmitterBase } from '../../src/utils/eventEmitter';
import { FileManagerEvents } from '../../src/utils/events';
import { FileInfo, FileVersionMetadata, WrappedUploadResult } from '../../src/utils/types';
import {
  createInitializedFileManager,
  createInitMocks,
  createMockFeedWriter,
  createMockFileInfo,
  createMockGetFeedDataResult,
  createMockMantarayNode,
  createUploadDataSpy,
  createUploadFilesFromDirectorySpy,
  createUploadFileSpy,
  MOCK_BATCH_ID,
} from '../mockHelpers';
import { BEE_URL, MOCK_SIGNER } from '../utils';

jest.mock('../../src/utils/common');
jest.mock('../../src/utils/mantaray');

describe('FileManager', () => {
  let mockSelfAddr: Reference;

  beforeEach(async () => {
    jest.resetAllMocks();
    createInitMocks();
    const mokcMN = createMockMantarayNode(true);
    mockSelfAddr = await mokcMN.calculateSelfAddress();

    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { getFeedData, generateTopic, getWrappedData } = require('../../src/utils/common');
    getFeedData.mockResolvedValue(createMockGetFeedDataResult(0, 1));
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
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });

    it('should not initialize, if already initialized', async () => {
      const logSpy = jest.spyOn(console, 'log');
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);

      const fm = await createInitializedFileManager(new Bee(BEE_URL, { signer: MOCK_SIGNER }), emitter);
      expect(eventHandler).toHaveBeenCalledWith(true);
      await fm.initialize();
      expect(logSpy).toHaveBeenCalledWith('FileManager is already initialized');
    });

    it('should not initialize, if currently being initialized', async () => {
      const logSpy = jest.spyOn(console, 'log');
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
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

      fm.upload({ batchId: new BatchId(MOCK_BATCH_ID), path: './tests', name: 'tests' });

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

      fm.upload({ batchId: new BatchId(MOCK_BATCH_ID), path: './tests', name: 'tests' });

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
      expect(uploadFileOrDirectoryPreviewSpy).toHaveBeenCalled();
    });

    it('should throw error if infoTopic and historyRef are not provided at the same time', async () => {
      const fm = await createInitializedFileManager();

      await expect(async () => {
        await fm.upload({
          batchId: new BatchId(MOCK_BATCH_ID),
          path: './tests',
          name: 'tests',
          infoTopic: 'infoTopic',
        });
      }).rejects.toThrow('Options infoTopic and historyRef have to be provided at the same time.');
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

  describe('version control', () => {
    let fm: FileManagerBase;
    const feedDataMock = getFeedData as jest.MockedFunction<typeof getFeedData>;

    beforeEach(async () => {
      jest.resetAllMocks();
      createInitMocks();

      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      const common = require('../../src/utils/common');
      common.generateTopic.mockReturnValue(new Topic('1'.repeat(64)));
      common.generateFileFeedTopic.mockReturnValue(new Topic('1'.repeat(64)));
      common.getFeedData.mockResolvedValue(createMockGetFeedDataResult(0, 1));
      common.getWrappedData.mockResolvedValue({ uploadFilesRes: mockSelfAddr } as WrappedUploadResult);

      jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from(''));
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      fm = await createInitializedFileManager(bee);
    });

    it('getVersionCount returns feedIndexNext', async () => {
      feedDataMock.mockResolvedValueOnce(createMockGetFeedDataResult(0, 5));
      const count = await fm.getVersionCount('foo.txt');
      expect(count).toBe(5);
    });

    it('getVersion returns null on 404', async () => {
      const notFound = new Error('not found') as any;
      notFound.status = 404;
      feedDataMock.mockRejectedValueOnce(notFound);
      const v = await fm.getVersion('foo.txt', 0);
      expect(v).toBeNull();
    });

    it('getVersion returns metadata when feed payload is JSON', async () => {
      const meta: FileVersionMetadata = {
        filePath: 'foo.txt',
        contentHash: 'xyzRef',
        size: 123,
        timestamp: '2025-01-01T00:00:00Z',
        version: 0,
        batchId: 'batch123',
        customMetadata: { a: '1' },
      };
      // simulate feedData.download() returning JSON blob { reference: 'refHex' }
      const payload = Bytes.fromUtf8(JSON.stringify({ reference: 'refHex' }));
      feedDataMock.mockResolvedValueOnce({ payload, feedIndex: undefined as any, feedIndexNext: undefined });
      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValueOnce(Bytes.fromUtf8(JSON.stringify(meta)));

      const result = await fm.getVersion('foo.txt', 0);
      expect(result).toEqual(meta);
    });

    it('getHistory returns all versions in order', async () => {
      const v0: FileVersionMetadata = {
        filePath: 'a',
        contentHash: 'h0',
        size: 1,
        timestamp: 't0',
        version: 0,
        batchId: 'b0',
      };
      const v1: FileVersionMetadata = {
        filePath: 'a',
        contentHash: 'h1',
        size: 2,
        timestamp: 't1',
        version: 1,
        batchId: 'b1',
      };
      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(2);
      jest
        .spyOn(fm, 'getVersion')
        .mockResolvedValueOnce(v0 as any)
        .mockResolvedValueOnce(v1 as any);

      const history = await fm.getHistory('a');
      expect(history).toEqual([v0, v1]);
    });

    it('emits version from writeFileVersionMetadata by mocking the underlying Bee calls', async () => {
      // 0) intercept the reader, so getFileVersionCount() sees feedIndexNext = 6
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({
        download: jest.fn().mockResolvedValue({
          feedIndexNext: FeedIndex.fromBigInt(6n),
        }),
      } as any);

      // 1) stub out directory‐upload so uploadNode/uploadBrowser itself resolves
      const FILE_REF = '3'.repeat(64);
      const HISTORY_REF = '0'.repeat(64);
      jest.spyOn(Bee.prototype, 'uploadFilesFromDirectory').mockResolvedValue({
        reference: new Reference(FILE_REF),
        historyAddress: { getOrThrow: () => new Reference(HISTORY_REF) },
      } as UploadResult);

      // 2) stub every call to bee.uploadData()
      jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue({
        reference: new Reference(FILE_REF),
        historyAddress: { getOrThrow: () => new Reference(HISTORY_REF) },
      } as UploadResult);

      // 3) stub the feed-writer so uploadReference never throws
      jest.spyOn(Bee.prototype, 'makeFeedWriter').mockReturnValue({
        uploadReference: jest.fn().mockResolvedValue(undefined),
      } as any);

      // now initialize + do the upload
      const emitter = new EventEmitterBase();
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, emitter);
      const handler = jest.fn();
      emitter.on(FileManagerEvents.FILE_UPLOADED, handler);

      await fm.upload({
        batchId: new BatchId(MOCK_BATCH_ID),
        path: './tests',
        name: 'versioned.txt',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ version: 6 }));
    });

    it('getVersionCount treats undefined feedIndexNext as zero', async () => {
      // simulate getFeedData returning no feedIndexNext
      feedDataMock.mockResolvedValueOnce({
        payload: Bytes.fromUtf8('irrelevant'),
        feedIndex: undefined as any,
        feedIndexNext: undefined,
      });
      const count = await fm.getVersionCount('foo.txt');
      expect(count).toBe(0);
    });

    it('getVersion returns null when payload is all-zero (SWARM_ZERO_ADDRESS)', async () => {
      // 32 bytes of zero → zero‐address
      const zeroPayload = new Bytes(Buffer.alloc(32));
      feedDataMock.mockResolvedValueOnce({
        payload: zeroPayload,
        feedIndex: undefined as any,
        feedIndexNext: undefined,
      });
      const v = await fm.getVersion('foo.txt', 0);
      expect(v).toBeNull();
    });

    it('getVersion falls back to raw‐reference when JSON.parse fails', async () => {
      // payload is plain 32‐byte reference
      const rawRefHex = '3'.repeat(64);
      const rawRefBytes = new Bytes(Buffer.from(rawRefHex, 'hex'));
      feedDataMock.mockResolvedValueOnce({
        payload: rawRefBytes,
        feedIndex: undefined as any,
        feedIndexNext: undefined,
      });
      // downloadData should be called with the rawRefHex and return our metadata blob
      const meta = {
        filePath: 'foo.txt',
        contentHash: 'xyz',
        size: 42,
        timestamp: '2025-01-02T03:04:05Z',
        version: 0,
        batchId: 'batch-foo',
      };
      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValueOnce(Bytes.fromUtf8(JSON.stringify(meta)));

      const result = await fm.getVersion('foo.txt', 0);
      expect(result).not.toBeNull();
      expect(result).toEqual(meta);
    });

    it('getHistory filters out null versions', async () => {
      // pretend there are 3 entries but the middle one is missing
      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(3);
      jest
        .spyOn(fm, 'getVersion')
        .mockResolvedValueOnce({
          version: 0,
          filePath: 'x',
          contentHash: 'h0',
          size: 1,
          timestamp: 't0',
          batchId: 'b0',
        } as any)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          version: 2,
          filePath: 'x',
          contentHash: 'h2',
          size: 3,
          timestamp: 't2',
          batchId: 'b2',
        } as any);

      const history = await fm.getHistory('foo.txt');
      expect(history).toHaveLength(2);
      expect(history.map((h) => h.version)).toEqual([0, 2]);
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
      const uploadHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });

      const fm = await createInitializedFileManager(bee, emitter);
      fm.emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);
      createUploadFilesFromDirectorySpy('1');

      const actPublisher = (await bee.getNodeAddresses()).publicKey.toCompressedHex();
      const expectedFileInfo = {
        batchId: MOCK_BATCH_ID,
        customMetadata: undefined,
        file: {
          historyRef: SWARM_ZERO_ADDRESS.toString(),
          reference: SWARM_ZERO_ADDRESS.toString(),
        },
        actPublisher,
        index: undefined,
        name: 'tests',
        owner: MOCK_SIGNER.publicKey().address().toString(),
        preview: undefined,
        redundancyLevel: undefined,
        shared: false,
        timestamp: expect.any(Number),
        topic: expect.any(String),
      } as FileInfo;

      await fm.upload({ batchId: new BatchId(MOCK_BATCH_ID), path: './tests', name: 'tests' });
      fm.emitter.off(FileManagerEvents.FILE_UPLOADED, uploadHandler);

      expect(uploadHandler).toHaveBeenCalledWith({
        fileInfo: expectedFileInfo,
      });
    });

    it('should send an event after the fileManager is initialized', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });
  });
});
