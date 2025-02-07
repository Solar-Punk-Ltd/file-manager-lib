import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  EthAddress,
  GetGranteesResult,
  GranteesResult,
  MantarayNode,
  NodeAddresses,
  NULL_TOPIC,
  PostageBatch,
  PrivateKey,
  PssSubscription,
  RedundancyLevel,
  Reference,
  STAMPS_DEPTH_MAX,
  Topic,
  Utils,
} from '@upcoming/bee-js';
import { readFileSync } from 'fs';
import path from 'path';

import {
  FILE_INFO_LOCAL_STORAGE,
  FILEIINFO_NAME,
  FILEINFO_HISTORY_NAME,
  OWNER_FEED_STAMP_LABEL,
  REFERENCE_LIST_TOPIC,
  ROOT_PATH,
  SHARED_INBOX_TOPIC,
  SWARM_ZERO_ADDRESS,
} from './utils/constants';
import { BeeVersionError, StampError } from './utils/errors';
import { FetchFeedUpdateResponse, FileInfo, ReferenceWithHistory, ShareItem, WrappedMantarayFeed } from './utils/types';
import {
  assertFileInfo,
  assertReferenceWithHistory,
  assertShareItem,
  assertWrappedMantarayFeed,
  getContentType,
  getRandomTopic,
  isNotFoundError,
  makeBeeRequestOptions,
  makeNumericIndex,
  numberToFeedIndex,
} from './utils/utils';

export class FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private nodeAddresses: NodeAddresses;
  private stampList: PostageBatch[];
  private mantarayFeedList: WrappedMantarayFeed[];
  private fileInfoList: FileInfo[];
  private nextOwnerFeedIndex: number;
  private sharedWithMe: ShareItem[];
  private sharedSubscription: PssSubscription | undefined;
  private ownerFeedTopic: Topic;

  constructor(bee: Bee) {
    this.bee = bee;
    if (!this.bee.signer) {
      throw new Error('Signer required');
    }
    this.signer = this.bee.signer;
    this.stampList = [];
    this.fileInfoList = [];
    this.mantarayFeedList = [];
    this.nextOwnerFeedIndex = 0;
    this.ownerFeedTopic = NULL_TOPIC;
    this.sharedWithMe = [];
    this.sharedSubscription = undefined;
  }

  // Start init methods
  async initialize(): Promise<void> {
    await this.verifySupportedVersions();
    await this.initNodeAddresses();
    await this.initStamps();
    await this.initOwnerFeedTopic();
    await this.initMantarayFeedList();
    await this.initFileInfoList();
  }

  private async verifySupportedVersions(): Promise<void> {
    const beeVersions = await this.bee.getVersions();
    console.log(`Bee version: ${beeVersions.beeVersion}`);
    console.log(`Bee API version: ${beeVersions.beeApiVersion}`);
    const supportedBee = await this.bee.isSupportedExactVersion();
    const supportedApi = await this.bee.isSupportedApiVersion();
    const majorVersionMatch =
      beeVersions.beeVersion.substring(0, 4) === beeVersions.supportedBeeVersion.substring(0, 4);
    if ((!supportedBee && !majorVersionMatch) || !supportedApi) {
      console.log('Supported bee API version: ', beeVersions.supportedBeeApiVersion);
      console.log('Supported bee version: ', beeVersions.supportedBeeVersion);
      throw new BeeVersionError('Bee or Bee API version not supported');
    }
  }

  private async initNodeAddresses(): Promise<void> {
    this.nodeAddresses = await this.bee.getNodeAddresses();
  }

  private async initOwnerFeedTopic(): Promise<void> {
    const feedTopicData = await this.getFeedData(REFERENCE_LIST_TOPIC, 0);

    if (feedTopicData.payload === SWARM_ZERO_ADDRESS) {
      const ownerFeedStamp = this.getOwnerFeedStamp();
      if (ownerFeedStamp === undefined) {
        throw new StampError('Owner stamp not found');
      }

      this.ownerFeedTopic = getRandomTopic();
      const topicDataRes = await this.bee.uploadData(ownerFeedStamp.batchID, this.ownerFeedTopic.toUint8Array(), {
        act: true,
      });
      const fw = this.bee.makeFeedWriter(REFERENCE_LIST_TOPIC, this.signer);
      await fw.upload(ownerFeedStamp.batchID, topicDataRes.reference, { index: numberToFeedIndex(0) });
      await fw.upload(ownerFeedStamp.batchID, topicDataRes.historyAddress, {
        index: numberToFeedIndex(1),
      });
    } else {
      const topicHistory = await this.getFeedData(REFERENCE_LIST_TOPIC, 1);
      const options = makeBeeRequestOptions(new Reference(topicHistory.payload), this.nodeAddresses.publicKey);

      const topicBytes = await this.bee.downloadData(new Reference(feedTopicData.payload), options);
      this.ownerFeedTopic = new Topic(topicBytes);
    }
  }

  private async initStamps(): Promise<void> {
    try {
      this.stampList = await this.getUsableStamps();
      console.log('Usable stamps fetched successfully.');
    } catch (error: any) {
      console.error(`Failed to fetch stamps: ${error}`);
    }
  }

  private async initMantarayFeedList(): Promise<void> {
    const latestFeedData = await this.getFeedData(this.ownerFeedTopic);
    if (latestFeedData.payload === SWARM_ZERO_ADDRESS) {
      console.log("Owner mantaray feed list doesn't exist yet.");
      return;
    }

    this.nextOwnerFeedIndex = makeNumericIndex(latestFeedData.feedIndexNext);
    const refWithHistory = latestFeedData.payload.toJSON() as ReferenceWithHistory;
    assertReferenceWithHistory(refWithHistory);

    const options = makeBeeRequestOptions(refWithHistory.historyRef as Reference, this.nodeAddresses.publicKey);
    const mantarayFeedListRawData = await this.bee.downloadData(refWithHistory.reference, options);
    const mantarayFeedListData = mantarayFeedListRawData.toJSON() as WrappedMantarayFeed[];

    for (const wmf of mantarayFeedListData) {
      try {
        assertWrappedMantarayFeed(wmf);
        this.mantarayFeedList.push(wmf);
      } catch (error: any) {
        console.error(`Invalid WrappedMantarayFeed item, skipping it: ${error}`);
      }
    }

    console.log('Mantaray feed list fetched successfully.');
  }

  private async getForkData(mantaray: MantarayNode, forkPath: string, options?: BeeRequestOptions): Promise<Bytes> {
    const node = mantaray.collect().find((n) => n.fullPathString === forkPath);
    if (!node) return SWARM_ZERO_ADDRESS;
    const targetRef = new Reference(node.targetAddress);

    return await this.bee.downloadData(targetRef, options);
  }

  // TODO: at this point we already have the efilerRef, so we can use it to fetch the data
  // TODO: loadallnodes and deserialize works but load() doesn't work -> why ?
  // TODO: already unwrapped historyRef by bee ?
  private async initFileInfoList(): Promise<void> {
    // TODO: leave publickey get out of the for loop
    for (const mantaryFeedItem of this.mantarayFeedList) {
      console.log('bagoy mantaryFeedItem: ', mantaryFeedItem);
      // const feedOptions = makeBeeRequestOptions(mantaryFeedItem.historyRef,  this.nodeAddresses.publicKey);
      const wrappedMantarayData = await this.getFeedData(
        mantaryFeedItem.reference as Topic,
        0, // TODO: if index is provided then it calls the chunk api, if undefined then it calls the feed api to lookup
        // feedOptions, // TODO: commented out the act options because it can download without it but whyy ? it was uploaded via act
      );

      if (wrappedMantarayData.payload === SWARM_ZERO_ADDRESS) {
        console.log(`mantaryFeedItem not found, skipping it, reference: ${mantaryFeedItem.reference.toString()}`);
        continue;
      }

      const wrappedMantaryRef = new Reference(wrappedMantarayData.payload);
      const mantaray = await MantarayNode.unmarshal(this.bee, wrappedMantaryRef);
      await mantaray.loadRecursively(this.bee);
      const fileInfoHistoryRef = await this.getForkData(mantaray, FILEINFO_HISTORY_NAME);

      const options = makeBeeRequestOptions(new Reference(fileInfoHistoryRef), this.nodeAddresses.publicKey);
      const fileInfoRawData = await this.getForkData(mantaray, FILEIINFO_NAME, options);
      const fileInfoData = fileInfoRawData.toJSON() as FileInfo;

      try {
        assertFileInfo(fileInfoData);
        this.fileInfoList.push(fileInfoData);
      } catch (error: any) {
        console.error(`Invalid FileInfo item, skipping it: ${error}`);
      }
    }

    console.log('File info list fetched successfully.');
  }

  // End init methods

  // Start getter methods
  getFileInfoList(): FileInfo[] {
    return this.fileInfoList;
  }

  getSharedWithMe(): ShareItem[] {
    return this.sharedWithMe;
  }

  getNodeAddresses(): NodeAddresses {
    return this.nodeAddresses;
  }
  // End getter methods

  // TODO: use all the params of the currentfileinfo if exists?
  // TODO: batchId vs currentFileInfo.batchId ?
  async upload(batchId: BatchId, mantaray: MantarayNode, file: string, currentFileInfo?: FileInfo): Promise<void> {
    const redundancyLevel = currentFileInfo?.redundancyLevel || RedundancyLevel.MEDIUM;
    const uploadFileRes = await this.uploadFile(batchId, file, currentFileInfo);

    // TODO: store feed index in fileinfo to speed up upload? -> undifined == 0, index otherwise
    const topic = currentFileInfo?.topic || getRandomTopic();
    // need .toString() for the stringify
    const fileInfoRes = await this.uploadFileInfo({
      batchId: batchId.toString(),
      eFileRef: uploadFileRes.reference.toString(),
      topic: topic.toString(),
      historyRef: uploadFileRes.historyRef.toString(),
      owner: this.nodeAddresses.ethereum.toString(),
      fileName: path.basename(file),
      timestamp: new Date().getTime(),
      shared: false,
      preview: currentFileInfo?.preview,
      redundancyLevel: redundancyLevel,
      customMetadata: currentFileInfo?.customMetadata,
    });
    mantaray.addFork(ROOT_PATH + FILEIINFO_NAME, fileInfoRes.reference, {
      'Content-Type': 'application/json',
      Filename: FILEIINFO_NAME,
    });
    // TODO: is fileinfo ACT needed?
    const uploadHistoryRes = await this.uploadFileInfoHistory(
      batchId,
      fileInfoRes.historyRef as Reference,
      redundancyLevel,
    );
    mantaray.addFork(ROOT_PATH + FILEINFO_HISTORY_NAME, uploadHistoryRes.historyRef);

    // TODO: consider using calculateSelfAddress
    // TODO: would saveRecursively work with ACT ? -> decrypt probably not
    const wrappedMantarayRef = await mantaray.saveRecursively(this.bee, batchId);
    const wrappedFeedUpdateRes = await this.updateWrappedMantarayFeed(batchId, wrappedMantarayRef, topic as Topic);

    const feedUpdate: WrappedMantarayFeed = {
      reference: topic.toString(),
      historyRef: wrappedFeedUpdateRes.historyRef.toString(),
      eFileRef: fileInfoRes.reference.toString(), // TODO: why  fileInfoRes.reference instead of eFileRef ?
    };
    const ix = this.mantarayFeedList.findIndex((f) => f.reference === feedUpdate.reference);
    if (ix !== -1) {
      this.mantarayFeedList[ix] = { ...feedUpdate, eGranteeRef: this.mantarayFeedList[ix].eGranteeRef };
    } else {
      this.mantarayFeedList.push(feedUpdate);
    }

    await this.saveMantarayFeedList();
  }

  private async uploadFile(
    batchId: BatchId,
    file: string,
    currentFileInfo: FileInfo | undefined = undefined,
  ): Promise<ReferenceWithHistory> {
    console.log(`Uploading file: ${file}`);
    const filePath = path.resolve(__dirname, file);
    const fileData = new Uint8Array(readFileSync(filePath));
    const fileName = path.basename(file);
    const contentType = getContentType(file);

    try {
      const options = makeBeeRequestOptions(currentFileInfo?.historyRef as Reference);
      const uploadFileRes = await this.bee.uploadFile(
        batchId,
        fileData,
        fileName,
        {
          act: true,
          redundancyLevel: currentFileInfo?.redundancyLevel || RedundancyLevel.MEDIUM,
          contentType: contentType,
        },
        options,
      );

      console.log(`File uploaded successfully: ${fileName}, Reference: ${uploadFileRes.reference.toString()}`);
      return { reference: uploadFileRes.reference, historyRef: new Reference(uploadFileRes.historyAddress) };
    } catch (error: any) {
      throw `Failed to upload file ${file}: ${error}`;
    }
  }

  private async uploadFileInfo(fileInfo: FileInfo): Promise<ReferenceWithHistory> {
    try {
      const uploadInfoRes = await this.bee.uploadData(fileInfo.batchId, JSON.stringify(fileInfo), {
        act: true,
        redundancyLevel: fileInfo.redundancyLevel,
      });
      console.log('Fileinfo updated: ', uploadInfoRes.reference.toString());

      this.fileInfoList.push(fileInfo);

      return { reference: uploadInfoRes.reference, historyRef: new Reference(uploadInfoRes.historyAddress) };
    } catch (error: any) {
      throw `Failed to save fileinfo: ${error}`;
    }
  }

  private async uploadFileInfoHistory(
    batchId: BatchId,
    hisoryRef: Reference,
    redundancyLevel: RedundancyLevel = RedundancyLevel.MEDIUM,
  ): Promise<ReferenceWithHistory> {
    try {
      const uploadHistoryRes = await this.bee.uploadData(batchId, hisoryRef.toUint8Array(), {
        redundancyLevel: redundancyLevel,
      });

      console.log('Fileinfo history updated: ', uploadHistoryRes.reference.toString());

      return { reference: uploadHistoryRes.reference, historyRef: uploadHistoryRes.reference };
    } catch (error: any) {
      throw `Failed to save fileinfo history: ${error}`;
    }
  }

  private async updateWrappedMantarayFeed(
    batchId: BatchId,
    wrappedMantarayRef: Reference,
    topic: Topic,
  ): Promise<ReferenceWithHistory> {
    try {
      const fw = this.bee.makeFeedWriter(topic, this.signer);
      const uploadRes = await fw.upload(batchId, wrappedMantarayRef, {
        index: undefined, // todo: keep track of the latest index ??
        act: true, // TODO: shall this call to /soc post api ?
      });

      return { reference: uploadRes.reference, historyRef: new Reference(uploadRes.historyAddress) };
    } catch (error: any) {
      throw `Failed to wrapped mantaray feed: ${error}`;
    }
  }

  // Start owner mantaray feed handler methods
  private async saveMantarayFeedList(): Promise<void> {
    const ownerFeedStamp = this.getOwnerFeedStamp();
    if (!ownerFeedStamp) {
      throw 'Owner feed stamp is not found.';
    }

    try {
      const mantarayFeedListData = await this.bee.uploadData(
        ownerFeedStamp.batchID,
        JSON.stringify(this.mantarayFeedList),
        {
          act: true,
        },
      );

      const ownerFeedData: ReferenceWithHistory = {
        reference: mantarayFeedListData.reference.toString(),
        historyRef: mantarayFeedListData.historyAddress,
      };

      const ownerFeedWriter = this.bee.makeFeedWriter(this.ownerFeedTopic, this.signer);
      const ownerFeedRawData = await this.bee.uploadData(ownerFeedStamp.batchID, JSON.stringify(ownerFeedData));
      const writeResult = await ownerFeedWriter.upload(ownerFeedStamp.batchID, ownerFeedRawData.reference, {
        index: this.nextOwnerFeedIndex,
      });

      console.log('Owner feed list updated: ', writeResult.reference.toString());
      this.nextOwnerFeedIndex += 1;
    } catch (error: any) {
      throw `Failed to update owner feed list: ${error}`;
    }
  }
  // End owner mantaray feed handler methods

  // Start grantee handler methods
  // fetches the list of grantees who can access the file reference
  async getGranteesOfFile(eFileRef: Reference): Promise<GetGranteesResult> {
    const mf = this.mantarayFeedList.find((f) => f.eFileRef === eFileRef);
    if (mf?.eGranteeRef === undefined) {
      throw `Grantee list not found for file reference: ${eFileRef}`;
    }

    return this.bee.getGrantees(mf.eGranteeRef);
  }

  // TODO: only add is supported
  // updates the list of grantees who can access the file reference under the history reference
  private async handleGrantees(
    fileInfo: FileInfo,
    grantees: {
      add?: string[];
      revoke?: string[];
    },
    eGlRef?: string | Reference,
  ): Promise<GranteesResult> {
    console.log('Granting access to file: ', fileInfo.eFileRef.toString());
    const fIx = this.fileInfoList.findIndex((f) => f.eFileRef === fileInfo.eFileRef);
    if (fIx === -1) {
      throw `Provided file reference not found: ${fileInfo.eFileRef}`;
    }

    let grantResult: GranteesResult;
    if (eGlRef !== undefined) {
      // TODO: history ref should be optional in bee-js
      grantResult = await this.bee.patchGrantees(
        fileInfo.batchId,
        eGlRef,
        fileInfo.historyRef || SWARM_ZERO_ADDRESS,
        grantees,
      );
      console.log('Access patched, grantee list reference: ', grantResult.ref.toString());
    } else {
      if (grantees.add === undefined || grantees.add.length === 0) {
        throw `No grantees specified.`;
      }

      grantResult = await this.bee.createGrantees(fileInfo.batchId, grantees.add);
      console.log('Access granted, new grantee list reference: ', grantResult.ref.toString());
    }

    return grantResult;
  }

  // End grantee handler methods

  // TODO: upload /soc wiht ACT and download: do not upload mantaraymanifref with ACT as data!
  public async getFeedData(
    topic: Topic,
    index?: number,
    address?: EthAddress,
    options?: BeeRequestOptions,
  ): Promise<FetchFeedUpdateResponse> {
    try {
      const feedReader = this.bee.makeFeedReader(topic, address || this.signer.publicKey().address(), options);
      if (index !== undefined) {
        return await feedReader.download({ index: numberToFeedIndex(index) });
      }
      return await feedReader.download();
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          feedIndex: numberToFeedIndex(-1),
          feedIndexNext: numberToFeedIndex(0),
          payload: SWARM_ZERO_ADDRESS,
        };
      }
      throw error;
    }
  }

  // fileInfo might point to a folder, or a single file
  // could name downloadFiles as well, possibly
  // getDirectorStructure()
  async listFiles(fileInfo: FileInfo): Promise<Reference[]> {
    return [fileInfo.eFileRef as Reference];
  }

  // Start stamp methods
  private async getUsableStamps(): Promise<PostageBatch[]> {
    try {
      return (await this.bee.getAllPostageBatch()).filter((s) => s.usable);
    } catch (error: any) {
      console.error(`Failed to get usable stamps: ${error}`);
      return [];
    }
  }

  async filterBatches(ttl?: number, utilization?: number, capacity?: number): Promise<PostageBatch[]> {
    // TODO: clarify depth vs capacity
    return this.stampList.filter((s) => {
      if (utilization !== undefined && s.utilization <= utilization) {
        return false;
      }

      if (capacity !== undefined && s.depth <= capacity) {
        return false;
      }

      if (ttl !== undefined && s.batchTTL <= ttl) {
        return false;
      }

      return true;
    });
  }

  async getStamps(): Promise<PostageBatch[]> {
    return this.stampList;
  }

  getOwnerFeedStamp(): PostageBatch | undefined {
    return this.stampList.find((s) => s.label === OWNER_FEED_STAMP_LABEL);
  }

  async fetchStamp(batchId: string | { batchID: string }): Promise<PostageBatch | undefined> {
    try {
      const id = typeof batchId === 'string' ? batchId : batchId.batchID;
      const newStamp = await this.bee.getPostageBatch(id);
      if (newStamp?.exists && newStamp.usable) {
        this.stampList.push(newStamp);
        return newStamp;
      }
    } catch (error: any) {
      console.error(`Failed to get stamp with batchID ${batchId}: ${error.message}`);
    }
  }

  async destroyVolume(batchId: BatchId): Promise<void> {
    if (batchId === this.getOwnerFeedStamp()?.batchID) {
      throw `Cannot destroy owner stamp, batchId: ${batchId.toString()}`;
    }

    await this.bee.diluteBatch(batchId, STAMPS_DEPTH_MAX);

    for (let i = 0; i < this.stampList.length; i++) {
      if (this.stampList[i].batchID === batchId) {
        this.stampList.splice(i, 1);
        break;
      }
    }

    for (let i = 0; i < this.fileInfoList.length, ++i; ) {
      const fileInfo = this.fileInfoList[i];
      if (fileInfo.batchId === batchId) {
        this.fileInfoList.splice(i, 1);
        const mfIx = this.mantarayFeedList.findIndex((mf) => mf.eFileRef === fileInfo.eFileRef);
        if (mfIx !== -1) {
          this.mantarayFeedList.splice(mfIx, 1);
        }
      }
    }

    this.saveMantarayFeedList();

    console.log(`Volume destroyed: ${batchId.toString()}`);
  }
  // End stamp methods

  // Start share methods
  subscribeToSharedInbox(topic: string, callback?: (data: ShareItem) => void): PssSubscription {
    console.log('Subscribing to shared inbox, topic: ', topic);
    this.sharedSubscription = this.bee.pssSubscribe(new Topic(Topic.fromString(topic)), {
      onMessage: (message) => {
        console.log('Received shared inbox message: ', message);
        assertShareItem(message);
        this.sharedWithMe.push(message);
        if (callback) {
          callback(message);
        }
      },
      onError: (e) => {
        console.log('Error received in shared inbox: ', e.message);
        throw e;
      },
    });

    return this.sharedSubscription;
  }

  unsubscribeFromSharedInbox(): void {
    if (this.sharedSubscription) {
      console.log('Unsubscribed from shared inbox, topic: ', this.sharedSubscription.topic.toString());
      this.sharedSubscription.cancel();
    }
  }

  async shareItem(fileInfo: FileInfo, targetOverlays: string[], recipients: string[], message?: string): Promise<void> {
    const mfIx = this.mantarayFeedList.findIndex((mf) => mf.reference === fileInfo.eFileRef);
    if (mfIx === -1) {
      console.log('File reference not found in mantaray feed list.');
      return;
    }

    const grantResult = await this.handleGrantees(
      fileInfo,
      { add: recipients },
      this.mantarayFeedList[mfIx].eGranteeRef,
    );

    this.mantarayFeedList[mfIx] = {
      ...this.mantarayFeedList[mfIx],
      eGranteeRef: grantResult.ref,
    };

    this.saveMantarayFeedList();

    const item: ShareItem = {
      fileInfo: fileInfo,
      timestamp: Date.now(),
      message: message,
    };

    this.sendShareMessage(targetOverlays, item, recipients);
  }

  // recipient is optional, if not provided the message will be broadcasted == pss public key
  private async sendShareMessage(targetOverlays: string[], item: ShareItem, recipients: string[]): Promise<void> {
    if (recipients.length === 0 || recipients.length !== targetOverlays.length) {
      console.log('Invalid recipients or  targetoverlays specified for sharing.');
      return;
    }

    for (let i = 0; i < recipients.length; i++) {
      try {
        // TODO: mining will take too long, 2 bytes are enough
        const target = Utils.makeMaxTarget(targetOverlays[i]);
        const msgData = new Uint8Array(Buffer.from(JSON.stringify(item)));
        this.bee.pssSend(item.fileInfo.batchId, SHARED_INBOX_TOPIC, target, msgData, recipients[i]);
      } catch (error: any) {
        console.log(`Failed to share item with recipient: ${recipients[i]}\n `, error);
      }
    }
  }
  // End share methods
  // TODO: saveFileInfo only exists for testing now
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
}
