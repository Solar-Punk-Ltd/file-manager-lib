import {
  BatchId,
  Bee,
  Bytes,
  Duration,
  EthAddress,
  MantarayNode,
  Reference,
  STAMPS_DEPTH_MAX,
  Topic,
} from '@upcoming/bee-js';
import { Optional } from 'cafe-utility';

import { FileManager } from '../../src/fileManager';
import { numberToFeedIndex } from '../../src/utils';
import { FILE_MANAGER_EVENTS, OWNER_FEED_STAMP_LABEL, SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { SignerError } from '../../src/utils/errors';
import { ReferenceWithHistory } from '../../src/utils/types';
import {
  createInitializedFileManager,
  createInitMocks,
  createMockFeedWriter,
  createMockMantarayNode,
  createUploadDataSpy,
  createUploadFilesFromDirectorySpy,
  createUploadFileSpy,
  MOCK_BATCH_ID,
} from '../mockHelpers';
import { BEE_URL, MOCK_SIGNER } from '../utils';

describe('FileManager', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('constructor', () => {
    it('should create new instance of FileManager', () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManager(bee);

      expect(fm).toBeInstanceOf(FileManager);
    });

    it('should throw error, if Signer is not provided', () => {
      const bee = new Bee(BEE_URL);
      try {
        new FileManager(bee);
      } catch (error) {
        expect(error).toBeInstanceOf(SignerError);
        expect((error as any).message).toBe('Signer required');
      }
    });

    it('should initialize FileManager instance with correct values', () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManager(bee);

      //expect(fm.getStamps()).toEqual([]); // we get {} instead of []
      expect(fm.getFileInfoList()).toEqual([]);
      expect(fm.getSharedWithMe()).toEqual([]);
      expect(fm.getIsInitialized()).toEqual(false);
      expect(fm.getNodeAddresses()).toEqual(undefined);
    });
  });

  describe('initialize', () => {
    it('should initialize FileManager', async () => {
      createInitMocks();

      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManager(bee);

      await fm.initialize();

      expect(fm.getIsInitialized()).toBe(true);
    });

    it('should not initialize, if already initialized', async () => {
      createInitMocks();
      const logSpy = jest.spyOn(console, 'log');

      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManager(bee);

      await fm.initialize();
      expect(fm.getIsInitialized()).toBe(true);

      await fm.initialize();
      expect(logSpy).toHaveBeenCalledWith('FileManager is already initialized');
    });
  });

  describe('saveMantaray', () => {
    it('should call saveRecursively', async () => {
      createInitMocks();
      const saveRecursivelySpy = jest.spyOn(MantarayNode.prototype, 'saveRecursively').mockResolvedValue({
        reference: new Reference('1'.repeat(64)),
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
      });

      const fm = await createInitializedFileManager();
      fm.saveMantaray(new BatchId(MOCK_BATCH_ID), new MantarayNode());

      expect(saveRecursivelySpy).toHaveBeenCalled();
    });

    it('should return ReferenceWithHistory', async () => {
      createInitMocks();
      jest.spyOn(MantarayNode.prototype, 'saveRecursively').mockResolvedValue({
        reference: new Reference('1'.repeat(64)),
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
      });
      const fm = await createInitializedFileManager();

      const expectedReturnValue: ReferenceWithHistory = {
        reference: new Reference('1'.repeat(64)).toString(),
        historyRef: new Reference(SWARM_ZERO_ADDRESS).toString(),
      };

      await expect(fm.saveMantaray(new BatchId(MOCK_BATCH_ID), new MantarayNode())).resolves.toEqual(
        expectedReturnValue,
      );
    });
  });

  describe('downloadFork', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should call mantaray.collect()', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const mockMantarayNode = createMockMantarayNode();
      const mantarayCollectSpy = jest.spyOn(MantarayNode.prototype, 'collect');

      await fm.downloadFork(mockMantarayNode, '/root/1.txt');

      expect(mantarayCollectSpy).toHaveBeenCalled();
    });

    it('should call bee.downloadData with correct reference', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const mockMantarayNode = createMockMantarayNode();
      const downloadDataSpy = jest.spyOn(Bee.prototype, 'downloadData');

      await fm.downloadFork(mockMantarayNode, '/root/1.txt');

      const expectedReference = new Reference('1'.repeat(64)).toUint8Array();

      expect(downloadDataSpy).toHaveBeenCalledWith(expectedReference, undefined);
    });
  });

  describe('listFiles', () => {
    it('should return correct ReferenceWithPath', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const mockMantarayNode = createMockMantarayNode(false);
      jest.spyOn(MantarayNode, 'unmarshal').mockResolvedValue(new MantarayNode());
      jest.spyOn(MantarayNode.prototype, 'collect').mockReturnValue(mockMantarayNode.collect());

      const fileInfo = {
        batchId: new BatchId(MOCK_BATCH_ID),
        file: {
          reference: new Reference('1'.repeat(64)),
          historyRef: new Reference(SWARM_ZERO_ADDRESS),
        },
      };

      const result = await fm.listFiles(fileInfo);
      expect(result).toEqual([
        {
          path: '/root/2.txt',
          reference: new Reference('2'.repeat(64)),
        },
      ]);
    });
  });

  describe('downloadFiles', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
    });

    it('should call downloadFork for each file', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const mockMantarayNode = createMockMantarayNode(false);
      jest.spyOn(MantarayNode, 'unmarshal').mockResolvedValue(new MantarayNode());
      jest.spyOn(MantarayNode.prototype, 'collect').mockReturnValue(mockMantarayNode.collect());
      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(new Bytes('46696c6520617320737472696e67')); // this is "File as string" encoded in hexadecimal

      const eFileRef = new Reference('1'.repeat(64));

      const fileStrings = await fm.downloadFiles(eFileRef);

      expect(fileStrings).toEqual(['File as string']);
    });
  });

  describe('upload', () => {
    it('should call uploadFilesFromDirectory', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      fm.upload(new BatchId(MOCK_BATCH_ID), './tests');

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
    });

    it('should call uploadFileOrDirectory if previewPath is provided', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const uploadFileOrDirectorySpy = createUploadFilesFromDirectorySpy('1');
      const uploadFileOrDirectoryPreviewSpy = createUploadFilesFromDirectorySpy('6');
      createUploadFileSpy('2');
      createUploadDataSpy('3');
      createUploadDataSpy('4');
      createMockFeedWriter('5');

      fm.upload(new BatchId(MOCK_BATCH_ID), './tests', './tests/coverage');

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
      expect(uploadFileOrDirectoryPreviewSpy).toHaveBeenCalled();
    });

    it('should throw error if infoTopic and historyRef are not provided at the same time', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();

      await expect(async () => {
        await fm.upload(new BatchId(MOCK_BATCH_ID), './tests', undefined, undefined, 'infoTopic');
      }).rejects.toThrow('infoTopic and historyRef have to be provided at the same time.');
    });
  });

  describe('filterBatches', () => {
    it('should filter by utilization', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();

      const result = fm.filterBatches(undefined, 3, undefined);

      expect(result.length).toBe(1);
      expect(result[0].label).toBe(OWNER_FEED_STAMP_LABEL);
    });

    it('should filter by ttl and capacity', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();

      const result = fm.filterBatches(Duration.fromSeconds(4), undefined, 18);

      expect(result.length).toBe(2);
      expect(result[0].label).toBe('two');
      expect(result[1].label).toBe(OWNER_FEED_STAMP_LABEL);
    });
  });

  describe('getOwnerFeedStamp', () => {
    it('should give back the OwnerFeedStamp', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();

      const result = fm.getOwnerFeedStamp();

      expect(result?.amount).toBe('990');
      expect(result?.label).toBe(OWNER_FEED_STAMP_LABEL);
      expect(result?.depth).toBe(22);
    });
  });

  describe('destroyVolume', () => {
    beforeEach(() => {
      jest.resetAllMocks();
    });

    it('should call diluteBatch with batchId and MAX_DEPTH', async () => {
      createInitMocks();
      const diluteSpy = jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(new BatchId('1234'.repeat(16)));
      const fm = await createInitializedFileManager();

      fm.destroyVolume(new BatchId('1234'.repeat(16)));

      expect(diluteSpy).toHaveBeenCalledWith(new BatchId('1234'.repeat(16)), STAMPS_DEPTH_MAX);
    });

    it('should remove batchId from stamp list', async () => {
      createInitMocks();
      jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(new BatchId('1234'.repeat(16)));
      const fm = await createInitializedFileManager();

      expect(fm.getStamps().length).toBe(3);
      await fm.destroyVolume(new BatchId('1234'.repeat(16)));

      expect(fm.getStamps().length).toBe(2);
      expect(fm.getStamps()[0].label).toBe('two');
      expect(fm.getStamps()[1].label).toBe(OWNER_FEED_STAMP_LABEL);
    });

    it('should throw error if trying to destroy OwnerFeedStamp', async () => {
      const batchId = new BatchId('3456'.repeat(16));
      createInitMocks();
      jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(new BatchId('1234'.repeat(16)));
      const fm = await createInitializedFileManager();

      await expect(async () => {
        await fm.destroyVolume(batchId);
      }).rejects.toThrow(`Cannot destroy owner stamp, batchId: ${batchId.toString()}`);
    });
  });

  describe('getGranteesOfFile', () => {
    it('should throw grantee list not found if the topic not found in ownerFeedList', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();

      const fileInfo = {
        batchId: new BatchId(MOCK_BATCH_ID),
        topic: Topic.fromString('example'),
        file: {
          reference: new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68'),
          historyRef: new Reference(SWARM_ZERO_ADDRESS),
        },
      };

      await expect(async () => {
        await fm.getGranteesOfFile(fileInfo);
      }).rejects.toThrow(`Grantee list not found for file eReference: ${fileInfo.topic.toString()}`);
    });
  });

  describe('getFeedData', () => {
    beforeEach(() => jest.restoreAllMocks());
    afterEach(() => jest.resetAllMocks());

    it('should call makeFeedReader', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManager(bee);
      const topic = Topic.fromString('example');
      const makeFeedReaderSpy = jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({
        download: jest.fn(),
        owner: new EthAddress('0000000000000000000000000000000000000000'),
        topic: topic,
      });

      await fm.getFeedData(topic);

      expect(makeFeedReaderSpy).toHaveBeenCalled();
    });

    it('should call download with correct index, is index is provided', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManager(bee);
      const topic = Topic.fromString('example');
      const downloadSpy = jest.fn();
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({
        download: downloadSpy,
        owner: new EthAddress('0000000000000000000000000000000000000000'),
        topic: topic,
      });

      await fm.getFeedData(topic, 8);

      expect(downloadSpy).toHaveBeenCalledWith({ index: numberToFeedIndex(8) });
    });

    it('should call download without parameters, if index is not provided', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManager(bee);
      const topic = Topic.fromString('example');
      const downloadSpy = jest.fn();
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({
        download: downloadSpy,
        owner: new EthAddress('0000000000000000000000000000000000000000'),
        topic: topic,
      });

      await fm.getFeedData(topic);

      expect(downloadSpy).toHaveBeenCalledWith();
    });
  });

  describe('eventEmitter', () => {
    it('should send event after upload happens', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const { on, off } = fm.emitter;
      const uploadHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      createUploadFilesFromDirectorySpy('1');

      on(FILE_MANAGER_EVENTS.FILE_UPLOADED, uploadHandler);

      const expectedFileInfo = {
        batchId: MOCK_BATCH_ID,
        customMetadata: undefined,
        file: {
          historyRef: expect.anything(),
          reference: '1'.repeat(64),
        },
        index: 0,
        name: 'tests',
      };

      await fm.upload(new BatchId(MOCK_BATCH_ID), './tests');
      off(FILE_MANAGER_EVENTS.FILE_UPLOADED, uploadHandler);

      expect(uploadHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          fileInfo: expect.objectContaining(expectedFileInfo),
        }),
      );
    });

    it('should send an event after fileInfoList is initialized', async () => {
      createInitMocks();

      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManager(bee);
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      fm.emitter.on(FILE_MANAGER_EVENTS.FILE_INFO_LIST_INITIALIZED, eventHandler);

      await fm.initialize();

      expect(eventHandler).toHaveBeenCalledWith({ signer: MOCK_SIGNER });
    });
  });
});
