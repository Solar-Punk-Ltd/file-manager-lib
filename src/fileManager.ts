import { FileInfo, ShareItem } from './types';

export class FileManager {
  private fileInfoList: FileInfo[];

  constructor() {
    this.fileInfoList = [];

    this.initialize();
  }

  async initialize(): Promise<void> {}

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
