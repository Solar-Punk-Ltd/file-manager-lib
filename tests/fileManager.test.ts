//import { TextEncoder, TextDecoder } from "util";
import { BatchId, Bee, Bytes, MantarayNode, Reference, UploadResult } from '@upcoming/bee-js';
import { Optional } from 'cafe-utility';

import { FILE_INFO_LOCAL_STORAGE } from '../src/constants';
import { FileManager } from '../src/fileManager';
import { FileInfo } from '../src/types';

import {
  createMockMantarayNode,
  emptyFileInfoTxt,
  extendedFileInfoTxt,
  fileInfoTxt,
  mockBatchId,
  MockLocalStorage,
  pathToRef,
} from './mockHelpers';
import { downloadDataMock, MOCK_SERVER_URL, uploadDataMock } from './nock';
//import { ShareItem } from 'src/types';

//global.TextEncoder = TextEncoder;
//global.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder;

Object.defineProperty(global, 'localStorage', {
  value: {
    getItem: jest.fn(() => null),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn(),
    length: 0,
    key: jest.fn(),
  },
  writable: true,
});

// describe('initialize', () => {
//   beforeEach(() => {
//     jest.resetAllMocks();
//   });

//   it('should log no data found, if data.txt entry does not exist', async () => {
//     jest.spyOn(localStorage, 'getItem').mockReturnValue(null);
//     const fileManager = new FileManager();
//     const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

//     await fileManager.initialize();

//     expect(consoleSpy).toHaveBeenCalledWith('No data found in data.txt (localStorage)');
//   });

//   it('should load FileInfo list into memory', async () => {
//     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);

//     const fileManager = new FileManager();
//     await fileManager.initialize();

//     expect(fileManager.getFileInfoList()).toEqual([
//       {
//         batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
//         eFileRef: new Reference(pathToRef.get('src/folder/1.txt')!),
//         fileName: undefined,
//         historyRef: undefined,
//         owner: undefined,
//         preview: undefined,
//         redundancyLevel: undefined,
//         shared: undefined,
//         timestamp: undefined,
//         topic: undefined,
//         customMetadata: undefined,
//       },
//       {
//         batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
//         eFileRef: new Reference(pathToRef.get('src/folder/2.txt')!),
//         fileName: undefined,
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
//     jest.spyOn(localStorage, 'getItem').mockReturnValue(`{
//       "fileInfoList": "not an array"
//     }`);

//     try {
//       const fileManager = new FileManager();
//       await fileManager.initialize();
//       throw new Error('initialize should fail if fileInfo is not an array');
//     } catch (error) {
//       expect(error).toBeInstanceOf(Error);
//       expect((error as Error).message).toBe('fileInfoList has to be an array!');
//     }
//   });
// });

// describe('saveFileInfo', () => {
//   beforeEach(() => {
//     jest.resetAllMocks();
//   });

//   it('should save new FileInfo into data.txt', async () => {
//     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
//     jest.spyOn(localStorage, 'setItem').mockReturnValue();
//     const writeFileSync = jest.spyOn(localStorage, 'setItem');

//     const fileManager = new FileManager();
//     await fileManager.initialize();
//     const fileInfo: FileInfo = {
//       batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
//       eFileRef: new Reference(pathToRef.get('src/folder/3.txt')!),
//     };

//     const ref = await fileManager.saveFileInfo(fileInfo);

//     expect(ref).toBe('0000000000000000000000000000000000000000000000000000000000000002');
//     expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), extendedFileInfoTxt);
//   });

//   it('should throw an error if fileInfo is invalid', async () => {
//     jest.spyOn(localStorage, 'getItem').mockReturnValue(emptyFileInfoTxt);
//     const fileManager = new FileManager();
//     await fileManager.initialize();
//     const fileManagerSpy = jest.spyOn(fileManager, 'saveFileInfo');

//     try {
//       const fileInfo = {
//         batchId: new BatchId('33'),
//         eFileRef: new Reference(pathToRef.get('src/folder/1.txt')!),
//       };
//       await fileManager.saveFileInfo(fileInfo);
//       throw new Error('Expected saveFileInfo to throw an error');
//     } catch (error) {
//       expect(error).toBeInstanceOf(Error);
//       expect((error as any).message).toBe('Bytes#checkByteLength: bytes length is 1 but expected 32');
//     }
//   });

//   it('should throw an error if there is an error saving the file info', async () => {
//     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
//     jest.spyOn(localStorage, 'setItem').mockImplementation(() => {
//       throw new Error('Error saving file info');
//     });

//     const fileManager = new FileManager();
//     await fileManager.initialize();
//     try {
//       const fileInfo = {
//         batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
//         eFileRef: new Reference(pathToRef.get('src/folder/3.txt')!),
//       };

//       await fileManager.saveFileInfo(fileInfo);
//       fail('Expected saveFileInfo to throw an error');
//     } catch (error) {
//       expect(error).toBeInstanceOf(Error);
//       expect((error as any).message).toBe('Error saving file info');
//     }
//   });
// });

// Updated Test File for `listFiles` using Mantaray JS Implementation

describe('listFiles', () => {
  beforeEach(() => jest.resetAllMocks());

  it('should list paths (refs) for given input list', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);

    const fileManager = new FileManager();
    await fileManager.initialize();

    const mockBatchId = new BatchId('6f41dd9a54a0650cf7ed3eab0605ba386d6fcd4ee8650302fe34cf5ea986c794');
    const uploadResult = {
      reference: new Reference('2894fabf569cf8ca189328da14f87eb0578910855b6081871f377b4629c59c4d'),
      historyAddress: Optional.of(new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68')),
    };
    jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue(uploadResult);

    const mantaray = new MantarayNode();
    mantaray.addFork('hello.txt', '9'.repeat(64));
    try {
      await mantaray.saveRecursively(new Bee(MOCK_SERVER_URL), mockBatchId.toHex());
    } catch (error) {
      console.log(error);
      throw error;
    }

    // Root Node
    const forkRef = '9'.repeat(64);
    const rootNode = new MantarayNode();
    rootNode.addFork('hello.txt', forkRef);

    jest
      .spyOn(Bee.prototype, 'downloadData')
      .mockImplementationOnce(async () => new Bytes(await rootNode.marshal()))
      .mockImplementation(async () => new Bytes(await new MantarayNode().marshal()));   // Default Empty Node for Unmatched Refs
      // I think this shouldn't be here, this is not the real behavior for unmatched refs

    const paths = await fileManager.listFiles(fileManager.getFileInfoList()[0]);
    console.log("Paths: ", paths)
    expect(paths[0]).toBe('hello.txt');
  });
});

// describe('upload', () => {
//   let originalLocalStorage: Storage;

//   beforeEach(() => {
//     jest.resetAllMocks();
//     originalLocalStorage = global.localStorage;
//     Object.defineProperty(global, 'localStorage', {
//       value: new MockLocalStorage(),
//       writable: true,
//       configurable: true,
//     });
//   });

//   afterEach(() => {
//     Object.defineProperty(global, 'localStorage', {
//       value: originalLocalStorage,
//       writable: true,
//     });
//     jest.restoreAllMocks();
//   });

//   it('should save FileInfo', async () => {
//     const fileManager = new FileManager();
//     localStorage.setItem(FILE_INFO_LOCAL_STORAGE, fileInfoTxt);
//     await fileManager.initialize();

//     await fileManager.upload(mockBatchId, pathToRef.get('src/folder/3.txt')!);

//     expect(fileManager.getFileInfoList()).toHaveLength(3);
//     expect(fileManager.getFileInfoList()[2]).toEqual({
//       eFileRef: 'src/folder/3.txt',
//       batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
//     });
//   });

//   it('should give back ref (currently index)', async () => {
//     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
//     const fileManager = new FileManager();
//     await fileManager.initialize();

//     const ref = await fileManager.upload(mockBatchId, pathToRef.get('src/folder/3.txt')!);

//     expect(ref).toBe('0000000000000000000000000000000000000000000000000000000000000003');
//   });

//   it('should work with consecutive uploads', async () => {
//     jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
//     const fileManager = new FileManager();
//     await fileManager.initialize();

//     await fileManager.upload(mockBatchId, pathToRef.get('src/folder/3.txt')!);

//     expect(fileManager.getFileInfoList()).toHaveLength(3);
//     expect(fileManager.getFileInfoList()[2]).toEqual({
//       eFileRef: pathToRef.get('src/folder/3.txt')!,
//       batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
//     });

//     await fileManager.upload(mockBatchId, pathToRef.get('src/folder/4.txt')!);

//     expect(fileManager.getFileInfoList()).toHaveLength(4);
//     expect(fileManager.getFileInfoList()[3]).toEqual({
//       eFileRef: pathToRef.get('src/folder/4.txt')!,
//       batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
//     });
//   });
// });

/*
describe('shareItems', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should call sendShareMessage', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(dataTxt);
    const sendShareMessageSpy = jest.spyOn(FileManager as any, 'sendShareMessage');
    const fileManager = new FileManager();
    await fileManager.initialize();

    const items: ShareItem[] = [
      {
        fileInfoList: fileManager.getFileInfoList(),
        message: "Dear Friend! I'm sharing these files with you.",
        timestamp: 100
      }
    ];

    const targetOverlays = [ "friendsOverlay" ];
    const addresses = [ "friendsAddress" ];

    fileManager.shareItems(items, targetOverlays, addresses);

    expect(sendShareMessageSpy).toHaveBeenCalledTimes(1);
  });
});
*/

// describe('upload and listFiles', () => {
//   let originalLocalStorage: Storage;

//   beforeEach(() => {
//     jest.resetAllMocks();
//     originalLocalStorage = global.localStorage;
//     Object.defineProperty(global, 'localStorage', {
//       value: new MockLocalStorage(),
//       writable: true,
//       configurable: true,
//     });
//   });

//   afterEach(() => {
//     Object.defineProperty(global, 'localStorage', {
//       value: originalLocalStorage,
//       writable: true,
//     });
//     jest.restoreAllMocks();
//   });

//   it('should give back correct refs by listFiles, after upload', async () => {
//     const fileManager = new FileManager();
//     localStorage.setItem(FILE_INFO_LOCAL_STORAGE, fileInfoTxt);
//     await fileManager.initialize();

//     let list = fileManager.getFileInfoList();
//     const listt: FileInfo[] = [
//       {
//         batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
//         eFileRef: new Reference('c14653e8d747c6dc6ddefd39688391189e686236aec361637b22d5f138329f5c'),
//       },
//     ];
//     let path = await fileManager.listFiles(listt[0]);

//     expect(path).toBe('c14653e8d747c6dc6ddefd39688391189e686236aec361637b22d5f138329f5c');
//     expect(path).toBe('src/folder/1.txt');

//     await fileManager.upload(mockBatchId, pathToRef.get('src/folder/3.txt')!);

//     list = fileManager.getFileInfoList();
//     path = await fileManager.listFiles(list[2]);

//     expect(path).toBe('src/folder/3.txt');
//   });
// });
