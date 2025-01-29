import { DATA_PATH } from './constants';
import { FileInfo, ShareItem } from './types';
import fs from 'fs';

export class FileManager {
  private fileInfoList: FileInfo[];

  constructor() {
    this.fileInfoList = [];

    this.initialize();
  }

  async initialize(): Promise<void> {}

  async initFileInfoList(): Promise<void> {
    const rawData = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(rawData);

    if (!Array.isArray(data.fileInfoList)) {
      throw new TypeError('fileInfoList has to be an array!');
    }

    for (const fileInfo of data.fileInfoList) {
      this.fileInfoList.push(fileInfo);
    }
    console.log('FileInfoList loaded:' , this.fileInfoList);
  }

  getFileInfoList(): FileInfo[] {
    return this.fileInfoList;
  }

  async saveFileInfo(fileInfo: FileInfo): Promise<string> {
    return '';
  }

  listFiles(fileInfo: FileInfo): string[] {
    return [];
  }

  async upload(filePath: string, customMetadata?: Record<string, string>): Promise<string> {
    return '';
  }

  async shareItems(items: ShareItem[], targetOverlays: string[], recipients: string[]): Promise<void> {}
}
