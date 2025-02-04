import { BatchId } from '@ethersphere/bee-js';

import { FILE_INFO_LOCAL_STORAGE } from './constants';
import { FileInfo, ShareItem } from './types';
import { MantarayNode } from '@solarpunkltd/mantaray-js';

export class FileManager {
  private fileInfoList: FileInfo[];
  public mantaray: MantarayNode;

  constructor() {
    this.fileInfoList = [];

    this.mantaray = new MantarayNode();
  }

  async initialize(): Promise<void> {
    await this.initFileInfoList();
  }

  private async initFileInfoList(): Promise<void> {
    const rawData = localStorage.getItem(FILE_INFO_LOCAL_STORAGE);
    if (!rawData) {
      console.error('No data found in data.txt (localStorage');
      return;
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(rawData);

    this.mantaray.deserialize(data);
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

      const data = JSON.stringify(this.fileInfoList);
      localStorage.setItem(FILE_INFO_LOCAL_STORAGE, data);

      return index.toString(16).padStart(64, '0');
    } catch (error) {
      console.error('Error saving file info:', error);
      throw error;
    }
  }

  // fileInfo might point to a folder, or a single file
  // could name downloadFiles as well, possibly
  // getDirectorStructure()
  async listFiles(fileInfo: FileInfo): Promise<string> {
    return fileInfo.eFileRef;
  }

  async upload(batchId: string | BatchId, filePath: string, customMetadata?: Record<string, string>): Promise<string> {
    const fileInfo: FileInfo = {
      eFileRef: filePath,
      batchId: batchId,
      customMetadata,
    };

    const ref = this.saveFileInfo(fileInfo);

    return ref;
  }

  async shareItems(items: ShareItem[], targetOverlays: string[], recipients: string[]): Promise<void> {
    try {
      for (let i = 0; i < items.length; i++) {
        for (let j = 0; j < items[i].fileInfoList.length; j++) {
          const ix = this.fileInfoList.findIndex((fileInfo) => fileInfo.eFileRef === items[i].fileInfoList[j].eFileRef);
          if (ix === -1) {
            throw new Error(`Could not find reference: ${items[i].fileInfoList[j].eFileRef}`);
          }
        }
      }

      for (const shareItem of items) {
        this.sendShareMessage(targetOverlays, shareItem, recipients);
      }
    } catch (error) {
      console.error('There was an error while trying to share items: ', error);
      throw error;
    }
  }

  async sendShareMessage(targetOverlays: string[], item: ShareItem, recipients: string[]): Promise<void> {
    if (recipients.length === 0 || recipients.length !== targetOverlays.length) {
      console.log('Invalid recipients or  targetoverlays specified for sharing.');
      return;
    }

    for (let i = 0; i < recipients.length; i++) {
      try {
        const msgData = new Uint8Array(Buffer.from(JSON.stringify(item)));
        console.log(`Sending message to ${recipients[i]}: `, msgData);
        // Save this to a separate file, like data.txt. msgData should be saved into an array
      } catch (error: any) {
        console.log(`Failed to share item with recipient: ${recipients[i]}\n `, error);
      }
    }
  }
}
