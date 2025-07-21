import { BatchId, Bee, Bytes, MantarayNode, Reference, STAMPS_DEPTH_MAX, Topic } from '@ethersphere/bee-js';
import * as fs from 'fs';

import { FileManagerBase } from '../../src/fileManager';
import * as uploadBrowserModule from '../../src/upload/upload.browser';
import * as uploadNodeModule from '../../src/upload/upload.node';
import { generateFileFeedTopic, getFeedData } from '../../src/utils/common';
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

      jest.spyOn(uploadNodeModule, 'uploadNode').mockResolvedValue({
        reference: new Reference('3'.repeat(64)),
        historyAddress: { getOrThrow: () => new Reference('0'.repeat(64)) },
      } as any);

      jest.spyOn(uploadBrowserModule, 'uploadBrowser').mockResolvedValue({
        reference: new Reference('3'.repeat(64)),
        historyAddress: { getOrThrow: () => new Reference('0'.repeat(64)) },
      } as any);
    });

    it('getVersionCount returns feedIndexNext', async () => {
      // make getFeedData return feedIndexNext = 5
      feedDataMock.mockResolvedValueOnce(createMockGetFeedDataResult(0, 5));

      const fakeFileInfo = {
        topic: generateFileFeedTopic('foo.txt'),
      } as unknown as FileInfo;

      const count = await fm.getVersionCount(fakeFileInfo);
      expect(count).toBe(5);
    });

    it('getVersion returns null on 404 / zero-address', async () => {
      // zero-address payload → null
      feedDataMock.mockResolvedValue({
        payload: SWARM_ZERO_ADDRESS,
        feedIndex: undefined as any,
        feedIndexNext: undefined as any,
      });

      await expect(fm.getVersion('foo.txt', 0)).resolves.toBeNull();
      await expect(fm.getVersion('foo.txt', 1)).resolves.toBeNull();
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

    it('emits version from recordVersion', async () => {
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_UPLOADED, handler);

      // stub out recordVersion to return “6”
      jest.spyOn(fm as any, 'recordVersion').mockResolvedValueOnce(6);

      await fm.upload({
        batchId: new BatchId(MOCK_BATCH_ID),
        path: './tests',
        name: 'versioned.txt',
      });

      // should include version: 6
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ version: 6 }));
    });

    it('getVersionCount treats undefined feedIndexNext as zero', async () => {
      // simulate getFeedData returning no feedIndexNext
      feedDataMock.mockResolvedValueOnce({
        payload: Bytes.fromUtf8('irrelevant'),
        feedIndex: undefined as any,
        feedIndexNext: undefined,
      });

      const fakeFileInfo = {
        topic: generateFileFeedTopic('foo.txt'),
      } as unknown as FileInfo;

      const count = await fm.getVersionCount(fakeFileInfo);
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

    it('should restore an earlier version', async () => {
      // Arrange
      const fileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        owner: MOCK_SIGNER.publicKey().address().toString(),
        topic: new Topic('a'.repeat(64)).toString(),
        name: 'doc.txt',
        actPublisher: '0xdead',
        file: {
          reference: new Reference('1'.repeat(64)).toString(),
          historyRef: new Reference('2'.repeat(64)).toString(),
        },
        timestamp: Date.now(),
        shared: false,
        preview: undefined,
        index: undefined,
        customMetadata: undefined,
        redundancyLevel: undefined,
      };

      fm.fileInfoList.push(fileInfo);

      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(2);

      const version0Meta: FileVersionMetadata = {
        filePath: 'doc.txt',
        contentHash: '0'.repeat(64), // earlier reference
        size: 10,
        timestamp: '2025-01-01T00:00:00Z',
        version: 0,
        batchId: MOCK_BATCH_ID,
      };
      jest.spyOn(fm, 'getVersion').mockResolvedValueOnce(version0Meta);

      const saveFileInfoAndFeedSpy = jest.spyOn(fm as any, 'saveFileInfoAndFeed').mockResolvedValue(undefined);

      const restored = await fm.restoreVersion(fileInfo, 0);

      expect(fm.getVersion).toHaveBeenCalledWith('doc.txt', 0);
      expect(saveFileInfoAndFeedSpy).toHaveBeenCalledTimes(1);
      expect(restored.file.reference.toString()).toBe(version0Meta.contentHash);
    });

    it('restoreVersion throws if requested version >= count', async () => {
      const fileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        owner: MOCK_SIGNER.publicKey().address().toString(),
        topic: new Topic('b'.repeat(64)).toString(),
        name: 'overflow.txt',
        actPublisher: '0xdead',
        file: {
          reference: new Reference('a'.repeat(64)).toString(),
          historyRef: new Reference('b'.repeat(64)).toString(),
        },
        timestamp: Date.now(),
        shared: false,
        preview: undefined,
        index: undefined,
        customMetadata: undefined,
        redundancyLevel: undefined,
      };
      fm.fileInfoList.push(fileInfo);

      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(2); // versions 0 & 1 only

      await expect(fm.restoreVersion(fileInfo, 2)).rejects.toThrow(/version 2 not found/i);
    });

    it('restoreVersion throws if metadata for version is null', async () => {
      const fileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        owner: MOCK_SIGNER.publicKey().address().toString(),
        topic: new Topic('c'.repeat(64)).toString(),
        name: 'missing.txt',
        actPublisher: '0xdead',
        file: {
          reference: new Reference('c'.repeat(64)).toString(),
          historyRef: new Reference('d'.repeat(64)).toString(),
        },
        timestamp: Date.now(),
        shared: false,
        preview: undefined,
        index: undefined,
        customMetadata: undefined,
        redundancyLevel: undefined,
      };
      fm.fileInfoList.push(fileInfo);

      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(1);
      jest.spyOn(fm, 'getVersion').mockResolvedValueOnce(null);

      await expect(fm.restoreVersion(fileInfo, 0)).rejects.toThrow(/not found/i);
    });

    it('restoreVersion with mergeMetadata=false overwrites customMetadata', async () => {
      const fileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        owner: MOCK_SIGNER.publicKey().address().toString(),
        topic: new Topic('d'.repeat(64)).toString(),
        name: 'meta.txt',
        actPublisher: '0xdead',
        file: {
          reference: new Reference('e'.repeat(64)).toString(),
          historyRef: new Reference('f'.repeat(64)).toString(),
        },
        timestamp: Date.now(),
        shared: false,
        preview: undefined,
        index: undefined,
        customMetadata: { keep: 'old', _system: { something: 1 } },
        redundancyLevel: undefined,
      };
      fm.fileInfoList.push(fileInfo);

      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(2);
      const versionMeta: FileVersionMetadata = {
        filePath: 'meta.txt',
        contentHash: '9'.repeat(64),
        size: 5,
        timestamp: '2025-02-01T00:00:00Z',
        version: 0,
        batchId: MOCK_BATCH_ID,
        customMetadata: { restored: true },
      };
      jest.spyOn(fm, 'getVersion').mockResolvedValueOnce(versionMeta);

      const saveSpy = jest.spyOn(fm as any, 'saveFileInfoAndFeed').mockResolvedValue(undefined);

      const restored = await fm.restoreVersion(fileInfo, 0, { mergeMetadata: false });

      expect(saveSpy).toHaveBeenCalled();
      expect(restored.customMetadata).toEqual(versionMeta.customMetadata);
      expect(restored.customMetadata).not.toHaveProperty('_system'); // since not merged
    });

    it('restoreVersion with mergeMetadata=true merges and annotates _system', async () => {
      const fileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        owner: MOCK_SIGNER.publicKey().address().toString(),
        topic: new Topic('e'.repeat(64)).toString(),
        name: 'merge.txt',
        actPublisher: '0xdead',
        file: {
          reference: new Reference('1'.repeat(64)).toString(),
          historyRef: new Reference('2'.repeat(64)).toString(),
        },
        timestamp: Date.now(),
        shared: false,
        preview: undefined,
        index: undefined,
        customMetadata: { existing: 42, _system: { alpha: true } },
        redundancyLevel: undefined,
      };
      fm.fileInfoList.push(fileInfo);

      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(3);
      const versionMeta: FileVersionMetadata = {
        filePath: 'merge.txt',
        contentHash: '7'.repeat(64),
        size: 11,
        timestamp: '2025-03-01T00:00:00Z',
        version: 1,
        batchId: MOCK_BATCH_ID,
        customMetadata: { newField: 'yes' },
      };
      jest.spyOn(fm, 'getVersion').mockResolvedValueOnce(versionMeta);

      jest.spyOn(fm as any, 'saveFileInfoAndFeed').mockResolvedValue(undefined);

      const restored = await fm.restoreVersion(fileInfo, 1, { mergeMetadata: true });

      expect(restored.customMetadata).toBeTruthy();
      expect(restored.customMetadata).toHaveProperty('existing', 42);
      expect(restored.customMetadata).toHaveProperty('newField', 'yes');
      expect(restored.customMetadata?._system).toMatchObject({
        alpha: true,
        restoredFromVersion: 1,
      });
    });

    it('restoreVersion leaves original historyRef intact', async () => {
      const originalHistoryRef = new Reference('f'.repeat(64)).toString();
      const fileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        owner: MOCK_SIGNER.publicKey().address().toString(),
        topic: new Topic('f'.repeat(64)).toString(),
        name: 'keep-history.txt',
        actPublisher: '0xdead',
        file: {
          reference: new Reference('a'.repeat(64)).toString(),
          historyRef: originalHistoryRef,
        },
        timestamp: Date.now(),
        shared: false,
        preview: undefined,
        index: undefined,
        customMetadata: undefined,
        redundancyLevel: undefined,
      };
      fm.fileInfoList.push(fileInfo);

      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(2);
      const versionMeta: FileVersionMetadata = {
        filePath: 'keep-history.txt',
        contentHash: 'b'.repeat(64),
        size: 20,
        timestamp: '2025-04-01T00:00:00Z',
        version: 0,
        batchId: MOCK_BATCH_ID,
      };
      jest.spyOn(fm, 'getVersion').mockResolvedValueOnce(versionMeta);
      jest.spyOn(fm as any, 'saveFileInfoAndFeed').mockResolvedValue(undefined);

      const restored = await fm.restoreVersion(fileInfo, 0);

      expect(restored.file.historyRef.toString()).toBe(originalHistoryRef);
    });

    it('restoreVersion updates timestamp to "now"', async () => {
      const fileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        owner: MOCK_SIGNER.publicKey().address().toString(),
        topic: new Topic('a'.repeat(64)).toString(),
        name: 'time.txt',
        actPublisher: '0xdead',
        file: {
          reference: new Reference('d'.repeat(64)).toString(),
          historyRef: new Reference('e'.repeat(64)).toString(),
        },
        timestamp: Date.now() - 100000,
        shared: false,
        preview: undefined,
        index: undefined,
        customMetadata: undefined,
        redundancyLevel: undefined,
      };
      fm.fileInfoList.push(fileInfo);

      jest.spyOn(fm, 'getVersionCount').mockResolvedValueOnce(1);
      const versionMeta: FileVersionMetadata = {
        filePath: 'time.txt',
        contentHash: 'f'.repeat(64),
        size: 5,
        timestamp: '2025-05-01T00:00:00Z',
        version: 0,
        batchId: MOCK_BATCH_ID,
      };
      jest.spyOn(fm, 'getVersion').mockResolvedValueOnce(versionMeta);
      jest.spyOn(fm as any, 'saveFileInfoAndFeed').mockResolvedValue(undefined);

      const before = Date.now();
      const restored = await fm.restoreVersion(fileInfo, 0);
      const after = Date.now();

      expect(restored.timestamp).toBeGreaterThanOrEqual(before);
      expect(restored.timestamp).toBeLessThanOrEqual(after);
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
      jest.spyOn(uploadNodeModule, 'uploadNode').mockResolvedValue({
        reference: new Reference(SWARM_ZERO_ADDRESS.toString()),
        historyAddress: { getOrThrow: () => new Reference(SWARM_ZERO_ADDRESS.toString()) },
      } as any);

      jest.spyOn(uploadBrowserModule, 'uploadBrowser').mockResolvedValue({
        reference: new Reference(SWARM_ZERO_ADDRESS.toString()),
        historyAddress: { getOrThrow: () => new Reference(SWARM_ZERO_ADDRESS.toString()) },
      } as any);

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
