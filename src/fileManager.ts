import {
  BatchId,
  Bee,
  BeeModes,
  BeeRequestOptions,
  Bytes,
  CollectionUploadOptions,
  DownloadOptions,
  FeedIndex,
  FileUploadOptions,
  GetGranteesResult,
  GranteesResult,
  NodeAddresses,
  NULL_TOPIC,
  PostageBatch,
  PrivateKey,
  PssSubscription,
  RedundantUploadOptions,
  Reference,
  STAMPS_DEPTH_MAX,
  Topic,
  Utils,
  UploadResult,
  RedundancyLevel,
  Identifier,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import { assertDriveInfo, assertFileInfo, assertShareItem } from './utils/asserts';
import { generateRandomBytes, getFeedData, getWrappedData, settlePromises } from './utils/common';
import { OWNER_STAMP_LABEL, REFERENCE_LIST_TOPIC, SHARED_INBOX_TOPIC, SWARM_ZERO_ADDRESS } from './utils/constants';
import {
  BeeVersionError,
  DriveError,
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
  FeedPayloadResult,
  FileInfo,
  FileManager,
  FileInfoOptions,
  ReferenceWithHistory,
  ShareItem,
  DriveInfo,
} from './utils/types';
import { uploadBrowser } from './upload/upload.browser';
import { uploadNode } from './upload/upload.node';
import { getForksMap, loadMantaray } from './utils/mantaray';
import { downloadBrowser } from './download/download.browser';
import { downloadNode } from './download/download.node';

export class FileManagerBase implements FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private nodeAddresses: NodeAddresses | undefined = undefined;
  private ownerStamp: PostageBatch | undefined = undefined;
  private driveListNextIndex: bigint = 0n;
  private driveListTopic: Topic = NULL_TOPIC;
  private driveList: DriveInfo[] = [];
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
      await this.initDriveListTopic();
      await this.initDriveList();
      await this.initFileInfoList();

      this.isInitialized = true;
      this.emitter.emit(FileManagerEvents.FILEMANAGER_INITIALIZED, true);
    } catch (error: any) {
      console.error(`Failed to initialize FileManager: ${error.message || error}`);
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

  // fetches the drive list topic and creates it if it does not exist, protected by ACT
  private async initDriveListTopic(): Promise<void> {
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
      this.driveListTopic = new Topic(generateRandomBytes(Topic.LENGTH));

      const topicDataRes = await this.bee.uploadData(ownerStamp.batchID, this.driveListTopic.toUint8Array(), {
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

      this.driveListTopic = new Topic(topicBytes.toUint8Array());
    }

    console.debug('Owner feed topic successfully initialized');
  }

  // fetches the latest list of fileinfo from the drive list topic
  private async initDriveList(): Promise<void> {
    if (!this.nodeAddresses) {
      throw new SignerError('Node addresses not found');
    }

    const { payload, feedIndexNext } = await getFeedData(
      this.bee,
      this.driveListTopic,
      this.signer.publicKey().address().toString(),
    );

    if (SWARM_ZERO_ADDRESS.equals(payload.toUint8Array())) {
      console.debug("Drive list doesn't exist yet.");
      return;
    }

    this.driveListNextIndex = feedIndexNext?.toBigInt() || 0n;
    const refWithHistory = payload.toJSON() as ReferenceWithHistory;

    const driveListRawData = await this.bee.downloadData(refWithHistory.reference, {
      actHistoryAddress: refWithHistory.historyRef,
      actPublisher: this.nodeAddresses.publicKey,
    });
    const driveListData = driveListRawData.toJSON() as DriveInfo[];

    for (const feedItem of driveListData) {
      try {
        assertDriveInfo(feedItem);
        this.driveList.push(feedItem);
      } catch (error: any) {
        console.error(`Invalid DriveInfo item: ${JSON.stringify(feedItem)}, skipping it\n${error.message || error}`);
      }
    }

    console.debug('DriveInfo list fetched successfully.');
  }

  // fetches the file info list from the owner feed and unwraps the data encrypted with ACT
  private async initFileInfoList(): Promise<void> {
    // need a temporary variable to avoid async issues
    const tmpAddresses = this.nodeAddresses;
    if (!tmpAddresses) {
      throw new SignerError('Node addresses not found');
    }

    let topics: string[] = [];
    for (const drive of this.driveList.filter((d) => d.infoFeedList && d.infoFeedList.length > 0)) {
      // TODO: already checked the condition
      if (drive.infoFeedList) {
        for (const feed of drive.infoFeedList) {
          topics.push(feed.topic.toString());
        }
      }
    }

    const feedDataPromises: Promise<FeedPayloadResult>[] = [];
    for (const topic of topics) {
      feedDataPromises.push(getFeedData(this.bee, new Topic(topic), this.signer.publicKey().address().toString()));
    }

    const rawDataPromises: Promise<Bytes>[] = [];
    await settlePromises<FeedPayloadResult>(feedDataPromises, (value) => {
      const fileInfoFeedData = value.payload.toJSON() as ReferenceWithHistory;

      rawDataPromises.push(
        this.bee.downloadData(fileInfoFeedData.reference.toString(), {
          actHistoryAddress: fileInfoFeedData.historyRef,
          actPublisher: tmpAddresses.publicKey,
        }),
      );
    });

    await settlePromises<Bytes>(rawDataPromises, (value) => {
      const unwrappedFileInfoData = value.toJSON() as FileInfo;

      try {
        assertFileInfo(unwrappedFileInfoData);
        this.fileInfoList.push(unwrappedFileInfoData);
      } catch (error: any) {
        console.error(`Invalid FileInfo item, skipping it: ${error}`);
      }
    });

    console.debug('File info lists fetched successfully.');
  }

  public getDrives(): DriveInfo[] {
    return this.driveList.map((d) => ({
      name: d.name,
      id: d.id.toString(),
      batchId: d.batchId.toString(),
      owner: d.owner.toString(),
      redundancyLevel: d.redundancyLevel,
    }));
  }

  // TODO: one batchId for more drives vs only one for one drive?
  async createDrive(
    batchId: string | BatchId,
    name: string,
    uploadOptions?: RedundantUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    const existingDrive = this.driveList.find((d) => d.name === name);
    if (existingDrive) {
      throw new DriveError(`Drive with name "${name}" already exists`);
    }

    const driveInfo: DriveInfo = {
      id: new Identifier(generateRandomBytes(Identifier.LENGTH)).toString(),
      name,
      batchId: batchId.toString(),
      owner: this.signer.publicKey().address().toString(),
      redundancyLevel: uploadOptions?.redundancyLevel ?? RedundancyLevel.OFF,
      infoFeedList: [],
    };
    this.driveList.push(driveInfo);

    await this.saveDriveList(requestOptions);

    this.emitter.emit(FileManagerEvents.DRIVE_CREATED, { driveInfo });
  }

  // lists all the files found under the reference of the provided fileInfo
  async listFiles(fileInfo: FileInfo, options?: DownloadOptions): Promise<Record<string, string>> {
    const wrappedData = await getWrappedData(this.bee, fileInfo.file.reference.toString(), {
      ...options,
      actPublisher: fileInfo.actPublisher,
      actHistoryAddress: fileInfo.file.historyRef,
    } as DownloadOptions);

    const mantaray = await loadMantaray(this.bee, wrappedData.uploadFilesRes.toString());

    return getForksMap(mantaray);
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

    const resources = getForksMap(unmarshalled, paths);

    if (isNode) {
      return await downloadNode(this.bee, Object.values(resources));
    }

    return await downloadBrowser(Object.values(resources), this.bee.url, 'bytes');
  }

  // TODO: new version needs to call handleGrantees?
  async upload(
    driveInfo: DriveInfo,
    fileOptions: FileInfoOptions,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    if (
      (fileOptions.infoTopic && !uploadOptions?.actHistoryAddress) ||
      (!fileOptions.infoTopic && uploadOptions?.actHistoryAddress)
    ) {
      throw new FileInfoError('Options infoTopic and historyRef have to be provided at the same time.');
    }

    if (!this.nodeAddresses) {
      throw new SignerError('Node addresses not found');
    }

    const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
    if (driveIndex === -1) {
      throw new FileInfoError(`Drive ${driveInfo.name} with id ${driveInfo.id.toString()} not found`);
    }

    uploadOptions = { ...uploadOptions, redundancyLevel: driveInfo.redundancyLevel };

    let uploadResult: UploadResult;
    if (isNode) {
      uploadResult = await uploadNode(this.bee, driveInfo.batchId, fileOptions, uploadOptions, requestOptions);
    } else {
      uploadResult = await uploadBrowser(
        this.bee,
        driveInfo.batchId,
        fileOptions,
        uploadOptions as RedundantUploadOptions,
        requestOptions,
      );
    }

    const topicStr = fileOptions.infoTopic ?? new Topic(generateRandomBytes(Topic.LENGTH)).toString();
    const owner = this.signer.publicKey().address().toString();
    const fileInfo: FileInfo = {
      batchId: driveInfo.batchId.toString(),
      owner: owner,
      topic: topicStr,
      name: fileOptions.name,
      actPublisher: this.nodeAddresses.publicKey.toCompressedHex(),
      file: {
        reference: uploadResult.reference.toString(),
        historyRef: uploadResult.historyAddress.getOrThrow().toString(),
      },
      drive: driveInfo.id.toString(),
      timestamp: new Date().getTime(),
      shared: false,
      preview: undefined,
      index: fileOptions.index,
      customMetadata: fileOptions.customMetadata,
      redundancyLevel: driveInfo.redundancyLevel,
    };

    if (!fileOptions.index) {
      const latest = await getFeedData(this.bee, new Topic(topicStr), owner);
      const feedIndexNext = latest.feedIndexNext;

      if (feedIndexNext === undefined) {
        throw new FileInfoError(`FileInfo feed not found for ${topicStr}`);
      }

      fileInfo.index = feedIndexNext.toString();
    }

    const fileInfoResult = await this.uploadFileInfo(fileInfo);

    await this.saveFileInfoFeed(fileInfo.batchId.toString(), fileInfoResult, topicStr, fileInfo.index, requestOptions);

    if (!this.driveList[driveIndex].infoFeedList) {
      this.driveList[driveIndex].infoFeedList = [];
    }

    const infoIx = this.driveList[driveIndex].infoFeedList.findIndex((wf) => wf.topic === topicStr);
    if (infoIx === -1) {
      this.driveList[driveIndex].infoFeedList.push({
        topic: topicStr,
      });
    } else {
      // overwrite the existing grantee reference if it exists, as they do not have access to the new version
      this.driveList[driveIndex].infoFeedList[infoIx] = {
        topic: topicStr,
        eGranteeRef: undefined,
      };
    }

    await this.saveDriveList(requestOptions);

    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { fileInfo });
  }

  async getVersion(fi: FileInfo, version?: string | FeedIndex): Promise<FileInfo> {
    const topicStr = fi.topic;
    const localHead = this.fileInfoList.find((f) => f.topic === topicStr);

    if (localHead && localHead.index && version) {
      const requested = new FeedIndex(version);
      const cachedIdx = new FeedIndex(localHead.index);
      if (cachedIdx.equals(requested)) {
        return localHead;
      }
    }

    const owner = fi.owner;
    const topic = new Topic(topicStr);
    let feedData: FeedPayloadResult;
    if (!version) {
      feedData = await getFeedData(this.bee, topic, owner);
    } else {
      const requestedIdx = new FeedIndex(version).toBigInt();
      feedData = await getFeedData(this.bee, topic, owner, requestedIdx);
    }

    return this.fetchFileInfo(feedData, fi);
  }

  // Restore a previous version of a file as the new head
  async restoreVersion(versionToRestore: FileInfo, requestOptions?: BeeRequestOptions): Promise<void> {
    const latest = await getFeedData(this.bee, new Topic(versionToRestore.topic), versionToRestore.owner.toString());
    const feedIndex = latest.feedIndex;
    const feedIndexNext = latest.feedIndexNext ? latest.feedIndexNext : new FeedIndex('0');

    if (latest.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileInfoError('No FileInfo versions found on‑chain');
    }

    const headSlot = feedIndex;

    if (!versionToRestore.index) {
      throw new Error('Restore version has to be defined');
    }

    if (headSlot.equals(new FeedIndex(versionToRestore.index))) {
      console.debug(`Head Slot cannot be restored. Please select a version lesser than: ${headSlot}`);
      return;
    }

    const restored: FileInfo = {
      ...versionToRestore,
      index: feedIndexNext.toString(),
      file: {
        reference: versionToRestore.file.reference,
        historyRef: versionToRestore.file.historyRef,
      },
    };

    const wrapper = await this.uploadFileInfo(restored, requestOptions);

    await this.saveFileInfoFeed(restored.batchId, wrapper, restored.topic, restored.index, requestOptions);

    this.emitter.emit(FileManagerEvents.FILE_VERSION_RESTORED, {
      restored,
    });
  }

  private async uploadFileInfo(fileInfo: FileInfo, requestOptions?: BeeRequestOptions): Promise<ReferenceWithHistory> {
    try {
      const uploadInfoRes = await this.bee.uploadData(
        fileInfo.batchId,
        JSON.stringify(fileInfo),
        {
          act: true,
          redundancyLevel: fileInfo.redundancyLevel,
        },
        requestOptions,
      );

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
    batchId: string | BatchId,
    fileInfoResult: ReferenceWithHistory,
    topic: string | Topic,
    index?: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    try {
      const uploadInfoRes = await this.bee.uploadData(
        batchId,
        JSON.stringify({
          reference: fileInfoResult.reference.toString(),
          historyRef: fileInfoResult.historyRef.toString(),
        } as ReferenceWithHistory),
        undefined,
        requestOptions,
      );

      const fw = this.bee.makeFeedWriter(new Topic(topic).toUint8Array(), this.signer, requestOptions);

      await fw.uploadReference(batchId, uploadInfoRes.reference, {
        index: index !== undefined ? FeedIndex.fromBigInt(BigInt(index)) : undefined,
      });
    } catch (error: any) {
      throw new FileInfoError(`Failed to save wrapped fileInfo feed: ${error}`);
    }
  }

  private async fetchFileInfo(feeData: FeedPayloadResult, fi: FileInfo): Promise<FileInfo> {
    if (feeData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      const ver = fi.index ?? '<unknown>';
      throw new FileInfoError(`File info not found for version: ${ver}`);
    }

    const wrapperRef = new Reference(feeData.payload.toUint8Array());
    const wrapperBytes = await this.bee.downloadData(wrapperRef.toString());
    const { reference, historyRef } = wrapperBytes.toJSON() as ReferenceWithHistory;

    const fileBytes = await this.bee.downloadData(reference, {
      actHistoryAddress: historyRef,
      actPublisher: fi.actPublisher,
    });

    const fileInfo = fileBytes.toJSON() as FileInfo;
    assertFileInfo(fileInfo);

    return fileInfo;
  }

  // TODO: owner drive creation similar to user drive creation ?
  private async saveDriveList(requestOptions?: BeeRequestOptions): Promise<void> {
    const ownerStamp = await this.getOwnerStamp();
    if (!ownerStamp) {
      throw new StampError('Owner stamp not found');
    }

    try {
      const driveListUploadResult = await this.bee.uploadData(
        ownerStamp.batchID,
        JSON.stringify(this.driveList),
        {
          act: true,
        },
        requestOptions,
      );

      const fw = this.bee.makeFeedWriter(this.driveListTopic.toUint8Array(), this.signer, requestOptions);
      const driveListData = await this.bee.uploadData(
        ownerStamp.batchID,
        JSON.stringify({
          reference: driveListUploadResult.reference.toString(),
          historyRef: driveListUploadResult.historyAddress.getOrThrow().toString(),
        }),
      );

      await fw.uploadReference(ownerStamp.batchID, driveListData.reference, {
        index: FeedIndex.fromBigInt(this.driveListNextIndex),
      });

      this.driveListNextIndex += 1n;
    } catch (error: any) {
      // TODO: refactor everywhere to error.message || error
      throw new DriveError(`Failed to save drive list: ${error}`);
    }
  }

  // TODO: this.ownerDrive?
  private async getOwnerStamp(): Promise<PostageBatch | undefined> {
    if (this.ownerStamp) return this.ownerStamp;

    try {
      const ownerStamp = (await this.bee.getPostageBatches()).find((s) => s.label === OWNER_STAMP_LABEL);
      if (ownerStamp && ownerStamp.usable) {
        this.ownerStamp = ownerStamp;
      }
      return ownerStamp;
    } catch (error: any) {
      console.error(`Failed to get owner stamp: ${error}`);
      return;
    }
  }

  // TODO: fix implementation + DriveError
  async destroyDrive(drive: DriveInfo): Promise<void> {
    const ownerStamp = await this.getOwnerStamp();
    if (ownerStamp && new BatchId(drive.batchId).equals(ownerStamp.batchID)) {
      throw new StampError(`Cannot destroy owner stamp, batchId: ${drive.batchId.toString()}`);
    }
    const driveIx = this.driveList.findIndex((d) => d.id.toString() === drive.id.toString());
    if (driveIx === -1) {
      throw new DriveError(`Drive ${drive.name} not found`);
    }

    await this.bee.diluteBatch(drive.batchId, STAMPS_DEPTH_MAX);

    this.driveList.splice(driveIx, 1);

    for (let i = this.fileInfoList.length - 1; i >= 0; --i) {
      if (this.fileInfoList[i].drive === drive.id.toString()) {
        this.fileInfoList.splice(i, 1);
      }
    }

    await this.saveDriveList();

    console.debug(`Drive destroyed: ${drive.name}`);
    this.emitter.emit(FileManagerEvents.DRIVE_DESTROYED, { drive });
  }

  // fetches the list of grantees who can access the file reference
  async getGrantees(fileInfo: FileInfo): Promise<GetGranteesResult> {
    const driveIx = this.driveList.findIndex((d) => d.id.toString() === fileInfo.drive);
    if (driveIx === -1) {
      throw new GranteeError(`Drive not found for file: ${fileInfo.name}`);
    }

    const info = this.driveList[driveIx].infoFeedList?.find((wf) => wf.topic === fileInfo.topic);
    if (!info || !info.eGranteeRef) {
      throw new GranteeError(`Grantee list or file not found for file: ${fileInfo.name}`);
    }

    return this.bee.getGrantees(info.eGranteeRef);
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
    const driveIx = this.driveList.findIndex((d) => d.id.toString() === fileInfo.drive);
    if (driveIx === -1 || !this.driveList[driveIx].infoFeedList) {
      throw new SendShareMessageError(`Drive or info feed not found for file: ${fileInfo.name}`);
    }

    const infoIx = this.driveList[driveIx].infoFeedList.findIndex((wf) => wf.topic === fileInfo.topic);
    if (infoIx === -1) {
      throw new SendShareMessageError(`FileInfo not found for file: ${fileInfo.name}`);
    }

    const grantResult = await this.handleGrantees(
      fileInfo,
      { add: recipients },
      this.driveList[driveIx].infoFeedList[infoIx].eGranteeRef,
    );

    this.driveList[driveIx].infoFeedList[infoIx].eGranteeRef = grantResult.ref.toString();

    await this.saveDriveList();

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
