import { TextEncoder } from "util";
import { FileManager } from '../src/fileManager';
import { emptyFileInfoTxt, extendedFileInfoTxt, fileInfoTxt, mockBatchId } from './mockHelpers';
//import { ShareItem } from 'src/types';

global.TextEncoder = TextEncoder;

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
      const fileManager = new FileManager();
      await fileManager.initialize();
      fail('initialize should fail if fileInfo is not an array');
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
    const fileInfo = {
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
      eFileRef: 'src/folder/3.txt',
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

    const fileInfo = {
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    };

    try {
      await fileManager.saveFileInfo(fileInfo as any);
      fail('Expected saveFileInfo to throw an error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as any).message).toBe("Invalid fileInfo: 'batchId' and 'eFileRef' are required.");
      expect(fileManagerSpy).toHaveBeenCalledWith(fileInfo as any);
    }
  });

  it('should throw an error if there is an error saving the file info', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    jest.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Error saving file info');
    });

    const fileManager = new FileManager();
    await fileManager.initialize();
    const fileInfo = {
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
      eFileRef: 'src/folder/3.txt',
    };

    try {
      await fileManager.saveFileInfo(fileInfo);
      fail('Expected saveFileInfo to throw an error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as any).message).toBe('Error saving file info');
    }
  });
});

describe('listFiles', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should list paths (refs) for given input list', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
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
    const fileManager = new FileManager();
    await fileManager.initialize();

    await fileManager.upload(mockBatchId, 'src/folder/3.txt');

    expect(fileManager.getFileInfoList()).toHaveLength(3);
    expect(fileManager.getFileInfoList()[2]).toEqual({
      eFileRef: 'src/folder/3.txt',
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    });
  });

  it('should give back ref (currently index)', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    const ref = await fileManager.upload(mockBatchId, 'src/folder/3.txt');

    expect(ref).toBe('0000000000000000000000000000000000000000000000000000000000000002');
  });

  it('should work with consecutive uploads', async () => {
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    await fileManager.upload(mockBatchId, 'src/folder/3.txt');

    expect(fileManager.getFileInfoList()).toHaveLength(3);
    expect(fileManager.getFileInfoList()[2]).toEqual({
      eFileRef: 'src/folder/3.txt',
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    });

    await fileManager.upload(mockBatchId, 'src/folder/4.txt');

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
    jest.spyOn(localStorage, 'getItem').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    let list = fileManager.getFileInfoList();
    let path = await fileManager.listFiles(list[0]);

    expect(path).toBe('src/folder/1.txt');

    await fileManager.upload(mockBatchId, 'src/folder/3.txt');

    list = fileManager.getFileInfoList();
    path = await fileManager.listFiles(list[2]);

    expect(path).toBe('src/folder/3.txt');
  });
});