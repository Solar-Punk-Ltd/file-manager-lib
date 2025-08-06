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
import { SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { DriveError, SignerError } from '../../src/utils/errors';
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
  generateRandomBytes: jest.fn(),
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
    const { generateRandomBytes, getWrappedData } = require('../../src/utils/common');
    getWrappedData.mockResolvedValue({
      uploadFilesRes: mockSelfAddr.toString(),
    } as WrappedUploadResult);
    generateRandomBytes.mockReturnValue(new Topic('1'.repeat(64)));

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
      const { getForksMap } = jest.requireActual('../../src/utils/mantaray');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/mantaray'), 'getForksMap').mockImplementation(getForksMap);
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
    beforeEach(() => {
      const { getForksMap } = jest.requireActual('../../src/utils/mantaray');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      jest.spyOn(require('../../src/utils/mantaray'), 'getForksMap').mockImplementation(getForksMap);
    });

    it('should return correct reference and path', async () => {
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
      expect(result).toEqual({ '/root/2.txt': '2'.repeat(64) });
    });
  });

  describe('upload', () => {
    it('should call uploadFilesFromDirectory', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      const di = fm.getDrives()[0];

      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      await fm.upload(di, { path: './tests', name: 'tests' });

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();

      const fi = fm.fileInfoList.find((fi) => fi.driveId === di.id.toString() && fi.name === 'tests');
      expect(fi).toBeDefined();
      expect(fi?.topic).toBe(new Topic('1'.repeat(64)).toString());
    });

    it('should call uploadFileOrDirectory if previewPath is provided', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      const di = fm.getDrives()[0];
      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      const uploadFileOrDirectoryPreviewSpy = createUploadFilesFromDirectorySpy('6');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      fm.upload(di, { path: './tests', name: 'tests' });

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
      expect(uploadFileOrDirectoryPreviewSpy).toHaveBeenCalled();
    });

    it('should throw error if infoTopic and historyRef are not provided at the same time', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      const di = fm.getDrives()[0];

      await expect(async () => {
        await fm.upload(di, {
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

  describe('drive handling', () => {
    it('createDrive should create a new drive', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      const di = fm.getDrives()[0];
      expect(di).toBeDefined();
      expect(di.name).toBe('Test Drive');
      expect(di.batchId.toString()).toBe(MOCK_BATCH_ID.toString());
      expect(di.id.toString()).toHaveLength(64);
      expect(di.owner).toBe(MOCK_SIGNER.publicKey().address().toString());
      expect(di.infoFeedList).toStrictEqual(undefined);
    });

    it('createDrive should throw error if drive with same name or batchId exists', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      await expect(fm.createDrive(MOCK_BATCH_ID, 'New Drive')).rejects.toThrow(
        new DriveError(`Drive with name "New Drive" or batchId "${MOCK_BATCH_ID}" already exists`),
      );
      await expect(
        fm.createDrive('aa0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51', 'Test Drive'),
      ).rejects.toThrow(
        new DriveError(
          `Drive with name "Test Drive" or batchId "aa0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51" already exists`,
        ),
      );
    });

    it('destroyDrive should call diluteBatch with batchId and MAX_DEPTH', async () => {
      const diluteSpy = jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(new BatchId('1234'.repeat(16)));
      const fm = await createInitializedFileManager();
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      const di = fm.getDrives()[0];

      await fm.destroyDrive(di);

      expect(diluteSpy).toHaveBeenCalledWith(di.batchId, STAMPS_DEPTH_MAX);
    });

    it('destroyDrive should throw error if trying to destroy OwnerFeedStamp', async () => {
      const ownerBatchId = new BatchId('3456'.repeat(16));
      const fm = await createInitializedFileManager();
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      const di = fm.getDrives()[0];
      di.batchId = ownerBatchId;

      await expect(async () => {
        await fm.destroyDrive(di);
      }).rejects.toThrow(`Cannot destroy owner stamp, batchId: ${ownerBatchId.toString()}`);
    });
  });

  describe('getGranteesOfFile', () => {
    it('should throw grantee list not found if the topic not found in ownerFeedList', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee);
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      const di = fm.getDrives()[0];

      const actPublisher = (await bee.getNodeAddresses()).publicKey.toCompressedHex();
      const fileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        driveId: di.id.toString(),
        name: 'john doe',
        owner: MOCK_SIGNER.publicKey().address().toString(),
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

  describe('eventEmitter', () => {
    it('should send event after upload happens', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const emitter = new EventEmitterBase();
      const uploadHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });

      const fm = await createInitializedFileManager(bee, emitter);
      fm.emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);
      await fm.createDrive(MOCK_BATCH_ID, 'Test Drive');
      const di = fm.getDrives()[0];
      createUploadFilesFromDirectorySpy('1');

      (getFeedData as jest.Mock).mockResolvedValueOnce({
        feedIndex: FeedIndex.fromBigInt(-1n),
        feedIndexNext: FeedIndex.fromBigInt(0n),
      });

      const actPublisher = (await bee.getNodeAddresses()).publicKey.toCompressedHex();
      const expectedFileInfo: FileInfo = {
        batchId: MOCK_BATCH_ID,
        driveId: di.id.toString(),
        customMetadata: undefined,
        file: {
          historyRef: SWARM_ZERO_ADDRESS.toString(),
          reference: SWARM_ZERO_ADDRESS.toString(),
        },
        actPublisher,
        index: '0000000000000000',
        name: 'tests',
        owner: MOCK_SIGNER.publicKey().address().toString(),
        preview: undefined,
        redundancyLevel: 0,
        shared: false,
        timestamp: expect.any(Number),
        topic: expect.any(String),
      };

      await fm.upload(di, { path: './tests', name: 'tests' });
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
