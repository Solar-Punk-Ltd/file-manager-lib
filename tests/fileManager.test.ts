import { FileManager } from "../src/fileManager";
import { returnDataTxt } from "./mockHelpers";
import fs from 'fs';


describe('initFileInfoList', () => {
  it('should load FileInfo list into memory', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(returnDataTxt);

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