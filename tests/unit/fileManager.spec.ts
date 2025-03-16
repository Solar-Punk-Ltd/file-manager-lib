import { BatchId, Bee, Bytes, MantarayNode, Reference, STAMPS_DEPTH_MAX, Topic } from '@upcoming/bee-js';
import { Optional } from 'cafe-utility';

import { FileManagerBase } from '../../src/fileManager/fileManager';
import { FileManagerNode } from '../../src/fileManager/fileManager.node';
import { SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { SignerError } from '../../src/utils/errors';
import { EventEmitter } from '../../src/utils/eventEmitter';
import { FileManagerEvents } from '../../src/utils/events';
import { ReferenceWithHistory } from '../../src/utils/types';
import {
  createInitializedFileManager,
  createInitMocks,
  createMockFeedWriter,
  createMockGetFeedDataResult,
  createMockMantarayNode,
  createUploadDataSpy,
  createUploadFilesFromDirectorySpy,
  createUploadFileSpy,
  MOCK_BATCH_ID,
} from '../mockHelpers';
import { BEE_URL, MOCK_SIGNER } from '../utils';

jest.mock('../../src/utils/common');

describe('FileManager', () => {
  beforeEach(() => {
    jest.resetAllMocks();
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

      expect(fm.getFileInfoList()).toEqual([]);
      expect(fm.getSharedWithMe()).toEqual([]);
    });
  });

  describe('initialize', () => {
    beforeEach(() => {
      jest.resetAllMocks();

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getFeedData } = require('../../src/utils/common');
      getFeedData.mockResolvedValue(createMockGetFeedDataResult(0, 1));
    });

    it('should initialize FileManager', async () => {
      createInitMocks();

      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitter();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });

    it('should not initialize, if already initialized', async () => {
      createInitMocks();
      const logSpy = jest.spyOn(console, 'log');
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitter();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);

      const fm = await createInitializedFileManager(new Bee(BEE_URL, { signer: MOCK_SIGNER }), emitter);
      expect(eventHandler).toHaveBeenCalledWith(true);
      await fm.initialize();
      expect(logSpy).toHaveBeenCalledWith('FileManager is already initialized');
    });

    it('should not initialize, if currently being initialized', async () => {
      createInitMocks();
      const logSpy = jest.spyOn(console, 'log');
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitter();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);

      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManagerNode(bee, emitter);
      fm.initialize();
      await fm.initialize();
      expect(logSpy).toHaveBeenCalledWith('FileManager is being initialized');
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

  describe('download', () => {
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

      const fileStrings = await fm.download(eFileRef);

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

      fm.upload({ batchId: new BatchId(MOCK_BATCH_ID), path: './tests', name: 'tests' });

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

      fm.upload({ batchId: new BatchId(MOCK_BATCH_ID), path: './tests', name: 'tests' });

      expect(uploadFileOrDirectorySpy).toHaveBeenCalled();
      expect(uploadFileOrDirectoryPreviewSpy).toHaveBeenCalled();
    });

    it('should throw error if infoTopic and historyRef are not provided at the same time', async () => {
      createInitMocks();
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
    beforeEach(() => {
      jest.resetAllMocks();
    });

    it('should call diluteBatch with batchId and MAX_DEPTH', async () => {
      createInitMocks();
      const diluteSpy = jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(new BatchId('1234'.repeat(16)));
      const fm = await createInitializedFileManager();

      await fm.destroyVolume(new BatchId('1234'.repeat(16)));

      expect(diluteSpy).toHaveBeenCalledWith(new BatchId('1234'.repeat(16)), STAMPS_DEPTH_MAX);
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
        await fm.getGrantees(fileInfo);
      }).rejects.toThrow(`Grantee list not found for file eReference: ${fileInfo.topic.toString()}`);
    });
  });

  describe('eventEmitter', () => {
    beforeEach(() => {
      jest.resetAllMocks();

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getFeedData } = require('../../src/utils/common');
      getFeedData.mockResolvedValue(createMockGetFeedDataResult(0, 1));
    });

    it('should send event after upload happens', async () => {
      createInitMocks();
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const emitter = new EventEmitter();
      const uploadHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);

      const fm = await createInitializedFileManager(bee, emitter);
      createUploadFilesFromDirectorySpy('1');

      const expectedFileInfo = {
        batchId: MOCK_BATCH_ID,
        customMetadata: undefined,
        file: {
          historyRef: SWARM_ZERO_ADDRESS.toString(),
          reference: '1'.repeat(64),
        },
        index: undefined,
        name: 'tests',
        owner: MOCK_SIGNER.publicKey().address().toString(),
        preview: undefined,
        redundancyLevel: undefined,
        shared: false,
        timestamp: expect.any(Number),
        topic: expect.any(String),
      };

      await fm.upload({ batchId: new BatchId(MOCK_BATCH_ID), path: './tests', name: 'tests' });
      emitter.off(FileManagerEvents.FILE_UPLOADED, uploadHandler);

      expect(uploadHandler).toHaveBeenCalledWith({
        fileInfo: expectedFileInfo,
      });
    });

    it('should send an event after the fileManager is initialized', async () => {
      createInitMocks();

      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const eventHandler = jest.fn((input) => {
        console.log('Input: ', input);
      });
      const emitter = new EventEmitter();
      emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });
  });
});
