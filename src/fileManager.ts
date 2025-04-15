import {
  BatchId,
  Bee,
  BeeModes,
  Bytes,
  DownloadOptions,
  FeedIndex,
  GetGranteesResult,
  GranteesResult,
  NodeAddresses,
  NULL_TOPIC,
  PostageBatch,
  PrivateKey,
  PssSubscription,
  RedundancyLevel,
  Reference,
  STAMPS_DEPTH_MAX,
  Topic,
  UploadResult,
  Utils,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import {
  assertFileInfo,
  assertShareItem,
  assertWrappedFileInoFeed,
  generateTopic,
  getFeedData,
  getWrappedData,
  makeBeeRequestOptions,
} from './utils/common';
import { OWNER_STAMP_LABEL, REFERENCE_LIST_TOPIC, SHARED_INBOX_TOPIC, SWARM_ZERO_ADDRESS } from './utils/constants';
import {
  BeeVersionError,
  FileInfoError,
  GranteeError,
  SendShareMessageError,
  SignerError,
  StampError,
  SubscribtionError,
} from './utils/errors';
import { EventEmitter, EventEmitterBase } from './utils/eventEmitter';
import { FileManagerEvents } from './utils/events';
import {
  FileInfo,
  FileManager,
  FileManagerUploadOptions,
  ReferenceWithHistory,
  ReferenceWithPath,
  ShareItem,
  WrappedFileInfoFeed,
} from './utils/types';
import { uploadBrowser } from './upload/upload.browser';
import { uploadNode } from './upload/upload.node';
import { getForkAddresses, loadMantaray } from './utils/mantaray';
import { downloadNode } from './download/download.node';
import { downloadBrowser } from './download/download.browser';

export class FileManagerBase implements FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private nodeAddresses: NodeAddresses | undefined = undefined;
  private ownerStamp: PostageBatch | undefined = undefined;
  private ownerFeedNextIndex: bigint = 0n;
  private ownerFeedTopic: Topic = NULL_TOPIC;
  private ownerFeedList: WrappedFileInfoFeed[] = [];
  private sharedSubscription: PssSubscription | undefined = undefined;
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;

  readonly fileInfoList: FileInfo[] = [];
  readonly sharedWithMe: ShareItem[] = [];
  readonly emitter: EventEmitter;

  constructor(bee: Bee, emitter: EventEmitter = new EventEmitterBase()) {
    this.bee = bee;
    if (!this.bee.signer) {
      throw new SignerError('Signer required');
    }

    this.emitter = emitter;
    this.signer = this.bee.signer;
  }

  // TODO: import pins
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('FileManager is already initialized');
      return;
    }

    if (this.isInitializing) {
      console.log('FileManager is being initialized');
      return;
    }

    this.isInitializing = true;

    try {
      await this.verifySupportedVersions();
      await this.initNodeAddresses();
      await this.getOwnerStamp();
      await this.initOwnerFeedTopic();
      await this.initOwnerFeedList();
      await this.initFileInfoList();

      this.isInitialized = true;
      this.emitter.emit(FileManagerEvents.FILEMANAGER_INITIALIZED, true);
    } catch (error) {
      console.error(`Failed to initialize FileManager: ${error}`);
      this.isInitialized = false;
      this.emitter.emit(FileManagerEvents.FILEMANAGER_INITIALIZED, false);
    }

    this.isInitializing = false;
  }

  // verifies if the bee and bee-api versions are supported
  private async verifySupportedVersions(): Promise<void> {
    const beeVersions = await this.bee.getVersions();
    console.debug(`Bee version: ${beeVersions.beeVersion}`);
    console.debug(`Bee API version: ${beeVersions.beeApiVersion}`);
    const supportedApi = await this.bee.isSupportedApiVersion();
    if (!supportedApi) {
      console.error('Supported bee API version: ', beeVersions.supportedBeeApiVersion);
      console.error('Supported bee version: ', beeVersions.supportedBeeVersion);
      throw new BeeVersionError('Bee or Bee API version not supported');
    }
  }

  // fetches the node addresses neccessary for feed and ACT handling
  private async initNodeAddresses(): Promise<void> {
    this.nodeAddresses = await this.bee.getNodeAddresses();
  }

  // fetches the owner feed topic and creates it if it does not exist, protected by ACT
  private async initOwnerFeedTopic(): Promise<void> {
    if (!this.nodeAddresses) {
      throw new SignerError('Node addresses not found');
    }

    const ownerStamp = await this.getOwnerStamp();
    if (!ownerStamp) {
      throw new StampError('Owner stamp not found');
    }

    const feedTopicData = await getFeedData(
      this.bee,
      REFERENCE_LIST_TOPIC,
      this.signer.publicKey().address().toString(),
      0n,
    );
    const topicRef = new Reference(feedTopicData.payload.toUint8Array());

    if (topicRef.equals(SWARM_ZERO_ADDRESS)) {
      this.ownerFeedTopic = generateTopic();

      const topicDataRes = await this.bee.uploadData(ownerStamp.batchID, this.ownerFeedTopic.toUint8Array(), {
        act: true,
      });

      const fw = this.bee.makeFeedWriter(REFERENCE_LIST_TOPIC.toUint8Array(), this.signer);
      await fw.uploadReference(ownerStamp.batchID, topicDataRes.reference, { index: FeedIndex.fromBigInt(0n) });
      await fw.uploadReference(ownerStamp.batchID, topicDataRes.historyAddress.getOrThrow(), {
        index: FeedIndex.fromBigInt(1n),
      });
    } else {
      const topicHistory = await getFeedData(
        this.bee,
        REFERENCE_LIST_TOPIC,
        this.signer.publicKey().address().toString(),
        1n,
      );
      const topicHistoryRef = new Reference(topicHistory.payload.toUint8Array());
      const topicBytes = await this.bee.downloadData(topicRef.toUint8Array(), {
        actHistoryAddress: topicHistoryRef.toUint8Array(),
        actPublisher: this.nodeAddresses.publicKey,
      });

      this.ownerFeedTopic = new Topic(topicBytes.toUint8Array());
    }

    console.debug('Owner feed topic successfully initialized');
  }

  // fetches the latest list of fileinfo from the owner feed
  private async initOwnerFeedList(): Promise<void> {
    if (!this.nodeAddresses) {
      throw new SignerError('Node addresses not found');
    }

    const latestFeedData = await getFeedData(
      this.bee,
      this.ownerFeedTopic,
      this.signer.publicKey().address().toString(),
    );
    const dataArr = latestFeedData.payload.toUint8Array();

    if (SWARM_ZERO_ADDRESS.equals(dataArr)) {
      console.debug("Owner fileInfo feed list doesn't exist yet.");
      return;
    }

    this.ownerFeedNextIndex = latestFeedData.feedIndexNext?.toBigInt() || 0n;
    const refWithHistory = latestFeedData.payload.toJSON() as ReferenceWithHistory;

    const fileInfoFeedListRawData = await this.bee.downloadData(refWithHistory.reference, {
      actHistoryAddress: refWithHistory.historyRef,
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

    console.debug('FileInfo feed list fetched successfully.');
  }

  // fetches the file info list from the owner feed and unwraps the data encrypted with ACT
  private async initFileInfoList(): Promise<void> {
    if (!this.nodeAddresses) {
      throw new SignerError('Node addresses not found');
    }
    // TODO: allsettled
    for (const feedItem of this.ownerFeedList) {
      const rawFeedData = await getFeedData(
        this.bee,
        new Topic(feedItem.topic),
        this.signer.publicKey().address().toString(),
      );
      const fileInfoFeedData = rawFeedData.payload.toJSON() as ReferenceWithHistory;

      const rawData = await this.bee.downloadData(fileInfoFeedData.reference.toString(), {
        actHistoryAddress: fileInfoFeedData.historyRef,
        actPublisher: this.nodeAddresses.publicKey,
      });
      const unwrappedFileInfoData = rawData.toJSON() as ReferenceWithHistory;

      try {
        assertFileInfo(unwrappedFileInfoData);
        this.fileInfoList.push(unwrappedFileInfoData);
      } catch (error: any) {
        console.error(`Invalid FileInfo item, skipping it: ${error}`);
      }
    }

    console.debug('File info lists fetched successfully.');
  }

  // lists all the files found under the reference of the provided fileInfo
  async listFiles(fileInfo: FileInfo, options?: DownloadOptions): Promise<ReferenceWithPath[]> {
    const wrappedData = await getWrappedData(this.bee, fileInfo.file.reference.toString(), {
      ...options,
      actPublisher: fileInfo.actPublisher,
      actHistoryAddress: fileInfo.file.historyRef,
    } as DownloadOptions);

    const mantaray = await loadMantaray(this.bee, wrappedData.uploadFilesRes.toString());
    // TODO: is filter needed ?
    const fileList = mantaray
      .collect()
      .map((n) => {
        return {
          reference: new Reference(n.targetAddress),
          path: n.fullPathString,
        } as ReferenceWithPath;
      })
      .filter((item) => item.path !== '' && !item.reference.equals(SWARM_ZERO_ADDRESS));

    return fileList;
  }

  async download(
    fileInfo: FileInfo,
    paths?: string[],
    options?: DownloadOptions,
  ): Promise<ReadableStream<Uint8Array>[] | Bytes[]> {
    const wrappedData = await getWrappedData(this.bee, fileInfo.file.reference.toString(), {
      ...options,
      actPublisher: fileInfo.actPublisher,
      actHistoryAddress: fileInfo.file.historyRef,
    } as DownloadOptions);

    const unmarshalled = await loadMantaray(this.bee, wrappedData.uploadFilesRes.toString());

    const resources = getForkAddresses(unmarshalled, paths);

    if (isNode) {
      return await downloadNode(this.bee, resources);
    }

    return await downloadBrowser(resources, this.bee.url, 'bytes');
  }

  async upload(options: FileManagerUploadOptions): Promise<void> {
    if ((options.infoTopic && !options.historyRef) || (!options.infoTopic && options.historyRef)) {
      throw new FileInfoError('Options infoTopic and historyRef have to be provided at the same time.');
    }

    if (!this.nodeAddresses) {
      throw new SignerError('Node addresses not found');
    }

    const requestOptions = options.historyRef
      ? makeBeeRequestOptions({ historyRef: options.historyRef, redundancyLevel: options.redundancyLevel })
      : undefined;

    let uploadResult: UploadResult;
    if (isNode) {
      uploadResult = await uploadNode(this.bee, options, requestOptions);
    } else {
      uploadResult = await uploadBrowser(this.bee, options, requestOptions);
    }

    const topic = options.infoTopic ? Topic.fromString(options.infoTopic) : generateTopic();
    const actPublisher = this.nodeAddresses.publicKey.toCompressedHex();

    const fileInfo = await this.saveFileInfoAndFeed(
      options.batchId,
      topic,
      options.name,
      actPublisher,
      { reference: uploadResult.reference.toString(), historyRef: uploadResult.historyAddress.getOrThrow().toString() },
      undefined,
      options.index,
      options.customMetadata,
      options.redundancyLevel,
    );

    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { fileInfo });
  }

  private async saveFileInfoAndFeed(
    batchId: BatchId,
    topic: Topic,
    name: string,
    actPublisher: string,
    uploadFilesRes: ReferenceWithHistory,
    uploadPreviewRes?: ReferenceWithHistory,
    index?: string,
    customMetadata?: Record<string, string>,
    redundancyLevel?: RedundancyLevel,
  ): Promise<FileInfo> {
    if (!this.nodeAddresses) {
      throw new SignerError('Node addresses not found');
    }

    const fileInfo = {
      batchId: batchId.toString(),
      file: uploadFilesRes,
      topic: topic.toString(),
      owner: this.signer.publicKey().address().toString(),
      actPublisher,
      name,
      timestamp: new Date().getTime(),
      shared: false,
      preview: uploadPreviewRes,
      index: index,
      redundancyLevel,
      customMetadata,
    };
    const fileInfoResult = await this.uploadFileInfo(fileInfo);

    await this.saveFileInfoFeed(batchId, fileInfoResult, topic, index, redundancyLevel);

    const ix = this.ownerFeedList.findIndex((f) => f.topic.toString() === topic.toString());
    if (ix !== -1) {
      this.ownerFeedList[ix] = {
        topic: topic.toString(),
        eGranteeRef: this.ownerFeedList[ix].eGranteeRef?.toString(),
      };
    } else {
      this.ownerFeedList.push({ topic: topic.toString() });
    }

    await this.saveOwnerFeedList();

    return fileInfo;
  }

  private async uploadFileInfo(fileInfo: FileInfo): Promise<ReferenceWithHistory> {
    try {
      const uploadInfoRes = await this.bee.uploadData(fileInfo.batchId, JSON.stringify(fileInfo), {
        act: true,
        redundancyLevel: fileInfo.redundancyLevel,
      });

      this.fileInfoList.push(fileInfo);

      return {
        reference: uploadInfoRes.reference.toString(),
        historyRef: uploadInfoRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw new FileInfoError(`Failed to save fileinfo: ${error}`);
    }
  }

  private async saveFileInfoFeed(
    batchId: BatchId,
    fileInfoResult: ReferenceWithHistory,
    topic: Topic,
    index?: string,
    redundancyLevel?: RedundancyLevel,
  ): Promise<void> {
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
      const fw = this.bee.makeFeedWriter(topic.toUint8Array(), this.signer, requestOptions);
      await fw.uploadReference(batchId, uploadInfoRes.reference, {
        index: index !== undefined ? new FeedIndex(index) : undefined,
      });
    } catch (error: any) {
      throw new FileInfoError(`Failed to save wrapped fileInfo feed: ${error}`);
    }
  }

  private async saveOwnerFeedList(): Promise<void> {
    const ownerStamp = await this.getOwnerStamp();
    if (!ownerStamp) {
      throw new StampError('Owner stamp not found');
    }

    try {
      const fileInfoFeedListData = await this.bee.uploadData(ownerStamp.batchID, JSON.stringify(this.ownerFeedList), {
        act: true,
      });

      const fw = this.bee.makeFeedWriter(this.ownerFeedTopic.toUint8Array(), this.signer);
      const ownerFeedRawData = await this.bee.uploadData(
        ownerStamp.batchID,
        JSON.stringify({
          reference: fileInfoFeedListData.reference.toString(),
          historyRef: fileInfoFeedListData.historyAddress.getOrThrow().toString(),
        }),
      );

      await fw.uploadReference(ownerStamp.batchID, ownerFeedRawData.reference, {
        index: FeedIndex.fromBigInt(this.ownerFeedNextIndex),
      });

      this.ownerFeedNextIndex += 1n;
    } catch (error: any) {
      throw new FileInfoError(`Failed to save owner feed list: ${error}`);
    }
  }

  private async getOwnerStamp(): Promise<PostageBatch | undefined> {
    if (this.ownerStamp) return this.ownerStamp;

    try {
      const ownerStamp = (await this.bee.getAllPostageBatch()).find((s) => s.label === OWNER_STAMP_LABEL);
      if (ownerStamp && ownerStamp.usable) {
        this.ownerStamp = ownerStamp;
      }
      return ownerStamp;
    } catch (error: any) {
      console.error(`Failed to get owner stamp: ${error}`);
      return;
    }
  }

  async destroyVolume(batchId: BatchId): Promise<void> {
    const ownerStamp = await this.getOwnerStamp();
    if (ownerStamp && batchId.equals(ownerStamp.batchID)) {
      throw new StampError(`Cannot destroy owner stamp, batchId: ${batchId.toString()}`);
    }

    await this.bee.diluteBatch(batchId, STAMPS_DEPTH_MAX);

    for (let i = this.fileInfoList.length - 1; i >= 0; --i) {
      const fileInfo = this.fileInfoList[i];
      if (fileInfo.batchId.toString() === batchId.toString()) {
        this.fileInfoList.splice(i, 1);
        const mfIx = this.ownerFeedList.findIndex((mf) => mf.topic === fileInfo.topic);
        if (mfIx !== -1) {
          this.ownerFeedList.splice(mfIx, 1);
        }
      }
    }

    await this.saveOwnerFeedList();

    console.debug(`Volume destroyed: ${batchId.toString()}`);
  }

  // fetches the list of grantees who can access the file reference
  async getGrantees(fileInfo: FileInfo): Promise<GetGranteesResult> {
    const mfIx = this.ownerFeedList.findIndex((mf) => mf.topic === fileInfo.topic);
    if (mfIx === -1 || !this.ownerFeedList[mfIx].eGranteeRef) {
      throw new GranteeError(`Grantee list not found for file eReference: ${fileInfo.topic}`);
    }
    const eglRef = this.ownerFeedList[mfIx].eGranteeRef;

    return this.bee.getGrantees(eglRef);
  }

  // updates the list of grantees who can access the file reference under the history reference
  // only add is supported as of now
  private async handleGrantees(
    fileInfo: FileInfo,
    grantees: {
      add: string[];
      revoke?: string[];
    },
    eGranteeRef?: string | Reference,
  ): Promise<GranteesResult> {
    if (grantees.add.length === 0) {
      throw new GranteeError(`No grantees specified.`);
    }

    const fIx = this.fileInfoList.findIndex((f) => f.file === fileInfo.file);
    if (fIx === -1) {
      throw new GranteeError(`Provided fileinfo not found: ${JSON.stringify(fileInfo.file)}`);
    }

    let grantResult: GranteesResult;
    try {
      if (eGranteeRef) {
        grantResult = await this.bee.patchGrantees(
          fileInfo.batchId,
          eGranteeRef,
          fileInfo.file.historyRef || SWARM_ZERO_ADDRESS,
          grantees,
        );
        console.debug('Grantee list patched, grantee list reference: ', grantResult.ref.toString());
      } else {
        grantResult = await this.bee.createGrantees(fileInfo.batchId, grantees.add);
        console.debug('Access granted, new grantee list reference: ', grantResult.ref.toString());
      }
    } catch (error) {
      throw new GranteeError(`Failed to handle grantees: ${error}`);
    }

    return grantResult;
  }

  async subscribeToSharedInbox(topic: string, callback?: (data: ShareItem) => void): Promise<void> {
    const nodeInfo = await this.bee.getNodeInfo();
    if (nodeInfo.beeMode !== BeeModes.FULL) {
      throw new SubscribtionError(
        `Node has to be in ${BeeModes.FULL} mode but it is running in ${nodeInfo.beeMode} mode.`,
      );
    }

    console.debug('Subscribing to shared inbox, topic: ', topic);
    this.sharedSubscription = this.bee.pssSubscribe(Topic.fromString(topic), {
      onMessage: (message) => {
        console.debug('Received shared inbox message: ', message);
        assertShareItem(message);
        this.sharedWithMe.push(message);
        if (callback) {
          callback(message);
        }
      },
      onError: (e) => {
        console.debug('Error received in shared inbox: ', e.message);
        throw new SubscribtionError(e.message);
      },
    });
  }

  unsubscribeFromSharedInbox(): void {
    if (this.sharedSubscription) {
      console.debug('Unsubscribed from shared inbox, topic: ', this.sharedSubscription.topic.toString());
      this.sharedSubscription.cancel();
    }
  }

  async share(fileInfo: FileInfo, targetOverlays: string[], recipients: string[], message?: string): Promise<void> {
    const ix = this.ownerFeedList.findIndex((mf) => mf.topic.toString() === fileInfo.file.reference.toString());
    if (ix === -1) {
      throw new SendShareMessageError('File reference not found in fileInfo feed list.');
    }

    const grantResult = await this.handleGrantees(fileInfo, { add: recipients }, this.ownerFeedList[ix].eGranteeRef);

    this.ownerFeedList[ix] = {
      ...this.ownerFeedList[ix],
      eGranteeRef: grantResult.ref.toString(),
    };

    await this.saveOwnerFeedList();

    const item: ShareItem = {
      fileInfo: fileInfo,
      timestamp: Date.now(),
      message: message,
    };

    await this.sendShareMessage(targetOverlays, item, recipients);
    this.emitter.emit(FileManagerEvents.SHARE_MESSAGE_SENT, { recipients: recipients, shareItem: item });
  }

  // recipient is optional, if not provided the message will be broadcasted == pss public key
  private async sendShareMessage(targetOverlays: string[], item: ShareItem, recipients: string[]): Promise<void> {
    if (recipients.length === 0 || recipients.length !== targetOverlays.length) {
      throw new SubscribtionError('Invalid recipients or  targetoverlays specified for sharing.');
    }

    // TODO: in case of error, for loop will continue, should it throw ?
    for (let i = 0; i < recipients.length; i++) {
      try {
        // TODO: mining will take too long, 2 bytes are enough
        const target = Utils.makeMaxTarget(targetOverlays[i]);
        const msgData = Bytes.fromUtf8(JSON.stringify(item)).toUint8Array();
        this.bee.pssSend(item.fileInfo.batchId, SHARED_INBOX_TOPIC, target, msgData, recipients[i]);
      } catch (error: any) {
        console.error(`Failed to share item with recipient: ${recipients[i]}\n `, error);
        throw new SendShareMessageError(`Failed to share item with recipient: ${recipients[i]}\n ${error}`);
      }
    }
  }
}
