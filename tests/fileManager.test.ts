import fs from 'fs';

import { FileManager } from '../src/fileManager';

import { fileInfoTxt, emptyFileInfoTxt, extendedFileInfoTxt, mockBatchId } from './mockHelpers';
//import { ShareItem } from 'src/types';


describe('getFileInfoList', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should give back fileInfoList after initialization', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    expect(fileManager.getFileInfoList()).toEqual(JSON.parse(fileInfoTxt));
  });

  it('should give back empty array if data.txt is empty', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(emptyFileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    expect(fileManager.getFileInfoList()).toEqual([]);
  });
});

describe('initialize', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should load FileInfo list into memory', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileInfoTxt);

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
    jest.spyOn(fs, 'readFileSync').mockReturnValue(`{
      "fileInfoList": "not an array"
    }`);
      
     try {
      const fileManager = new FileManager()
      await fileManager.initialize()
      fail("initialize should fail if fileInfo is not an array");
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
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileInfoTxt);
    jest.spyOn(fs, 'writeFileSync').mockReturnValue();
    const writeFileSync = jest.spyOn(fs, 'writeFileSync');

    const fileManager = new FileManager();
    await fileManager.initialize();
    const fileInfo = {
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
      eFileRef: 'src/folder/3.txt',
    };

    const ref = await fileManager.saveFileInfo(fileInfo);

    expect(ref).toBe('2');
    expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), extendedFileInfoTxt);
  });

  it('should throw an error if fileInfo is invalid', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(emptyFileInfoTxt);
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
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileInfoTxt);
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
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
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileInfoTxt);
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
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    await fileManager.upload(mockBatchId, 'src/folder/3.txt');

    expect(fileManager.getFileInfoList()).toHaveLength(3);
    expect(fileManager['fileInfoList'][2]).toEqual({
      eFileRef: 'src/folder/3.txt',
      batchId: 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51',
    });
  });

  it('should give back ref (currently index)', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileInfoTxt);
    const fileManager = new FileManager();
    await fileManager.initialize();

    const ref = await fileManager.upload(mockBatchId, 'src/folder/3.txt');

    expect(ref).toBe('2');
  });

  // consecutive upload
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
        fileInfoList: fileManager['fileInfoList'],
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
  it('should give back correct refs by listFiles, after upload', () => {})
});