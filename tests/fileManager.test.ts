//import { TextEncoder, TextDecoder } from "util";
import { BatchId, Bee, Bytes, MantarayNode, Reference, UploadResult } from '@upcoming/bee-js';
import { Optional } from 'cafe-utility';

import { FILE_INFO_LOCAL_STORAGE, SWARM_ZERO_ADDRESS } from '../src/constants';
import { FileManager } from '../src/fileManager';
import { FileInfo, ReferenceWithHistory, ReferenceWithPath } from '../src/types';

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

describe('initialize', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should log no data found, if data.txt entry does not exist', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(null);
    const fileManager = new FileManager();
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await fileManager.initialize();

    expect(consoleSpy).toHaveBeenCalledWith('No data found in data.txt (localStorage)');
  });

  it('should load FileInfo list into memory', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);

    const fileManager = new FileManager();
    await fileManager.initialize();

    expect(fileManager.getFileInfoList()).toEqual([
      {
        batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
        file: {
          reference: pathToRef.get('src/folder/1.txt')!,
          historyRef: new Reference(SWARM_ZERO_ADDRESS),
        },
        name: undefined,
        owner: undefined,
        preview: undefined,
        redundancyLevel: undefined,
        shared: undefined,
        timestamp: undefined,
        topic: undefined,
        customMetadata: undefined,
      },
      {
        batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
        file: {
          reference: pathToRef.get('src/folder/2.txt')!,
          historyRef: new Reference(SWARM_ZERO_ADDRESS),
        },
        name: undefined,
        historyRef: undefined,
        owner: undefined,
        preview: undefined,
        redundancyLevel: undefined,
        shared: undefined,
        timestamp: undefined,
        topic: undefined,
        customMetadata: undefined,
      },
    ]);
  });

  it('should throw an error if fileInfoList is not an array', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(`{
      "fileInfoList": "not an array"
    }`);

    try {
      const fileManager = new FileManager();
      await fileManager.initialize();
      throw new Error('initialize should fail if fileInfo is not an array');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('fileInfoList has to be an array!');
    }
  });
});

describe('saveFileInfo', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should save new FileInfo into data.txt', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    jest.spyOn(localStorage, 'setItem').mockReturnValue();
    const writeFileSync = jest.spyOn(localStorage, 'setItem');

    const fileManager = new FileManager();
    await fileManager.initialize();
    const fileInfo: FileInfo = {
      file: {
        historyRef: new Reference(SWARM_ZERO_ADDRESS),
        reference: pathToRef.get('src/folder/3.txt')!,
      },
      batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
    };

    const ref = await fileManager.saveFileInfo(fileInfo);

    expect(ref).toBe('0000000000000000000000000000000000000000000000000000000000000002');
    expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), extendedFileInfoTxt);
  });

  it('should throw an error if fileInfo is invalid', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(emptyFileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();
    const fileManagerSpy = jest.spyOn(fileManager, 'saveFileInfo');

    try {
      const fileInfo: FileInfo = {
        file: {
          reference: pathToRef.get('src/folder/1.txt')!,
          historyRef: pathToRef.get('src/folder/1.txt')!,
        },
        batchId: new BatchId('33'),
      };
      await fileManager.saveFileInfo(fileInfo);
      throw new Error('Expected saveFileInfo to throw an error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as any).message).toBe('Bytes#checkByteLength: bytes length is 1 but expected 32');
    }
  });

  it('should throw an error if there is an error saving the file info', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    jest.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Error saving file info');
    });

    const fileManager = new FileManager();
    await fileManager.initialize();
    try {
      const fileInfo: FileInfo = {
        file: {
          reference: pathToRef.get('src/folder/3.txt')!,
          historyRef: pathToRef.get('src/folder/3.txt')!,
        },
        batchId: new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51'),
      };

      await fileManager.saveFileInfo(fileInfo);
      fail('Expected saveFileInfo to throw an error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as any).message).toBe('Error saving file info');
    }
  });
});

// Updated Test File for `listFiles` using Mantaray JS Implementation

describe('listFiles', () => {
  beforeEach(() => jest.resetAllMocks());

  it('should list paths (refs) for given input list', async () => {
    const expectedPath = 'src/folder/1.txt';
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);

    const fileManager = new FileManager();
    await fileManager.initialize();

    const uploadResult = {
      reference: new Reference('2894fabf569cf8ca189328da14f87eb0578910855b6081871f377b4629c59c4d'),
      historyAddress: Optional.of(new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68')),
    };
    jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue(uploadResult);

    const mantaray = new MantarayNode();
    mantaray.addFork('src/folder/1.txt', '1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68');

    const first = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 87, 104, 179, 182,
      167, 219, 86, 210, 29, 26, 191, 244, 13, 65, 206, 191, 200, 52, 72, 254, 216, 215, 233, 176, 110, 192, 211, 176,
      115, 242, 143, 32, 26, 154, 208, 58, 169, 147, 213, 238, 85, 13, 174, 194, 228, 223, 72, 41, 253, 153, 204, 35,
      153, 62, 167, 211, 224, 121, 125, 211, 50, 83, 253, 104, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const second = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 87, 104, 179, 182,
      167, 219, 86, 210, 29, 26, 191, 244, 13, 65, 206, 191, 200, 52, 72, 254, 216, 215, 233, 176, 110, 192, 211, 176,
      115, 242, 143, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 16, 115, 114,
      99, 47, 102, 111, 108, 100, 101, 114, 47, 49, 46, 116, 120, 116, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 148, 0,
      17, 119, 248, 231, 159, 158, 240, 146, 107, 58, 95, 110, 135, 168, 220, 196, 216, 79, 98, 210, 143, 97, 225, 35,
      59, 60, 200, 178, 218, 27,
    ]);

    const downloadDataSpy = jest
      .spyOn(Bee.prototype, 'downloadData')
      .mockImplementationOnce(async () => new Bytes(second))
      .mockImplementation(async () => new Bytes(first));

    const list = fileManager.getFileInfoList();
    console.log('List: ', list[0].file.reference.toString());
    const paths = await fileManager.listFiles(list[0]);

    console.log('Calls: ', downloadDataSpy.mock.calls);
    console.log('Paths: ', paths);

    const expectedFirstRef = new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68');
    console.log('expected first ref: ', expectedFirstRef);

    //expect(downloadDataSpy).toHaveBeenNthCalledWith( 1, expectedFirstRef );
    //expect(downloadDataSpy).toHaveBeenLastCalledWith(uploadResult.reference.toUint8Array());
    expect(paths[0].path).toBe(expectedPath);
  });
});

describe('upload', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should save FileInfo', async () => {
    const fileManager = new FileManager();
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    localStorage.setItem(FILE_INFO_LOCAL_STORAGE, fileInfoTxt);
    await fileManager.initialize();

    await fileManager.upload(mockBatchId, pathToRef.get('src/folder/3.txt')!);

    expect(fileManager.getFileInfoList()).toHaveLength(3);
    expect(fileManager.getFileInfoList()[2]).toEqual({
      file: {
        reference: pathToRef.get('src/folder/3.txt')!,
        historyRef: new Reference(SWARM_ZERO_ADDRESS),
      },
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    });
  });

  it('should give back ref (currently index)', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    const ref = await fileManager.upload(mockBatchId, pathToRef.get('src/folder/3.txt')!);

    expect(ref).toBe('0000000000000000000000000000000000000000000000000000000000000002');
  });

  it('should work with consecutive uploads', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    await fileManager.upload(mockBatchId, pathToRef.get('src/folder/3.txt')!);

    expect(fileManager.getFileInfoList()).toHaveLength(3);
    expect(fileManager.getFileInfoList()[2]).toEqual({
      file: {
        reference: pathToRef.get('src/folder/3.txt')!,
        historyRef: new Reference(SWARM_ZERO_ADDRESS),
      },
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    });

    await fileManager.upload(mockBatchId, pathToRef.get('src/folder/4.txt')!);

    expect(fileManager.getFileInfoList()).toHaveLength(4);
    expect(fileManager.getFileInfoList()[3]).toEqual({
      file: {
        reference: pathToRef.get('src/folder/4.txt')!,
        historyRef: new Reference(SWARM_ZERO_ADDRESS),
      },
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    });
  });
});

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

describe('upload and listFiles', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should give back correct refs by listFiles, after upload', async () => {
    const fileManager = new FileManager();
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    await fileManager.initialize();

    const list = fileManager.getFileInfoList();

    console.log('List: ', list);

    const uploadResult = {
      reference: new Reference('2894fabf569cf8ca189328da14f87eb0578910855b6081871f377b4629c59c4d'),
      historyAddress: Optional.of(new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68')),
    };
    jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue(uploadResult);

    const mantaray = new MantarayNode();
    mantaray.addFork('src/folder/1.txt', '1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68');

    const first = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 87, 104, 179, 182,
      167, 219, 86, 210, 29, 26, 191, 244, 13, 65, 206, 191, 200, 52, 72, 254, 216, 215, 233, 176, 110, 192, 211, 176,
      115, 242, 143, 32, 26, 154, 208, 58, 169, 147, 213, 238, 85, 13, 174, 194, 228, 223, 72, 41, 253, 153, 204, 35,
      153, 62, 167, 211, 224, 121, 125, 211, 50, 83, 253, 104, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const second = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 87, 104, 179, 182,
      167, 219, 86, 210, 29, 26, 191, 244, 13, 65, 206, 191, 200, 52, 72, 254, 216, 215, 233, 176, 110, 192, 211, 176,
      115, 242, 143, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 16, 115, 114,
      99, 47, 102, 111, 108, 100, 101, 114, 47, 49, 46, 116, 120, 116, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 148, 0,
      17, 119, 248, 231, 159, 158, 240, 146, 107, 58, 95, 110, 135, 168, 220, 196, 216, 79, 98, 210, 143, 97, 225, 35,
      59, 60, 200, 178, 218, 27,
    ]);

    const downloadDataSpy = jest
      .spyOn(Bee.prototype, 'downloadData')
      .mockImplementationOnce(async () => new Bytes(second))
      .mockImplementation(async () => new Bytes(first));

    const path: ReferenceWithPath[] = await fileManager.listFiles(list[0]);

    expect(path[0].reference.toHex()).toBe('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68');
    expect(path[0].path).toBe('src/folder/1.txt');

    // await fileManager.upload(mockBatchId, pathToRef.get('src/folder/3.txt')!);

    // list = fileManager.getFileInfoList();
    // path = await fileManager.listFiles(list[2]);

    // expect(path).toBe('src/folder/3.txt');
  });
});
