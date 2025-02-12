import {
  BatchId,
  Bee,
  BeeModes,
  BeeRequestOptions,
  Bytes,
  CollectionUploadOptions,
  DownloadOptions,
  EthAddress,
  FileUploadOptions,
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
import { BeeVersionError, FileInfoError, SignerError, StampError, SubscribtionError } from './utils/errors';
import {
  FetchFeedUpdateResponse,
  FileInfo,
  ReferenceWithHistory,
  ReferenceWithPath,
  ShareItem,
  WrappedFileInfoFeed,
} from './utils/types';
import {
  assertFileInfo,
  assertShareItem,
  assertWrappedFileInoFeed,
  getRandomBytes,
  isDir,
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

  // verifies if the bee and bee-api versions are supported
  private async verifySupportedVersions(): Promise<void> {
    const beeVersions = await this.bee.getVersions();
    console.log(`Bee version: ${beeVersions.beeVersion}`);
    console.log(`Bee API version: ${beeVersions.beeApiVersion}`);
    const supportedApi = await this.bee.isSupportedApiVersion();
    if (!supportedApi) {
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

      this.ownerFeedTopic = new Topic(getRandomBytes(Topic.LENGTH));
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
  async saveMantaray(batchId: BatchId, mantaray: MantarayNode, options?: UploadOptions): Promise<Reference> {
    return mantaray.saveRecursively(this.bee, batchId, options);
  }

  private async loadMantaray(mantarayRef: Reference, options?: DownloadOptions): Promise<MantarayNode> {
    const mantaray = await MantarayNode.unmarshal(this.bee, mantarayRef, options);
    await mantaray.loadRecursively(this.bee);
    return mantaray;
  }
  // TODO: use node.find() - it does not seem to work - test it
  async downloadFork(mantaray: MantarayNode, path: string, options?: DownloadOptions): Promise<Bytes> {
    const node = mantaray.collect().find((n) => n.fullPathString === path);
    if (!node) return SWARM_ZERO_ADDRESS;

    return await this.bee.downloadData(node.targetAddress, options);
  }

  // lists all the files found under the reference of the provided fileInfo
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

  async downloadFiles(eRef: Reference, options?: DownloadOptions): Promise<string[]> {
    const unmarshalled = await this.loadMantaray(eRef, options);
    const files: string[] = [];

    for (const node of unmarshalled.collect()) {
      const file = (await this.bee.downloadData(node.targetAddress)).toUtf8();
      files.push(file);
    }
    return files;
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
  async upload(
    batchId: BatchId,
    resolvedPath: string,
    previewPath?: string,
    historyRef?: Reference,
    infoTopic?: string,
    index?: number | undefined,
    redundancyLevel?: RedundancyLevel,
    customMetadata?: Record<string, string>,
  ): Promise<void> {
    if ((infoTopic && !historyRef) || (!infoTopic && historyRef)) {
      throw new FileInfoError('infoTopic and historyRef have to be provided at the same time.');
    }

    const requestOptions = historyRef ? makeBeeRequestOptions({ historyRef }) : undefined;
    const uploadFilesRes = await this.uploadFileOrDirectory(
      batchId,
      resolvedPath,
      { act: true, redundancyLevel },
      requestOptions,
    );
    let uploadPreviewRes: ReferenceWithHistory | undefined;
    if (previewPath) {
      uploadPreviewRes = await this.uploadFileOrDirectory(
        batchId,
        previewPath,
        { act: true, redundancyLevel },
        requestOptions,
      );
    }

    const topic = infoTopic ? Topic.fromString(infoTopic) : new Topic(getRandomBytes(Topic.LENGTH));
    const feedIndex = index !== undefined ? index : 0;
    const fileInfoResult = await this.uploadFileInfo({
      batchId: batchId.toString(),
      file: uploadFilesRes,
      topic: topic.toString(),
      owner: this.signer.publicKey().address().toString(),
      name: path.basename(resolvedPath),
      timestamp: new Date().getTime(),
      shared: false,
      preview: uploadPreviewRes,
      index: feedIndex,
      redundancyLevel,
      customMetadata,
    });

    const newFeedItem = await this.saveWrappedFileInfoFeed(batchId, fileInfoResult, topic, feedIndex, redundancyLevel);

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
  // TODO: streamFiles & uploadFiles  - streamDirectory & uploadFilesFromDirectory -> browser vs nodejs
  private async uploadFileOrDirectory(
    batchId: BatchId,
    resolvedPath: string,
    uploadOptions?: CollectionUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    if (isDir(resolvedPath)) {
      return this.uploadDirectory(batchId, resolvedPath, uploadOptions, requestOptions);
    } else {
      return this.uploadFile(batchId, resolvedPath, uploadOptions, requestOptions);
    }
  }

  private async uploadFile(
    batchId: BatchId,
    resolvedPath: string,
    uploadOptions?: FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    try {
      const { data, name, contentType } = readFile(resolvedPath);
      console.log(`Uploading file: ${name}`);

      const uploadFileRes = await this.bee.uploadFile(
        batchId,
        data,
        name,
        {
          ...uploadOptions,
          contentType: contentType,
        },
        requestOptions,
      );

      console.log(`File uploaded successfully: ${name}, reference: ${uploadFileRes.reference.toString()}`);
      return {
        reference: uploadFileRes.reference.toString(),
        historyRef: uploadFileRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw `Failed to upload file ${resolvedPath}: ${error}`;
    }
  }

  private async uploadDirectory(
    batchId: BatchId,
    resolvedPath: string,
    uploadOptions?: CollectionUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    console.log(`Uploading directory: ${path.basename(resolvedPath)}`);
    try {
      const uploadFilesRes = await this.bee.uploadFilesFromDirectory(
        batchId,
        resolvedPath,
        uploadOptions,
        requestOptions,
      );

      console.log(
        `Directory uploaded successfully: ${path.basename(
          resolvedPath,
        )}, reference: ${uploadFilesRes.reference.toString()}`,
      );
      return {
        reference: uploadFilesRes.reference.toString(),
        historyRef: uploadFilesRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw `Failed to upload directory ${resolvedPath}: ${error}`;
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
    index?: number,
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
          redundancyLevel,
        },
      );

      const requestOptions = redundancyLevel ? makeBeeRequestOptions({ redundancyLevel }) : undefined;
      const fw = this.bee.makeFeedWriter(topic, this.signer, requestOptions);
      const wrappedFeedUpdateRes = await fw.upload(batchId, uploadInfoRes.reference, {
        index: index,
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

  private getOwnerFeedStamp(): PostageBatch | undefined {
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
    const fIx = this.fileInfoList.findIndex((f) => f.file === fileInfo.file);
    if (fIx === -1) {
      throw `Provided fileinfo not found: ${fileInfo.file.reference}`;
    }

    let grantResult: GranteesResult;
    if (eGranteeRef !== undefined) {
      grantResult = await this.bee.patchGrantees(
        fileInfo.batchId,
        eGranteeRef,
        fileInfo.file.historyRef || SWARM_ZERO_ADDRESS,
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
  async subscribeToSharedInbox(topic: string, callback?: (data: ShareItem) => void): Promise<void> {
    const nodeInfo = await this.bee.getNodeInfo();
    if (nodeInfo.beeMode !== BeeModes.FULL) {
      throw new SubscribtionError(
        `Node has to be in ${BeeModes.FULL} mode but it is running in ${nodeInfo.beeMode} mode.`,
      );
    }

    console.log('Subscribing to shared inbox, topic: ', topic);
    this.sharedSubscription = this.bee.pssSubscribe(Topic.fromString(topic), {
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
  }

  unsubscribeFromSharedInbox(): void {
    if (this.sharedSubscription) {
      console.log('Unsubscribed from shared inbox, topic: ', this.sharedSubscription.topic.toString());
      this.sharedSubscription.cancel();
    }
  }

  async shareItem(fileInfo: FileInfo, targetOverlays: string[], recipients: string[], message?: string): Promise<void> {
    const mfIx = this.ownerFeedList.findIndex((mf) => mf.reference === fileInfo.file.reference);
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
      throw 'Invalid recipients or  targetoverlays specified for sharing.';
    }

    for (let i = 0; i < recipients.length; i++) {
      try {
        // TODO: mining will take too long, 2 bytes are enough
        const target = Utils.makeMaxTarget(targetOverlays[i]);
        const msgData = Bytes.fromUtf8(JSON.stringify(item)).toUint8Array();
        this.bee.pssSend(item.fileInfo.batchId, SHARED_INBOX_TOPIC, target, msgData, recipients[i]);
      } catch (error: any) {
        console.log(`Failed to share item with recipient: ${recipients[i]}\n `, error);
      }
    }
  }
  // End share methods

  // Start helper methods
  // Fetches the feed data for the given topic, index and address
  async getFeedData(
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
