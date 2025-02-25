import { BatchId, Bee, Bytes, MantarayNode, Reference } from '@upcoming/bee-js';
import { Optional } from 'cafe-utility';

import { FileManager } from '../../src/fileManager';
import { SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { SignerError } from '../../src/utils/errors';
import { ReferenceWithHistory } from '../../src/utils/types';
import {
  createInitMocks,
  createMockFeedWriter,
  createMockMantarayNode,
  createUploadDataSpy,
  createUploadFilesFromDirectorySpy,
  createUploadFileSpy,
  MOCK_BATCH_ID,
  setupGlobalLocalStorage,
} from '../mockHelpers';
import { BEE_URL, MOCK_SIGNER } from '../utils';

// Set up the global localStorage mock
setupGlobalLocalStorage();

async function createInitializedFileManager(): Promise<FileManager> {
  const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
  const fileManager = new FileManager(bee);
  await fileManager.initialize();
  return fileManager;
}

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
});
