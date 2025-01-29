import { FileManager } from "../src/fileManager";
import { dataTxt, emptyDataTxt, extendedDataTxt } from "./mockHelpers";
import fs from 'fs';


describe('initFileInfoList', () => {
  it('should load FileInfo list into memory', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(dataTxt);

    const fileManager = new FileManager();
    
    expect(fileManager.getFileInfoList()).toEqual([
        {
          "batchId": "ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51",
          "eFileRef": "src/folder/1.txt"
        },
        {
          "batchId": "ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51",
          "eFileRef": "src/folder/2.txt"
        }
      ]);
    });

    it('should throw an error if fileInfoList is not an array', async () => {
        (fs.readFileSync as jest.Mock).mockReturnValue(`{
          "fileInfoList": "not an array"
        }`);
    
        expect(() => new FileManager()).toThrowError("fileInfoList has to be an array!");
    });
});


describe('saveFileInfo', () => {
    it('should save new FileInfo into data.txt', async () => {
        jest.spyOn(fs, 'readFileSync').mockReturnValue(dataTxt);
        const writeFileSync = jest.spyOn(fs, 'writeFileSync');
    
        const fileManager = new FileManager();
        const fileInfo = {
            batchId: "ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51",
            eFileRef: "src/folder/3.txt"
        };
    
        const index = await fileManager.saveFileInfo(fileInfo);
    
        expect(index).toBe('2');
        expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), extendedDataTxt);
    });

    it('should throw an error if fileInfo is invalid', async () => {
      jest.spyOn(fs, 'readFileSync').mockReturnValue(emptyDataTxt);  
      const fileManager = new FileManager();
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
        jest.spyOn(fs, 'readFileSync').mockReturnValue(dataTxt);
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
          throw new Error('Error saving file info');
        });
    
        const fileManager = new FileManager();
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
  it('should list paths (refs) for given input list', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(dataTxt);
    const fileManager = new FileManager();

    const paths = fileManager.listFiles(fileManager['fileInfoList']);

    expect(paths).toHaveLength(2);
    console.log(paths)
    expect(paths[0]).toBe("src/folder/1.txt");
    expect(paths[1]).toBe("src/folder/2.txt");
  });
});