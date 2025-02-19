import { BeeDev } from '@upcoming/bee-js';

import { FileManager } from '../src/fileManager';

import { emptyFileInfoTxt, extendedFileInfoTxt, fileInfoTxt, mockBatchId } from './mockHelpers';
import { BEE_URL } from './utils';
//import { ShareItem } from 'src/types';

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

const mockBee = new BeeDev(BEE_URL);

describe('initialize', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should load FileInfo list into memory', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);

    const fileManager = new FileManager(mockBee);
    await fileManager.initialize();

    expect(fileManager.getFileInfoList()).toEqual([
      {
        batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
        eFileRef: 'src/folder/1.txt',
      },
      {
        batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
        eFileRef: 'src/folder/2.txt',
      },
    ]);
  });

  it('should throw an error if fileInfoList is not an array', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(`{
      "fileInfoList": "not an array"
    }`);

    try {
      const fileManager = new FileManager(mockBee);
      await fileManager.initialize();
      fail('initialize should fail if fileInfo is not an array');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('fileInfoList has to be an array!');
    }
  });
});

describe('listFiles', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should list paths (refs) for given input list', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager(mockBee);
    await fileManager.initialize();
    const list = fileManager.getFileInfoList();

    const path = await fileManager.listFiles(list[0]);

    expect(path).toBe('src/folder/1.txt');
  });
});

describe('upload', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should save FileInfo', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager(mockBee);
    await fileManager.initialize();

    const f = new File(['Shh!'], 'src/folder/3.txt', { type: 'text/plain' });
    await fileManager.upload(mockBatchId, [f]);

    expect(fileManager.getFileInfoList()).toHaveLength(3);
    expect(fileManager.getFileInfoList()[2]).toEqual({
      eFileRef: 'src/folder/3.txt',
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    });
  });

  it('should give back ref (currently index)', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager(mockBee);
    await fileManager.initialize();

    const f = new File(['Shh!'], 'src/folder/3.txt', { type: 'text/plain' });
    const ref = await fileManager.upload(mockBatchId, [f]);

    expect(ref).toBe('0000000000000000000000000000000000000000000000000000000000000002');
  });

  it('should work with consecutive uploads', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager(mockBee);
    await fileManager.initialize();

    const f = new File(['Shh!'], 'src/folder/3.txt', { type: 'text/plain' });
    await fileManager.upload(mockBatchId, [f]);

    expect(fileManager.getFileInfoList()).toHaveLength(3);
    expect(fileManager.getFileInfoList()[2]).toEqual({
      eFileRef: 'src/folder/3.txt',
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    });

    const f2 = new File(['Shh!'], 'src/folder/4.txt', { type: 'text/plain' });
    await fileManager.upload(mockBatchId, [f2]);

    expect(fileManager.getFileInfoList()).toHaveLength(4);
    expect(fileManager.getFileInfoList()[3]).toEqual({
      eFileRef: 'src/folder/4.txt',
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
    const fileManager = new FileManager(mockBee, ('0').repeat(64));
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
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager(mockBee);
    await fileManager.initialize();

    let list = fileManager.getFileInfoList();
    let path = await fileManager.listFiles(list[0]);

    expect(path).toBe('src/folder/1.txt');

    const f = new File(['Shh!'], 'src/folder/3.txt', { type: 'text/plain' });
    await fileManager.upload(mockBatchId, [f]);

    list = fileManager.getFileInfoList();
    path = await fileManager.listFiles(list[2]);

    expect(path).toBe([f]);
  });
});
