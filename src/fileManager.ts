import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  DownloadOptions,
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
  UploadOptions,
  Utils,
} from '@upcoming/bee-js';
import path from 'path';

import {
  FILE_INFO_LOCAL_STORAGE,
  OWNER_FEED_STAMP_LABEL,
  REFERENCE_LIST_TOPIC,
  SHARED_INBOX_TOPIC,
  SWARM_ZERO_ADDRESS,
} from './utils/constants';
import { BeeVersionError, FileInfoError, SignerError, StampError } from './utils/errors';
import { FetchFeedUpdateResponse, FileInfo, ReferenceWithHistory, ShareItem, WrappedFileInfoFeed } from './utils/types';
import {
  assertFileInfo,
  assertShareItem,
  assertWrappedFileInoFeed,
  getRandomTopic,
  isNotFoundError,
  makeBeeRequestOptions,
  makeNumericIndex,
  numberToFeedIndex,
  readFile,
} from './utils/utils';

export class FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private nodeAddresses: NodeAddresses;
  private stampList: PostageBatch[];
  private ownerFeedList: WrappedFileInfoFeed[];
  private fileInfoList: FileInfo[];
  private ownerFeedNextIndex: number;
  private sharedWithMe: ShareItem[];
  private sharedSubscription: PssSubscription | undefined;
  private ownerFeedTopic: Topic;

  constructor(bee: Bee) {
    this.bee = bee;
    if (!this.bee.signer) {
      throw new SignerError('Signer required');
    }
    this.signer = this.bee.signer;
    this.stampList = [];
    this.fileInfoList = [];
    this.ownerFeedList = [];
    this.ownerFeedNextIndex = 0;
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
    await this.initOwnerFeedList();
    await this.initFileInfoList();
  }

  // TODO: is exact version check necessary?
  // verifies if the bee and bee-api versions are supported
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

  // fetches the node addresses neccessary for feed and ACT handling
  private async initNodeAddresses(): Promise<void> {
    this.nodeAddresses = await this.bee.getNodeAddresses();
  }

  // fetches the owner feed topic and creates it if it does not exist, protected by ACT
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
      await fw.upload(ownerFeedStamp.batchID, topicDataRes.historyAddress.getOrThrow(), {
        index: numberToFeedIndex(1),
      });
    } else {
      const topicHistory = await this.getFeedData(REFERENCE_LIST_TOPIC, 1);
      const topicBytes = await this.bee.downloadData(new Reference(feedTopicData.payload), {
        actHistoryAddress: new Reference(topicHistory.payload),
        actPublisher: this.nodeAddresses.publicKey,
      });

      this.ownerFeedTopic = new Topic(topicBytes);
    }

    console.log('Owner feed topic successfully initialized: ', this.ownerFeedTopic.toString());
  }

  // fetches the usable stamps from the node
  private async initStamps(): Promise<void> {
    try {
      this.stampList = await this.getUsableStamps();
      console.log('Usable stamps fetched successfully.');
    } catch (error: any) {
      console.error(`Failed to fetch stamps: ${error}`);
    }
  }

  // fetches the latest list of fileinfo from the owner feed
  private async initOwnerFeedList(): Promise<void> {
    const latestFeedData = await this.getFeedData(this.ownerFeedTopic);
    if (latestFeedData.payload === SWARM_ZERO_ADDRESS) {
      console.log("Owner fileInfo feed list doesn't exist yet.");
      return;
    }

    this.ownerFeedNextIndex = makeNumericIndex(latestFeedData.feedIndexNext);
    const refWithHistory = latestFeedData.payload.toJSON() as ReferenceWithHistory;

    const fileInfoFeedListRawData = await this.bee.downloadData(new Reference(refWithHistory.reference), {
      actHistoryAddress: new Reference(refWithHistory.historyRef),
      actPublisher: this.nodeAddresses.publicKey,
    });
    const fileInfoFeedListData = fileInfoFeedListRawData.toJSON() as WrappedFileInfoFeed[];

    for (const feedItem of fileInfoFeedListData) {
      try {
        assertWrappedFileInoFeed(feedItem);
        this.ownerFeedList.push(feedItem);
      } catch (error: any) {
        console.error(`Invalid WrappedFileInoFeed item, skipping it: ${error}`);
      }
    }

    console.log('FileInfo feed list fetched successfully.');
  }

  // fetches the file info list from the owner feed and unwraps the data encrypted with ACT
  private async initFileInfoList(): Promise<void> {
    for (const feedItem of this.ownerFeedList) {
      const rawFeedData = await this.getFeedData(new Topic(feedItem.reference));
      const fileInfoFeedData = rawFeedData.payload.toJSON() as ReferenceWithHistory;

      const unwrappedFileInfoData = (
        await this.bee.downloadData(fileInfoFeedData.reference, {
          actHistoryAddress: new Reference(fileInfoFeedData.historyRef),
          actPublisher: this.nodeAddresses.publicKey,
        })
      ).toJSON() as ReferenceWithHistory;

      try {
        assertFileInfo(unwrappedFileInfoData);
        this.fileInfoList.push(unwrappedFileInfoData);
      } catch (error: any) {
        console.error(`Invalid FileInfo item, skipping it: ${error}`);
      }
    }

    console.log('File info lists fetched successfully.');
  }
  // End init methods

  // Start mantaray methods
  private async saveMantaray(batchId: BatchId, mantaray: MantarayNode, options?: UploadOptions): Promise<Reference> {
    return mantaray.saveRecursively(this.bee, batchId, options);
  }

  private async loadMantaray(mantarayRef: Reference): Promise<MantarayNode> {
    const mantaray = await MantarayNode.unmarshal(this.bee, mantarayRef);
    await mantaray.loadRecursively(this.bee);
    return mantaray;
  }
  // TODO: use node.find() - it does not seem to work - test it
  private async getForkData(mantaray: MantarayNode, forkPath: string, options?: DownloadOptions): Promise<Bytes> {
    const node = mantaray.collect().find((n) => n.fullPathString === forkPath);
    if (!node) return SWARM_ZERO_ADDRESS;
    const targetRef = new Reference(node.targetAddress);

    return await this.bee.downloadData(targetRef, options);
  }
  // End mantaray methods

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

  // Start Swarm data saving methods
  // TODO: upload preview just like a file and assign it ot fileinfo -> is ACT necessary for preview?
  // TODO: assemble a mantaray structure from the filepath/folderpath
  async upload(
    batchId: BatchId,
    filePath: string,
    preview?: string,
    historyRef?: Reference,
    infoTopic?: string,
    redundancyLevel?: RedundancyLevel,
    customMetadata?: Record<string, string>,
  ): Promise<void> {
    if ((infoTopic && !historyRef) || (!infoTopic && historyRef)) {
      throw new FileInfoError('infoTopic and historyRef have to be provided at the same time.');
    }

    const uploadFileRes = await this.uploadFile(batchId, filePath, true, historyRef, redundancyLevel);
    let previewRef: Reference | undefined;
    if (preview) {
      const uploadPreviewRes = await this.uploadFile(batchId, preview, false, undefined, redundancyLevel);
      previewRef = new Reference(uploadPreviewRes.reference);
    }
    // TODO: store feed index in fileinfo to speed up upload? -> undifined == 0, index otherwise
    const topic = infoTopic ? new Topic(Topic.fromString(infoTopic)) : getRandomTopic();
    const fileInfoResult = await this.uploadFileInfo({
      batchId: batchId.toString(),
      eFileRef: uploadFileRes.reference.toString(),
      topic: topic.toString(),
      historyRef: uploadFileRes.historyRef.toString(),
      owner: this.signer.publicKey().address().toString(),
      fileName: path.basename(filePath), // TODO: redundant read
      timestamp: new Date().getTime(),
      shared: false,
      preview: previewRef,
      redundancyLevel: redundancyLevel,
      customMetadata: customMetadata,
    });

    const newFeedItem = await this.saveWrappedFileInfoFeed(batchId, fileInfoResult, topic, redundancyLevel);

    const ix = this.ownerFeedList.findIndex((f) => f.reference === newFeedItem.reference);
    if (ix !== -1) {
      this.ownerFeedList[ix] = {
        ...newFeedItem,
        eGranteeRef: this.ownerFeedList[ix].eGranteeRef?.toString(),
      };
    } else {
      this.ownerFeedList.push(newFeedItem);
    }

    await this.saveFileInfoFeedList();
  }

  private async uploadFile(
    batchId: BatchId,
    file: string,
    act: boolean,
    historyRef?: string | Reference,
    redundancyLevel?: RedundancyLevel,
  ): Promise<ReferenceWithHistory> {
    const { data, name, contentType } = readFile(file);
    console.log(`Uploading file: ${name}`);

    try {
      const options = historyRef ? makeBeeRequestOptions(new Reference(historyRef)) : undefined;
      const uploadFileRes = await this.bee.uploadFile(
        batchId,
        data,
        name,
        {
          act: act,
          redundancyLevel: redundancyLevel,
          contentType: contentType,
        },
        options,
      );

      console.log(`File uploaded successfully: ${name}, Reference: ${uploadFileRes.reference.toString()}`);
      return {
        reference: uploadFileRes.reference.toString(),
        historyRef: uploadFileRes.historyAddress.getOrThrow().toString(),
      };
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

      return {
        reference: uploadInfoRes.reference.toString(),
        historyRef: uploadInfoRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw `Failed to save fileinfo: ${error}`;
    }
  }

  private async saveWrappedFileInfoFeed(
    batchId: BatchId,
    fileInfoResult: ReferenceWithHistory,
    topic: Topic,
    redundancyLevel?: RedundancyLevel,
  ): Promise<WrappedFileInfoFeed> {
    try {
      const uploadInfoRes = await this.bee.uploadData(
        batchId,
        JSON.stringify({
          reference: fileInfoResult.reference.toString(),
          historyRef: fileInfoResult.historyRef.toString(),
        } as ReferenceWithHistory),
        {
          redundancyLevel: redundancyLevel,
        },
      );

      const fw = this.bee.makeFeedWriter(topic, this.signer);
      // TODO: bee-js feedWriter should redundancylevel ?
      const wrappedFeedUpdateRes = await fw.upload(batchId, uploadInfoRes.reference, {
        index: undefined, // todo: keep track of the latest index ??
        act: true,
      });

      return {
        reference: new Reference(topic).toString(),
        historyRef: wrappedFeedUpdateRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw `Failed to save wrapped fileInfo feed: ${error}`;
    }
  }

  private async saveFileInfoFeedList(): Promise<void> {
    const ownerFeedStamp = this.getOwnerFeedStamp();
    if (!ownerFeedStamp) {
      throw 'Owner feed stamp is not found.';
    }
    try {
      const fileInfoFeedListData = await this.bee.uploadData(
        ownerFeedStamp.batchID,
        JSON.stringify(this.ownerFeedList),
        {
          act: true,
        },
      );

      const fw = this.bee.makeFeedWriter(this.ownerFeedTopic, this.signer);
      const ownerFeedRawData = await this.bee.uploadData(
        ownerFeedStamp.batchID,
        JSON.stringify({
          reference: fileInfoFeedListData.reference.toString(),
          historyRef: fileInfoFeedListData.historyAddress.getOrThrow().toString(),
        }),
      );

      const writeResult = await fw.upload(ownerFeedStamp.batchID, ownerFeedRawData.reference, {
        index: this.ownerFeedNextIndex,
      });

      console.log('Owner feed list updated: ', writeResult.reference.toString());
      this.ownerFeedNextIndex += 1;
    } catch (error: any) {
      throw `Failed to save owner feed list: ${error}`;
    }
  }
  // End Swarm data saving methods

  // fileInfo might point to a folder, or a single file
  // could name downloadFiles as well, possibly
  // getDirectorStructure()
  async listFiles(fileInfo: FileInfo): Promise<Reference[]> {
    return [new Reference(fileInfo.eFileRef)];
  }

  // Start stamp handler methods
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
        const mfIx = this.ownerFeedList.findIndex((mf) => mf.reference === fileInfo.topic);
        if (mfIx !== -1) {
          this.ownerFeedList.splice(mfIx, 1);
        }
      }
    }

    this.saveFileInfoFeedList();

    console.log(`Volume destroyed: ${batchId.toString()}`);
  }
  // End stamp handler methods

  // Start grantee handler methods
  // fetches the list of grantees who can access the file reference
  async getGranteesOfFile(fileInfo: FileInfo): Promise<GetGranteesResult> {
    const mfIx = this.ownerFeedList.findIndex((mf) => mf.reference === fileInfo.topic);
    const eglRef = this.ownerFeedList[mfIx].eGranteeRef;
    if (mfIx === -1 || !eglRef) {
      throw `Grantee list not found for file eReference: ${fileInfo.topic}`;
    }

    return this.bee.getGrantees(new Reference(eglRef));
  }

  // updates the list of grantees who can access the file reference under the history reference
  // only add is supported
  private async handleGrantees(
    fileInfo: FileInfo,
    grantees: {
      add?: string[];
      revoke?: string[];
    },
    eGranteeRef?: string | Reference,
  ): Promise<GranteesResult> {
    console.log('Granting access to file: ', fileInfo.eFileRef.toString());
    const fIx = this.fileInfoList.findIndex((f) => f.eFileRef === fileInfo.eFileRef);
    if (fIx === -1) {
      throw `Provided fileinfo not found: ${fileInfo.eFileRef}`;
    }

    let grantResult: GranteesResult;
    if (eGranteeRef !== undefined) {
      // TODO: history ref should be optional in bee-js
      grantResult = await this.bee.patchGrantees(
        fileInfo.batchId,
        eGranteeRef,
        fileInfo.historyRef || SWARM_ZERO_ADDRESS,
        grantees,
      );
      console.log('Grantee list patched, grantee list reference: ', grantResult.ref.toString());
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
    const mfIx = this.ownerFeedList.findIndex((mf) => mf.reference === fileInfo.eFileRef);
    if (mfIx === -1) {
      console.log('File reference not found in fileInfo feed list.');
      return;
    }

    const grantResult = await this.handleGrantees(fileInfo, { add: recipients }, this.ownerFeedList[mfIx].eGranteeRef);

    this.ownerFeedList[mfIx] = {
      ...this.ownerFeedList[mfIx],
      eGranteeRef: grantResult.ref.toString(),
    };

    this.saveFileInfoFeedList();

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

  // Start helper methods
  // Fetches the feed data for the given topic, index and address
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
