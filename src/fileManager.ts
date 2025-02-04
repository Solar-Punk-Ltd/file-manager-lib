import { BatchId } from '@ethersphere/bee-js';

import { FILE_INFO_LOCAL_STORAGE } from './constants';
import { FileInfo, ShareItem } from './types';
import { MantarayNode } from '@solarpunkltd/mantaray-js';
import { mockSaver } from './utils';

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
      console.info('No data found in data.txt (localStorage)');
      return;
    }

    const dataArray = JSON.parse(rawData) as number[];
    const data = new Uint8Array(dataArray);

    this.mantaray.deserialize(data);
  }

  getFileInfoList(): FileInfo[] {
    return this.fileInfoList;
  }

  async saveFileInfo(fileInfo: FileInfo): Promise<string> {
    try {
      // should we trust that in-memory mantaray is correct, or should we fetch it all the time?
      // if lib is statless, we would fetch it all the time
      if (!fileInfo || !fileInfo.batchId || !fileInfo.eFileRef) {
        throw new Error("Invalid fileInfo: 'batchId' and 'eFileRef' are required.");
      }
      const encoder = new TextEncoder();

      // will need to mock Reference here (second parameter)
      this.mantaray.addFork(encoder.encode(fileInfo.fileName), fileInfo.eFileRef as any);

      const data = this.mantaray.serialize();
      const dataArray = Array.from(data); // Convert Uint8Array to a regular array
      localStorage.setItem(FILE_INFO_LOCAL_STORAGE, JSON.stringify(dataArray));

      const ref = this.mantaray.save(mockSaver);
      
      return ref;
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
