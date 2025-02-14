import { BatchId, Bee, Bytes, MantarayNode, Reference, Topic } from '@upcoming/bee-js';

import { FILE_INFO_LOCAL_STORAGE } from './constants';
import { FileInfo, MantarayStackItem, ShareItem } from './types';
import { assertFileInfo, decodeBytesToPath } from './utils';

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
      eFileRef: new Reference(rawItem.eFileRef),
      topic: rawItem.topic ? new Topic(rawItem.topic) : undefined,
      historyRef: rawItem.historyRef ? new Reference(rawItem.historyRef) : undefined,
      owner: rawItem.owner ? rawItem.owner : undefined,
      fileName: rawItem.fileName,
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
        batchId: item.batchId.toHex(),
        eFileRef: item.eFileRef.toHex(),
        topic: item.topic?.toHex(),
        historyRef: item.historyRef?.toHex(),
        owner: item.owner?.toHex(),
        fileName: item.fileName,
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

  public async loadMantaray(mantarayRef: Reference): Promise<MantarayNode> {
    const mantaray = await MantarayNode.unmarshal(this.bee, mantarayRef);
    await mantaray.loadRecursively(this.bee);
    return mantaray;
  }

  // fileInfo might point to a folder, or a single file
  // could name downloadFiles as well, possibly
  // getDirectorStructure()
  async listFiles(fileInfo: FileInfo): Promise<string[]> {
    // Get the target reference from fileInfo
    const targetRef = new Reference(fileInfo.eFileRef).toHex();
    console.log('Target ref: ', targetRef);

    // Unmarshal (load) the root node from Bee
    const mantaray = await MantarayNode.unmarshal(this.bee, targetRef);
    await mantaray.loadRecursively(this.bee);

    const refList: string[] = [];
    // Start with the root node and an empty path
    const stack: { node: MantarayNode; path: string }[] = [{ node: mantaray, path: '' }];

    while (stack.length > 0) {
      const { node, path } = stack.pop()!;

      // If the current node has forks, iterate over them.
      if (node.forks && node.forks.size > 0) {
        for (const [key, fork] of node.forks.entries()) {
          const prefix: string = fork.prefix ? decodeBytesToPath(fork.prefix) : `${key}` || 'unknown';
          console.log("prefix: ", prefix)
          let fullPath: string = path ? `${path}/${prefix}` : prefix;
          fullPath = fullPath.replace(/\0/g, '');
          console.log("fullPath: ", fullPath);

          if (!fork.node.forks || fork.node.forks.size === 0) {
            // It’s a file—add its full path to the list.
            refList.push(fullPath);
          } else {
            // It’s a directory—push it onto the stack to continue traversing.
            stack.push({ node: fork.node, path: fullPath });
          }
        }
      }
    }

    console.log("This will be returned: ", refList)
    return refList;
  }

  async upload(
    batchId: string | BatchId,
    reference: Reference,
    customMetadata?: Record<string, string>,
  ): Promise<string> {
    const fileInfo: FileInfo = {
      eFileRef: new Reference(reference),
      batchId: new BatchId(batchId),
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
