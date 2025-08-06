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
import * as UploadNodeMod from '../../src/upload/upload.node';
import { getFeedData } from '../../src/utils/common';
import { SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { SignerError } from '../../src/utils/errors';
import { EventEmitterBase } from '../../src/utils/eventEmitter';
import { FileManagerEvents } from '../../src/utils/events';
import { FeedPayloadResult, FileInfo, FileStatus, WrappedUploadResult } from '../../src/utils/types';
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

    const zero32 = SWARM_ZERO_ADDRESS.toUint8Array();

    (getFeedData as jest.Mock).mockResolvedValue({
      feedIndex: FeedIndex.fromBigInt(0n),
      feedIndexNext: FeedIndex.fromBigInt(1n),
      payload: {
        toUint8Array: () => zero32,
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

  describe('version control', () => {
    let fm: FileManagerBase;

    const dummyTopic = 'deadbeef'.repeat(8);
    const dummyFi = {
      topic: dummyTopic,
      file: { historyRef: '00'.repeat(32), reference: '11'.repeat(32) },
      owner: '',
      batchId: { toString: () => 'aa'.repeat(32) },
      name: 'x',
      actPublisher: 'ff'.repeat(66),
      index: '0',
    } as any;

    beforeEach(async () => {
      fm = await createInitializedFileManager();
    });

    afterEach(() => {
      jest.resetAllMocks();
    });

    it('getVersion should call fetchFileInfo and return FileInfo', async () => {
      const fakeFi = { ...dummyFi, index: '1' };

      // 1) stub out getFeedData so that feedIndex=1, feedIndexNext=2,
      //    and payload is a Bytes wrapping a 32‑byte reference
      const rawMock: FeedPayloadResult = {
        feedIndex: FeedIndex.fromBigInt(1n),
        feedIndexNext: FeedIndex.fromBigInt(2n),
        payload: new Bytes(new Reference('f'.repeat(64)).toUint8Array()),
      } as any;
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/common'), 'getFeedData').mockResolvedValueOnce(rawMock);

      // 2) now spy on fetchFileInfo
      const spyFetch = jest.spyOn(FileManagerBase.prototype as any, 'fetchFileInfo').mockResolvedValue(fakeFi);

      // 3) run getVersion
      const got = await fm.getVersion(dummyFi, FeedIndex.fromBigInt(1n));

      // 4) assert it forwarded exactly that slot to fetchFileInfo
      expect(spyFetch).toHaveBeenCalledWith(rawMock, dummyFi);
      expect(got).toBe(fakeFi);
    });

    it('download via getVersion + download returns the bytes', async () => {
      const vFi = { ...dummyFi, topic: dummyTopic, file: dummyFi.file } as any;
      jest.spyOn(fm, 'getVersion').mockResolvedValue(vFi);
      const spyDl = jest.spyOn(fm, 'download').mockResolvedValue(['mocked bytes'] as any);
      // first we call getVersion, then call download manually
      const gotFi = await fm.getVersion(dummyFi, '3');
      const out = await fm.download(gotFi, ['path1'], { actPublisher: 'p', actHistoryAddress: 'h' } as DownloadOptions);
      expect(fm.getVersion).toHaveBeenCalledWith(dummyFi, '3');
      expect(spyDl).toHaveBeenCalledWith(vFi, ['path1'], { actPublisher: 'p', actHistoryAddress: 'h' });
      expect(out).toEqual(['mocked bytes']);
    });

    it('getVersion throws if underlying feed is missing', async () => {
      jest.restoreAllMocks();
      (getFeedData as jest.Mock).mockResolvedValueOnce({
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FeedIndex.fromBigInt(0n),
        payload: SWARM_ZERO_ADDRESS,
      });

      // 3) call getVersion WITHOUT passing the version argument
      await expect(fm.getVersion(dummyFi)).rejects.toThrow('File info not found for version: 0');
    });

    it('restoring the current head should simply re‑fetch that version and not emit an event', async () => {
      // arrange
      const head = FeedIndex.fromBigInt(5n);
      // make dummyFi look like it’s already at head 5
      dummyFi.index = head.toString();

      // mock getFeedData to return feedIndex=5, fe
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/common'), 'getFeedData').mockResolvedValue({
        feedIndex: head,
        feedIndexNext: FeedIndex.fromBigInt(6n),
        payload: SWARM_ZERO_ADDRESS, // payload isn’t used in the no‑op path
      } as any);

      const spyEmit = jest.spyOn(fm.emitter, 'emit');

      // act
      await fm.restoreVersion(dummyFi);

      // assert: no version‐restored event
      expect(spyEmit).not.toHaveBeenCalledWith(FileManagerEvents.FILE_VERSION_RESTORED, expect.anything());
    });

    it('restoreVersion() when versionToRestore.index === headSlot is a no-op', async () => {
      // Arrange
      const head = FeedIndex.fromBigInt(3n);
      const fakeFeedData = {
        feedIndex: head,
        feedIndexNext: FeedIndex.fromBigInt(4n),
        payload: SWARM_ZERO_ADDRESS,
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/common'), 'getFeedData').mockResolvedValueOnce(fakeFeedData as any);

      const spyEmit = jest.spyOn(fm.emitter, 'emit');

      // Use a **two-digit hex string** here instead of "3":
      // head.toHexString() returns "0x03", which FeedIndex will accept
      const dummyFiWithHead = {
        ...dummyFi,
        index: head.toString(),
      };

      // Act
      await fm.restoreVersion(dummyFiWithHead);

      // Assert: no FILE_VERSION_RESTORED event fired
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

  describe('file operations', () => {
    let fm: FileManagerBase;
    let mockFi: FileInfo;

    beforeEach(async () => {
      // make a fresh FileManager
      fm = await createInitializedFileManager();
      // Create a minimal FileInfo that matches the interface
      mockFi = {
        batchId: 'aa'.repeat(32),
        file: { reference: '11'.repeat(32), historyRef: '00'.repeat(32) },
        name: 'foo',
        owner: '',
        actPublisher: 'ff'.repeat(66),
        topic: 'deadbeef'.repeat(8),
        // no status/timestamp yet
      } as any;

      // Seed the in-memory list with an “active” file
      mockFi.status = FileStatus.Active;
      mockFi.timestamp = 0;
      mockFi.index = '0';
      fm.fileInfoList.push(mockFi);
    });

    it('trashFile should mark a file as trashed, persist and emit FILE_TRASHED', async () => {
      // sanity check
      expect(mockFi.status).toBe(FileStatus.Active);
      expect(mockFi.timestamp).toBe(0);

      const uploadSpy = jest
        .spyOn(fm as any, 'uploadFileInfo')
        .mockResolvedValue({ reference: 'aa'.repeat(32), historyRef: 'bb'.repeat(32) });
      const saveSpy = jest.spyOn(fm as any, 'saveFileInfoFeed').mockResolvedValue(undefined);
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_TRASHED, handler);

      await fm.trashFile(mockFi);

      // in-memory mutated
      expect(mockFi.status).toBe(FileStatus.Trashed);
      expect(mockFi.timestamp!).toBeGreaterThan(0);

      // persisted with the updated object
      expect(uploadSpy).toHaveBeenCalledWith(mockFi);
      expect(saveSpy).toHaveBeenCalledWith(
        mockFi.batchId.toString(),
        { reference: 'aa'.repeat(32), historyRef: 'bb'.repeat(32) },
        mockFi.topic,
        mockFi.index,
      );

      // event
      expect(handler).toHaveBeenCalledWith({ fileInfo: mockFi });
    });

    it('recoverFile should mark a trashed file active, persist and emit FILE_RESTORED', async () => {
      // simulate trashed
      mockFi.status = FileStatus.Trashed;
      const beforeTs = mockFi.timestamp!;

      const uploadSpy = jest
        .spyOn(fm as any, 'uploadFileInfo')
        .mockResolvedValue({ reference: 'cc'.repeat(32), historyRef: 'dd'.repeat(32) });
      const saveSpy = jest.spyOn(fm as any, 'saveFileInfoFeed').mockResolvedValue(undefined);
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_RESTORED, handler);

      await fm.recoverFile(mockFi);

      // mutated back
      expect(mockFi.status).toBe(FileStatus.Active);
      expect(mockFi.timestamp!).toBeGreaterThan(beforeTs);

      // persisted
      expect(uploadSpy).toHaveBeenCalledWith(mockFi);
      expect(saveSpy).toHaveBeenCalledWith(
        mockFi.batchId.toString(),
        { reference: 'cc'.repeat(32), historyRef: 'dd'.repeat(32) },
        mockFi.topic,
        mockFi.index,
      );

      expect(handler).toHaveBeenCalledWith({ fileInfo: mockFi });
    });

    it('forgetFile should remove file from lists, persist owner-feed, and emit FILE_FORGOTTEN', async () => {
      const saveOwnerSpy = jest.spyOn(fm as any, 'saveOwnerFeedList');
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_FORGOTTEN, handler);

      await fm.forgetFile(mockFi);

      // gone from both in-memory lists
      expect(fm.fileInfoList).not.toContain(mockFi);
      expect((fm as any).ownerFeedList.find((f: any) => f.topic === mockFi.topic)).toBeUndefined();
      // and we re-save the owner feed so it's truly unpublished
      expect(saveOwnerSpy).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith({ fileInfo: mockFi });
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
      const uploadHandler = jest.fn();
      // ensure uploadNode never blows up
      jest.spyOn(UploadNodeMod, 'uploadNode').mockResolvedValue({
        reference: SWARM_ZERO_ADDRESS,
        // cast to any to satisfy the Optional<Reference> shape
        historyAddress: { getOrThrow: () => SWARM_ZERO_ADDRESS } as any,
      } as any);
      const fm = await createInitializedFileManager(bee, emitter);
      fm.emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);

      // stub out persistence too
      jest.spyOn(fm as any, 'saveFileInfoAndFeed').mockResolvedValue(undefined);

      (getFeedData as jest.Mock).mockResolvedValueOnce({
        feedIndex: FeedIndex.fromBigInt(-1n),
        feedIndexNext: FeedIndex.fromBigInt(0n),
      });

      const actPublisher = (await bee.getNodeAddresses()).publicKey.toCompressedHex();
      await fm.upload({ batchId: new BatchId(MOCK_BATCH_ID), path: './tests', name: 'tests' });

      // grab the actual emitted payload
      const [{ fileInfo }] = uploadHandler.mock.calls[0];

      expect(fileInfo).toMatchObject({
        batchId: MOCK_BATCH_ID,
        customMetadata: undefined,
        file: {
          reference: SWARM_ZERO_ADDRESS.toString(),
          historyRef: SWARM_ZERO_ADDRESS.toString(),
        },
        actPublisher,
        index: '0000000000000000',
        name: 'tests',
        owner: MOCK_SIGNER.publicKey().address().toString(),
        preview: undefined,
        redundancyLevel: undefined,
        shared: false,
        status: 'active',
        timestamp: expect.any(Number),
        topic: expect.any(String),
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
