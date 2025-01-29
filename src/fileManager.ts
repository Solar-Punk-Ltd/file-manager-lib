import { DATA_PATH } from './constants';
import { FileInfo, ShareItem } from './types';
import fs from 'fs';

export class FileManager {
  private fileInfoList: FileInfo[];

  constructor() {
    this.fileInfoList = [];

    // We said that constructor will load the file info list into memory, but this only works as long as initialize is synchronous.
    this.initialize();
  }

  initialize(): void {
    this.initFileInfoList();
  }

  initFileInfoList(): void {
    const rawData = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(rawData);

    if (!Array.isArray(data.fileInfoList)) {
      throw new TypeError('fileInfoList has to be an array!');
    }

    for (const fileInfo of data.fileInfoList) {
      this.fileInfoList.push(fileInfo);
    }
  }

  getFileInfoList(): FileInfo[] {
    return this.fileInfoList;
  }

  async saveFileInfo(fileInfo: FileInfo): Promise<string> {
    try {
      if (!fileInfo || !fileInfo.batchId || !fileInfo.eFileRef) {
        throw new Error("Invalid fileInfo: 'batchId' and 'eFileRef' are required.");
      }

      const index = this.fileInfoList.length;
      this.fileInfoList.push(fileInfo);
  
      const data = JSON.stringify({ fileInfoList: this.fileInfoList });
      fs.writeFileSync(DATA_PATH, data);
  
      return index.toString();

    } catch (error) {
      console.error("Error saving file info:", error);
      throw new Error("Failed to save file info.");
    }
  }

  listFiles(fileInfo: FileInfo): string[] {
    return [];
  }

  async upload(filePath: string, customMetadata?: Record<string, string>): Promise<string> {
    return '';
  }

  async shareItems(items: ShareItem[], targetOverlays: string[], recipients: string[]): Promise<void> {}
}
