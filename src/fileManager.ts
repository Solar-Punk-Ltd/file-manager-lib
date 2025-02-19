import { BatchId, Bee, DownloadOptions, MantarayNode, Reference, Topic } from '@upcoming/bee-js';

import { FILE_INFO_LOCAL_STORAGE, SWARM_ZERO_ADDRESS } from './constants';
import { FileInfo, ReferenceWithPath, ShareItem } from './types';
import { assertFileInfo } from './utils';

export class FileManager {
  private fileInfoList: FileInfo[];
  public bee: Bee;

  constructor() {
    this.fileInfoList = [];
    this.bee = new Bee('http://localhost:1633');
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
    if (!Array.isArray(data)) throw new Error('fileInfoList has to be an array!');

    const processedData: FileInfo[] = data.map((rawItem) => ({
      batchId: new BatchId(rawItem.batchId),
      file: {
        reference: new Reference(rawItem.file.reference),
        historyRef: new Reference(rawItem.file.historyRef),
      },
      topic: rawItem.topic ? new Topic(rawItem.topic) : undefined,
      owner: rawItem.owner ? rawItem.owner : undefined,
      name: rawItem.name,
      timestamp: rawItem.timestamp,
      shared: rawItem.shared,
      preview: rawItem.preview,
      redundancyLevel: rawItem.redundancyLevel,
      customMetadata: rawItem.customMetadata,
    }));

    this.fileInfoList = processedData;
  }

  getFileInfoList(): FileInfo[] {
    return this.fileInfoList;
  }

  async saveFileInfo(fileInfo: FileInfo): Promise<string> {
    try {
      // should we trust that in-memory mantaray is correct, or should we fetch it all the time?
      // if lib is statless, we would fetch it all the time
      assertFileInfo(fileInfo);

      const index = this.fileInfoList.length.toString(16).padStart(64, '0').slice(0, 64);

      this.fileInfoList.push(fileInfo);
      console.log(this.fileInfoList[0].batchId);
      const fileInfoList = this.fileInfoList.map((item) => ({
        batchId: item.batchId.toString(),
        file: {
          reference: item.file.reference.toString(),
          historyRef: item.file.historyRef.toString(),
        },
        topic: item.topic?.toString(),
        owner: item.owner?.toString(),
        name: item.name,
        timestamp: item.timestamp,
        shared: item.shared,
        preview: item.preview,
        redundancyLevel: item.redundancyLevel,
        customMetadata: item.customMetadata,
      }));

      localStorage.setItem(FILE_INFO_LOCAL_STORAGE, JSON.stringify(fileInfoList));

      return index;
    } catch (error) {
      console.error('Error saving file info:', error);
      throw error;
    }
  }

  public async loadMantaray(mantarayRef: Reference, options?: DownloadOptions): Promise<MantarayNode> {
    const mantaray = await MantarayNode.unmarshal(this.bee, mantarayRef, options);
    await mantaray.loadRecursively(this.bee);
    return mantaray;
  }

  // fileInfo might point to a folder, or a single file
  // could name downloadFiles as well, possibly
  // getDirectorStructure()
  async listFiles(fileInfo: FileInfo, options?: DownloadOptions): Promise<ReferenceWithPath[]> {
    const mantaray = await this.loadMantaray(new Reference(fileInfo.file.reference), options);
    // TODO: is filter needed ?

    const fileList = mantaray
      .collect()
      .map((n) => {
        return {
          reference: new Reference(n.targetAddress),
          path: n.fullPathString,
        } as ReferenceWithPath;
      })
      .filter((item) => item.path !== '' && item.reference !== SWARM_ZERO_ADDRESS);

    return fileList;
  }

  async upload(
    batchId: string | BatchId,
    reference: Reference,
    customMetadata?: Record<string, string>,
  ): Promise<string> {
    const fileInfo: FileInfo = {
      file: {
        reference: reference,
        historyRef: SWARM_ZERO_ADDRESS,
      },
      batchId: batchId.toString(),
      customMetadata,
    };

    const ref = this.saveFileInfo(fileInfo);

    return ref;
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
