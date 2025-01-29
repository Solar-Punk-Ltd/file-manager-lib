import { FileManager } from "../src/fileManager";

describe('test if works', () => {
  it('should work', () => {
    const fileManager = new FileManager();
    fileManager.initFileInfoList();
  });
});