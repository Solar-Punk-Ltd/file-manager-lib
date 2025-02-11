import { BatchId, Bee, MantarayNode, Reference } from '@upcoming/bee-js';

import { FILE_INFO_LOCAL_STORAGE } from './constants';
import { FileInfo, MantarayStackItem, ShareItem } from './types';
import { assertFileInfo, decodeBytesToPath } from './utils';

export class FileManager {
  private fileInfoList: FileInfo[];
  public bee: Bee;

  constructor() {
    this.fileInfoList = [];
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

    const data = JSON.parse(rawData) as FileInfo[];
    if (!Array.isArray(data)) throw new Error("fileInfoList has to be an array!");

    this.fileInfoList = data;
  }

  getFileInfoList(): FileInfo[] {
    return this.fileInfoList;
  }

  async saveFileInfo(fileInfo: FileInfo): Promise<string> {
    try {
      // should we trust that in-memory mantaray is correct, or should we fetch it all the time?
      // if lib is statless, we would fetch it all the time
      assertFileInfo(fileInfo);
      //assertBatchId(fileInfo.batchId);
      //assertReference(fileInfo.eFileRef);

      localStorage.setItem(FILE_INFO_LOCAL_STORAGE, JSON.stringify(this.fileInfoList));

      return this.fileInfoList.length.toString(16).padStart(64, '0').slice(0, 64);
    } catch (error) {
      console.error('Error saving file info:', error);
      throw error;
    }
  }

  // fileInfo might point to a folder, or a single file
  // could name downloadFiles as well, possibly
  // getDirectorStructure()
  async listFiles(fileInfo: FileInfo): Promise<Reference[]> {
    const targetRef = fileInfo.eFileRef as Reference;
    console.log('targetRef: ', targetRef);
    const mantaray = await MantarayNode.unmarshal(this.bee, targetRef);

    const refList: Reference[] = [];
    let stack: MantarayStackItem[] = [{ node: mantaray, path: '' }];
    let found = false;

    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) continue;
      const { node: currentMantaray, path: currentPath } = item;
      const forks = currentMantaray.forks;

      if (!forks) continue;

      for (const [key, fork] of Object.entries(forks)) {
        const prefix = fork.prefix ? decodeBytesToPath(fork.prefix) : key || 'unknown'; // Decode path
        const fullPath = currentPath.endsWith('/') ? `${currentPath}${prefix}` : `${currentPath}/${prefix}`;

        console.log('fork.node.getEntry: ', fork.node.getEntry);
        console.log(`fork.node.getEntry === targetRef:  ${fork.node.getEntry} === ${targetRef}`);
        console.log('fork.node.getEntry === targetRef: ', fork.node.getEntry === targetRef);
        if (fork.node.getEntry === targetRef && !found) {
          stack = [item];
          found = true;
        }

        if (fork.node.isValueType() && found) {
          if (fork.node.getEntry) refList.push(fork.node.getEntry);
        } else {
          stack.push({ node: fork.node, path: fullPath });
        }
      }
    }

    return refList;
  }

  async upload(batchId: string | BatchId, filePath: string, customMetadata?: Record<string, string>): Promise<string> {
    const fileInfo: FileInfo = {
      eFileRef: filePath,
      batchId: batchId,
      customMetadata,
    };

    this.fileInfoList.push(fileInfo);

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
