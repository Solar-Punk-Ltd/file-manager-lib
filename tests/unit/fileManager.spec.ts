import { BatchId, Bee, MantarayNode, Reference } from '@upcoming/bee-js';
import { Optional } from 'cafe-utility';

import { FileManager } from '../../src/fileManager';
import { SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { ReferenceWithHistory } from '../../src/utils/types';
import {
  createInitMocks,
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
        const fm = new FileManager(bee);
      } catch (error) {
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
      expect(logSpy).toHaveBeenCalledWith('FileManager is already initialized')
    });
  });

  describe('saveMantaray', () => {
    it('should call saveRecursively', async () => {
      createInitMocks();
      const saveRecursivelySpy = jest.spyOn(MantarayNode.prototype, 'saveRecursively').mockResolvedValue({
        reference: new Reference(('1'.repeat(64))),
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS))
      });

      const fm = await createInitializedFileManager();
      fm.saveMantaray(new BatchId(MOCK_BATCH_ID), new MantarayNode())

      expect(saveRecursivelySpy).toHaveBeenCalled();
    });

    it('should return ReferenceWithHistory', async () => {
      createInitMocks();
      const saveRecursivelySpy = jest.spyOn(MantarayNode.prototype, 'saveRecursively').mockResolvedValue({
        reference: new Reference(('1'.repeat(64))),
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS))
      });
      const fm = await createInitializedFileManager();

      const expectedReturnValue: ReferenceWithHistory = {
        reference: new Reference(('1'.repeat(64))).toString(),
        historyRef: new Reference(SWARM_ZERO_ADDRESS).toString()
      }

      await expect(fm.saveMantaray(new BatchId(MOCK_BATCH_ID), new MantarayNode())).resolves.toEqual(expectedReturnValue);
    });
  });

  // describe('initialize', () => {
  //   it('should log no data found if data.txt entry does not exist', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(null);
  //     const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
  //     const fileManager = new FileManager(bee);
  //     const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  //     await fileManager.initialize();
  //     expect(consoleSpy).toHaveBeenCalledWith('No data found in data.txt (localStorage)');
  //   });

  //   it('should load FileInfo list into memory', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
  //     const fileManager = await createInitializedFileManager();

  //     expect(fileManager.getFileInfoList()).toEqual([
  //       {
  //         batchId: new BatchId(mockBatchId),
  //         file: {
  //           reference: pathToRef.get('src/folder/1.txt')!,
  //           historyRef: new Reference(SWARM_ZERO_ADDRESS),
  //         },
  //         name: undefined,
  //         owner: undefined,
  //         preview: undefined,
  //         redundancyLevel: undefined,
  //         shared: undefined,
  //         timestamp: undefined,
  //         topic: undefined,
  //         customMetadata: undefined,
  //       },
  //       {
  //         batchId: new BatchId(mockBatchId),
  //         file: {
  //           reference: pathToRef.get('src/folder/2.txt')!,
  //           historyRef: new Reference(SWARM_ZERO_ADDRESS),
  //         },
  //         name: undefined,
  //         historyRef: undefined,
  //         owner: undefined,
  //         preview: undefined,
  //         redundancyLevel: undefined,
  //         shared: undefined,
  //         timestamp: undefined,
  //         topic: undefined,
  //         customMetadata: undefined,
  //       },
  //     ]);
  //   });

  //   it('should throw an error if fileInfoList is not an array', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(`{"fileInfoList": "not an array"}`);
  //     const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
  //     const fileManager = new FileManager(bee);
  //     await expect(fileManager.initialize()).rejects.toThrow('fileInfoList has to be an array!');
  //   });
  // });

  // describe('saveFileInfo', () => {
  //   it('should save new FileInfo into data.txt', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
  //     const setItemSpy = jest.spyOn(localStorage, 'setItem').mockImplementation(() => {});
  //     const fileManager = await createInitializedFileManager();
  //     const fileInfo: FileInfo = {
  //       file: {
  //         historyRef: new Reference(SWARM_ZERO_ADDRESS),
  //         reference: pathToRef.get('src/folder/3.txt')!,
  //       },
  //       batchId: new BatchId(mockBatchId),
  //     };

  //     const ref = await fileManager.saveFileInfo(fileInfo);
  //     expect(ref).toBe('0000000000000000000000000000000000000000000000000000000000000002');
  //     expect(setItemSpy).toHaveBeenCalledWith(expect.any(String), extendedFileInfoTxt);
  //   });

  //   it('should throw an error if fileInfo is invalid', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(emptyFileInfoTxt);
  //     const fileManager = await createInitializedFileManager();
  //     // Bypass BatchId constructor by casting a bad value as BatchId.
  //     const invalidFileInfo: FileInfo = {
  //       file: {
  //         reference: pathToRef.get('src/folder/1.txt')!,
  //         historyRef: pathToRef.get('src/folder/1.txt')!,
  //       },
  //       batchId: '33' as unknown as BatchId,
  //     };

  //     await expect(fileManager.saveFileInfo(invalidFileInfo)).rejects.toThrow(
  //       'Bytes#checkByteLength: bytes length is 1 but expected 32',
  //     );
  //   });

  //   it('should throw an error if there is an error saving the file info', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
  //     jest.spyOn(localStorage, 'setItem').mockImplementation(() => {
  //       throw new Error('Error saving file info');
  //     });
  //     const fileManager = await createInitializedFileManager();
  //     const fileInfo: FileInfo = {
  //       file: {
  //         reference: pathToRef.get('src/folder/3.txt')!,
  //         historyRef: pathToRef.get('src/folder/3.txt')!,
  //       },
  //       batchId: new BatchId(mockBatchId),
  //     };

  //     await expect(fileManager.saveFileInfo(fileInfo)).rejects.toThrow('Error saving file info');
  //   });
  // });

  // describe('listFiles', () => {
  //   it('should list paths (refs) for given input list', async () => {
  //     const expectedPath = 'src/folder/1.txt';
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
  //     const fileManager = await createInitializedFileManager();

  //     const mantaray = new MantarayNode();
  //     mantaray.addFork('src/folder/1.txt', '1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68');
  //     jest.spyOn(fileManager, 'loadMantaray').mockResolvedValue(mantaray);

  //     jest
  //       .spyOn(Bee.prototype, 'downloadData')
  //       .mockImplementationOnce(async () => new Bytes(secondByteArray))
  //       .mockImplementation(async () => new Bytes(firstByteArray));

  //     const paths = await fileManager.listFiles(fileManager.getFileInfoList()[0]);
  //     expect(paths[0].path).toBe(expectedPath);
  //   });
  // });

  // describe('upload', () => {
  //   it('should save FileInfo', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
  //     localStorage.setItem(FILE_INFO_LOCAL_STORAGE, fileInfoTxt);
  //     const fileManager = await createInitializedFileManager();
  //     await fileManager.upload(new BatchId(mockBatchId), pathToRef.get('src/folder/3.txt')!);
  //     const fileInfoList = fileManager.getFileInfoList();

  //     expect(fileInfoList).toHaveLength(3);
  //     expect(fileInfoList[2]).toEqual({
  //       file: {
  //         reference: pathToRef.get('src/folder/3.txt')!,
  //         historyRef: new Reference(SWARM_ZERO_ADDRESS),
  //       },
  //       batchId: mockBatchId,
  //     });
  //   });

  //   it('should give back ref (currently index)', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
  //     const fileManager = await createInitializedFileManager();
  //     const ref = await fileManager.upload(new BatchId(mockBatchId), pathToRef.get('src/folder/3.txt')!.toString());
  //     expect(ref).toBe('0000000000000000000000000000000000000000000000000000000000000002');
  //   });

  //   it('should work with consecutive uploads', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
  //     const fileManager = await createInitializedFileManager();

  //     await fileManager.upload(new BatchId(mockBatchId), pathToRef.get('src/folder/3.txt')!.toString());
  //     expect(fileManager.getFileInfoList()).toHaveLength(3);
  //     expect(fileManager.getFileInfoList()[2]).toEqual({
  //       file: {
  //         reference: pathToRef.get('src/folder/3.txt')!,
  //         historyRef: new Reference(SWARM_ZERO_ADDRESS),
  //       },
  //       batchId: mockBatchId,
  //     });

  //     await fileManager.upload(new BatchId(mockBatchId), pathToRef.get('src/folder/4.txt')!.toString());
  //     expect(fileManager.getFileInfoList()).toHaveLength(4);
  //     expect(fileManager.getFileInfoList()[3]).toEqual({
  //       file: {
  //         reference: pathToRef.get('src/folder/4.txt')!,
  //         historyRef: new Reference(SWARM_ZERO_ADDRESS),
  //       },
  //       batchId: mockBatchId,
  //     });
  //   });
  // });

  // describe('upload and listFiles', () => {
  //   it('should give back correct refs by listFiles, after upload', async () => {
  //     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
  //     const fileManager = await createInitializedFileManager();
  //     const list = fileManager.getFileInfoList();

  //     const uploadResult = {
  //       reference: new Reference('2894fabf569cf8ca189328da14f87eb0578910855b6081871f377b4629c59c4d'),
  //       historyAddress: Optional.of(new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68')),
  //     };
  //     jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue(uploadResult);

  //     const mantaray = new MantarayNode();
  //     mantaray.addFork('src/folder/1.txt', '1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68');
  //     jest.spyOn(fileManager, 'loadMantaray').mockResolvedValue(mantaray);

  //     const paths: ReferenceWithPath[] = await fileManager.listFiles(list[0]);
  //     expect(paths[0].reference.toHex()).toBe('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68');
  //     expect(paths[0].path).toBe('src/folder/1.txt');
  //   });
  // });
});
