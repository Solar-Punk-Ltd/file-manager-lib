import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  CollectionUploadOptions,
  DownloadOptions,
  FeedIndex,
  FileUploadOptions,
  GetGranteesResult,
  PostageBatch,
  PrivateKey,
  RedundantUploadOptions,
  Reference,
  Topic,
  RedundancyLevel,
  Identifier,
  PublicKey,
  EthAddress,
} from '@ethersphere/bee-js';

import { assertDriveInfo, assertFileInfo, assertStateTopicInfo } from './utils/asserts';
import { generateRandomBytes, getFeedData, getWrappedData, settlePromises } from './utils/common';
import { checkDriveCreationCapacity, estimateDriveListMetadataSize, CapacityCheckResult } from './utils/capacity';

import {
  FEED_INDEX_ZERO,
  ADMIN_STAMP_LABEL,
  FILEMANAGER_STATE_TOPIC,
  SWARM_ZERO_ADDRESS,
  MINIMUM_ADMIN_CAPACITY_BYTES,
} from './utils/constants';
import {
  AdminStampCapacityError,
  BeeVersionError,
  DriveError,
  FileInfoError,
  GranteeError,
  SignerError,
  StampError,
} from './utils/errors';
import { EventEmitter, EventEmitterBase } from './eventEmitter';
import { FileManagerEvents } from './utils/events';
import {
  FeedResultWithIndex,
  FileInfo,
  FileManager,
  FileInfoOptions,
  FileStatus,
  ReferenceWithHistory,
  ShareItem,
  DriveInfo,
  StateTopicInfo,
} from './utils/types';
import { getForksMap, loadMantaray } from './utils/mantaray';
import { processUpload } from './upload';
import { processDownload } from './download';

export class FileManagerBase implements FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private publisher: PublicKey | undefined = undefined;
  private driveListNextIndex: bigint = 0n;
  private stateFeedTopic: Topic | undefined = undefined;
  private driveList: DriveInfo[] = [];
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private _adminStamp: PostageBatch | undefined = undefined;

  readonly fileInfoList: FileInfo[] = [];
  readonly sharedWithMe: ShareItem[] = [];
  readonly emitter: EventEmitter;

  get adminStamp(): PostageBatch | undefined {
    return this._adminStamp;
  }

  constructor(bee: Bee, emitter: EventEmitter = new EventEmitterBase()) {
    this.bee = bee;
    if (!this.bee.signer) {
      throw new SignerError('Signer required');
    }

    this.emitter = emitter;
    this.signer = this.bee.signer;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.debug('FileManager is already initialized');

      this.emitter.emit(FileManagerEvents.INITIALIZED, true);
      return;
    }

    if (this.isInitializing) {
      console.debug('FileManager is being initialized');
      return;
    }

    this.isInitializing = true;

    try {
      await this.verifySupportedVersions();
      await this.initPublisher();

      console.debug('Trying to load state from Swarm.');

      const success = await this.tryToFetchAdminState();
      if (success) {
        await this.initDriveList();
        await this.initFileInfoList();
      }

      this.isInitialized = true;
      this.emitter.emit(FileManagerEvents.INITIALIZED, true);
    } catch (error: any) {
      console.error(`Failed to initialize FileManager: ${error.message || error}`);
      this.isInitialized = false;
      this.emitter.emit(FileManagerEvents.INITIALIZED, false);
    } finally {
      this.isInitializing = false;
    }
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

  // fetches the node public key neccessary for ACT handling
  private async initPublisher(): Promise<void> {
    this.publisher = (await this.bee.getNodeAddresses()).publicKey;
  }

  private async tryToFetchAdminState(): Promise<boolean> {
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const { payload, feedIndex } = await getFeedData(
      this.bee,
      FILEMANAGER_STATE_TOPIC,
      this.signer.publicKey().address().toString(),
    );

    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      console.debug('State not found.');
      return false;
    }

    let stateTopicInfo: StateTopicInfo;
    try {
      stateTopicInfo = payload.toJSON() as StateTopicInfo;
      assertStateTopicInfo(stateTopicInfo);
    } catch (error: any) {
      console.error(`Failed to fetch admin state: ${error.message || error}`);
      this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
      return false;
    }

    const stateTopicRef = new Reference(stateTopicInfo.topicReference);
    const topicHistoryRef = new Reference(stateTopicInfo.historyAddress);

    let topicBytes: Bytes;
    try {
      topicBytes = await this.bee.downloadData(stateTopicRef, {
        actHistoryAddress: topicHistoryRef,
        actPublisher: this.publisher,
      });
    } catch (error: any) {
      console.error(`Failed to decrypt admin state: ${error.message || error}`);
      this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
      return false;
    }

    this.stateFeedTopic = new Topic(topicBytes.toUint8Array());
    console.debug('Drive list feed successfully fetched');

    return true;
  }

  // fetches the drive list topic and creates it if it does not exist, protected by ACT
  private async createNewDriveListTopic(batchId: string | BatchId, resetState?: boolean): Promise<void> {
    const { feedIndexNext } = await getFeedData(
      this.bee,
      FILEMANAGER_STATE_TOPIC,
      this.signer.publicKey().address().toString(),
    );

    const isStateExisting = !feedIndexNext.equals(FEED_INDEX_ZERO);

    if (!resetState && isStateExisting) {
      throw new DriveError('Admin state already exists');
    }

    if (resetState) {
      console.warn('Resetting existing admin state.');
    }

    const adminStamp = await this.fetchAndSetAdminStamp(batchId);

    if (!adminStamp) {
      throw new StampError(`Admin stamp with batchId: ${batchId.toString().slice(0, 6)}... not found`);
    }

    const newStateFeedTopic = new Topic(generateRandomBytes(Topic.LENGTH));

    const topicUploadRes = await this.bee.uploadData(adminStamp.batchID, newStateFeedTopic.toUint8Array(), {
      act: true,
    });

    const topicState: StateTopicInfo = {
      topicReference: topicUploadRes.reference.toString(),
      historyAddress: topicUploadRes.historyAddress.getOrThrow().toString(),
      index: feedIndexNext.toString(),
    };
    const fw = this.bee.makeFeedWriter(FILEMANAGER_STATE_TOPIC.toUint8Array(), this.signer);
    await fw.uploadPayload(adminStamp.batchID, JSON.stringify(topicState), { index: feedIndexNext });

    this.stateFeedTopic = newStateFeedTopic;
    console.debug('Drive list feed topic successfully set');
    this.emitter.emit(FileManagerEvents.STATE_INVALID, false);
  }

  // fetches the latest list of fileinfo from the drive list topic
  private async initDriveList(): Promise<void> {
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    if (!this.stateFeedTopic) {
      console.debug('Drive list topic not initialized');
      this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
      return;
    }

    const { feedIndexNext, payload, feedIndex } = await getFeedData(
      this.bee,
      this.stateFeedTopic,
      this.signer.publicKey().address().toString(),
    );

    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      console.debug('Invalid drive list');
      this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
      return;
    }

    this.driveListNextIndex = feedIndexNext.toBigInt();
    const refWithHistory = payload.toJSON() as ReferenceWithHistory;

    const driveListRawData = await this.bee.downloadData(refWithHistory.reference, {
      actHistoryAddress: refWithHistory.historyRef,
      actPublisher: this.publisher,
    });
    const driveListData = driveListRawData.toJSON() as DriveInfo[];

    for (const item of driveListData) {
      try {
        assertDriveInfo(item);
      } catch (error: any) {
        console.error(`Invalid DriveInfo item: ${JSON.stringify(item)}, skipping it\n${error.message || error}`);
        continue;
      }

      if (item.isAdmin) {
        const adminStamp = await this.fetchAndSetAdminStamp(item.batchId.toString());

        if (!adminStamp) {
          const batchIdStr = item.batchId.toString();
          console.error(
            `Admin stamp with batchId: ${batchIdStr.slice(
              0,
              6,
            )}... not found. Admin state is invalid and must be reset.`,
          );

          this.emitter.emit(FileManagerEvents.STATE_INVALID, true);

          return;
        }
      }

      this.driveList.push(item);
    }

    console.debug('DriveInfo list fetched successfully.');
  }

  private async pruneDriveMetadata(driveInfo: DriveInfo): Promise<void> {
    const driveIx = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
    if (driveIx === -1) {
      throw new DriveError(`Drive ${driveInfo.name} not found`);
    }
    this.driveList.splice(driveIx, 1);
    for (let i = this.fileInfoList.length - 1; i >= 0; --i) {
      if (this.fileInfoList[i].driveId === driveInfo.id.toString()) {
        this.fileInfoList.splice(i, 1);
      }
    }
    await this.saveDriveList();
  }

  // fetches the file info list from the admin feed and unwraps the data encrypted with ACT
  private async initFileInfoList(): Promise<void> {
    // need a temporary variable to avoid async issues
    const tmpPublisher = this.publisher;
    if (!tmpPublisher) {
      throw new SignerError('Publisher not found');
    }

    if (this.driveList.length === 0) {
      console.debug('Drive list is empty, skipping file info list initialization');
      return;
    }

    const feedDataPromises: Promise<FeedResultWithIndex>[] = [];
    this.driveList.forEach((d) => {
      if (d.infoFeedList && d.infoFeedList.length > 0) {
        for (const feed of d.infoFeedList) {
          feedDataPromises.push(
            getFeedData(this.bee, new Topic(feed.topic), this.signer.publicKey().address().toString()),
          );
        }
      }
    });

    const rawDataPromises: Promise<Bytes>[] = [];
    await settlePromises<FeedResultWithIndex>(feedDataPromises, (value) => {
      const fileInfoFeedData = value.payload.toJSON() as ReferenceWithHistory;

      rawDataPromises.push(
        this.bee.downloadData(fileInfoFeedData.reference.toString(), {
          actHistoryAddress: fileInfoFeedData.historyRef,
          actPublisher: tmpPublisher,
        }),
      );
    });

    await settlePromises<Bytes>(rawDataPromises, (value) => {
      const unwrappedFileInfoData = value.toJSON() as FileInfo;

      try {
        assertFileInfo(unwrappedFileInfoData);
        this.fileInfoList.push(unwrappedFileInfoData);
      } catch (error: any) {
        console.error(`Invalid FileInfo item, skipping it: ${error.message || error}`);
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
      isAdmin: d.isAdmin,
      redundancyLevel: d.redundancyLevel,
    }));
  }

  public canCreateDrive(): CapacityCheckResult {
    return checkDriveCreationCapacity(this.adminStamp, this.driveList, this.driveListNextIndex, this.stateFeedTopic);
  }

  async createDrive(
    batchId: string | BatchId,
    name: string,
    isAdmin: boolean,
    redundancyLevel?: RedundancyLevel,
    resetState?: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized.');
    }

    let driveName = name;
    if (resetState) {
      this.driveList = [];
    } else {
      this.driveList.forEach((d) => {
        if (isAdmin && (d.isAdmin || this.adminStamp)) {
          throw new DriveError('Admin drive already exists');
        }

        if (d.name === driveName || d.batchId.toString() === batchId.toString()) {
          throw new DriveError(`Drive with name "${driveName}" or batchId "${batchId}" already exists`);
        }
      });
    }

    if (!isAdmin) {
      if (!this.adminStamp) {
        const adminDrive = this.driveList.find((d) => d.isAdmin);
        if (adminDrive) {
          await this.fetchAndSetAdminStamp(adminDrive.batchId.toString());
        }
      }

      const adminStamp = this.adminStamp;
      if (!adminStamp) {
        throw new StampError('Admin stamp not found');
      }

      if (!adminStamp.usable) {
        throw new AdminStampCapacityError('Admin stamp is not usable.');
      }

      const estimatedMetadataSize = estimateDriveListMetadataSize(
        this.driveList,
        this.driveList.length + 1,
        this.driveListNextIndex,
        this.stateFeedTopic,
      );
      const remainingBytes = adminStamp.remainingSize.toBytes();

      if (remainingBytes < estimatedMetadataSize) {
        throw new AdminStampCapacityError(
          `Insufficient admin drive capacity. Required: ~${estimatedMetadataSize} bytes, Available: ${remainingBytes} bytes. Please top up the admin drive.`,
        );
      }
    }

    if (isAdmin) {
      console.debug('Creating admin drive with name: ', ADMIN_STAMP_LABEL);
      driveName = ADMIN_STAMP_LABEL;
      await this.createNewDriveListTopic(batchId.toString(), resetState);
    }

    const driveInfo: DriveInfo = {
      id: new Identifier(generateRandomBytes(Identifier.LENGTH)).toString(),
      name: driveName,
      batchId: batchId.toString(),
      owner: this.signer.publicKey().address().toString(),
      redundancyLevel: redundancyLevel ?? RedundancyLevel.OFF,
      infoFeedList: [],
      isAdmin,
    };
    this.driveList.push(driveInfo);

    await this.saveDriveList(requestOptions);

    this.emitter.emit(FileManagerEvents.DRIVE_CREATED, { driveInfo });
  }

  async listFiles(fileInfo: FileInfo, options?: DownloadOptions): Promise<Record<string, string>> {
    const wrappedData = await getWrappedData(
      this.bee,
      fileInfo.file.reference,
      fileInfo.actPublisher,
      fileInfo.file.historyRef,
      options,
    );

    const mantaray = await loadMantaray(this.bee, wrappedData.uploadFilesRes.toString());

    return getForksMap(mantaray);
  }

  async download(
    fileInfo: FileInfo,
    paths?: string[],
    options?: DownloadOptions,
  ): Promise<ReadableStream<Uint8Array>[] | Bytes[]> {
    const wrappedData = await getWrappedData(
      this.bee,
      fileInfo.file.reference,
      fileInfo.actPublisher,
      fileInfo.file.historyRef,
      options,
    );

    const unmarshalled = await loadMantaray(this.bee, wrappedData.uploadFilesRes.toString());

    const resources = getForksMap(unmarshalled, paths);

    return await processDownload(this.bee, Object.values(resources));
  }

  async upload(
    driveInfo: DriveInfo,
    fileOptions: FileInfoOptions,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    if (!this.stateFeedTopic || !this.isInitialized) {
      throw new DriveError('FileManager is not initialized.');
    }

    if (
      (fileOptions.topic && !uploadOptions?.actHistoryAddress) ||
      (!fileOptions.topic && uploadOptions?.actHistoryAddress)
    ) {
      throw new FileInfoError('Options topic and historyRef have to be provided at the same time.');
    }

    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
    if (driveIndex === -1) {
      throw new FileInfoError(`Drive ${driveInfo.name} with id ${driveInfo.id.toString()} not found`);
    }

    const owner = this.signer.publicKey().address().toString();
    const { topic, version } = await this.getTopicAndVersion(owner, fileOptions.topic, fileOptions.version);

    const file = await processUpload(this.bee, driveInfo, fileOptions, uploadOptions, requestOptions);

    const fileInfo: FileInfo = {
      batchId: driveInfo.batchId.toString(),
      owner,
      topic,
      name: fileOptions.name,
      actPublisher: this.publisher.toCompressedHex(),
      file,
      driveId: driveInfo.id.toString(),
      timestamp: new Date().getTime(),
      shared: false,
      preview: undefined,
      version,
      customMetadata: fileOptions.customMetadata,
      redundancyLevel: driveInfo.redundancyLevel,
      status: FileStatus.Active,
    };

    await this.saveFileInfoFeed(fileInfo, requestOptions);

    if (!this.driveList[driveIndex].infoFeedList) {
      this.driveList[driveIndex].infoFeedList = [];
    }

    const infoIx = this.driveList[driveIndex].infoFeedList.findIndex((wf) => wf.topic.toString() === topic.toString());
    if (infoIx === -1) {
      this.driveList[driveIndex].infoFeedList.push({
        topic: topic.toString(),
      });
    } else {
      // overwrite the existing grantee reference if it exists, as they do not have access to the new version
      this.driveList[driveIndex].infoFeedList[infoIx] = {
        topic: topic.toString(),
        eGranteeRef: undefined,
      };
    }

    await this.saveDriveList(requestOptions);

    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { fileInfo });
  }

  private async getTopicAndVersion(
    address: string | EthAddress,
    currentTopic?: string | Topic,
    currentVersion?: string,
  ): Promise<{ topic: string; version: string }> {
    let version: string | undefined;
    let topic: string;

    if (!currentTopic) {
      version = FEED_INDEX_ZERO.toString();
      topic = new Topic(generateRandomBytes(Topic.LENGTH)).toString();
    } else {
      version = currentVersion;
      topic = currentTopic.toString();
    }

    if (!version) {
      const { feedIndexNext } = await getFeedData(this.bee, new Topic(topic), address);
      version = feedIndexNext.toString();
    }

    return { topic, version };
  }

  async getVersion(fi: FileInfo, version?: string | FeedIndex): Promise<FileInfo> {
    const localHead = this.fileInfoList.find((f) => f.topic === fi.topic);

    if (localHead && localHead.version && version) {
      const requested = new FeedIndex(version);
      const cachedIdx = new FeedIndex(localHead.version);
      if (cachedIdx.equals(requested)) {
        return localHead;
      }
    }

    const topic = new Topic(fi.topic);
    let feedData: FeedResultWithIndex;
    let unwrap = true;
    if (!version) {
      // Note: feedReader.download() unwraps the data if version is undefined
      feedData = await getFeedData(this.bee, topic, fi.owner, undefined, true);
      unwrap = false;
    } else {
      const requestedIdx = new FeedIndex(version).toBigInt();
      feedData = await getFeedData(this.bee, topic, fi.owner, requestedIdx, true);
    }

    return this.fetchFileInfo(fi, feedData, unwrap);
  }

  async restoreVersion(versionToRestore: FileInfo, requestOptions?: BeeRequestOptions): Promise<void> {
    const { feedIndex, feedIndexNext } = await getFeedData(
      this.bee,
      new Topic(versionToRestore.topic),
      versionToRestore.owner.toString(),
    );
    // nencessary string compare due to some conversion issues with FeedIndex equals
    if (feedIndex.toString() === FeedIndex.MINUS_ONE.toString()) {
      throw new FileInfoError('FileInfo feed not found');
    }

    if (!versionToRestore.version) {
      throw new Error('Restore version has to be defined');
    }

    const versionToRestoreIndex = new FeedIndex(versionToRestore.version).toString();
    if (feedIndex.toString() === versionToRestoreIndex) {
      console.debug(`Head Slot cannot be restored. Please select a version lesser than: ${versionToRestore.version}`);
      return;
    }

    const restored: FileInfo = {
      ...versionToRestore,
      version: feedIndexNext.toString(),
      file: {
        reference: versionToRestore.file.reference,
        historyRef: versionToRestore.file.historyRef,
      },
      timestamp: Date.now(),
    };

    await this.saveFileInfoFeed(restored, requestOptions);

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

      const existingIx = this.fileInfoList.findIndex((f) => f.topic.toString() === fileInfo.topic.toString());
      if (existingIx !== -1) {
        this.fileInfoList[existingIx] = fileInfo;
      } else {
        this.fileInfoList.push(fileInfo);
      }

      return {
        reference: uploadInfoRes.reference.toString(),
        historyRef: uploadInfoRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw new FileInfoError(`Failed to save fileinfo: ${error.message || error}`);
    }
  }

  private async saveFileInfoFeed(fi: FileInfo, requestOptions?: BeeRequestOptions): Promise<void> {
    const fileInfoResult = await this.uploadFileInfo(fi);

    try {
      const uploadInfoRes = await this.bee.uploadData(
        fi.batchId,
        JSON.stringify({
          reference: fileInfoResult.reference.toString(),
          historyRef: fileInfoResult.historyRef.toString(),
        } as ReferenceWithHistory),
        { redundancyLevel: fi.redundancyLevel },
        requestOptions,
      );

      const fw = this.bee.makeFeedWriter(new Topic(fi.topic).toUint8Array(), this.signer, requestOptions);

      await fw.uploadReference(fi.batchId, uploadInfoRes.reference, {
        index: fi.version !== undefined ? new FeedIndex(fi.version) : undefined,
      });
    } catch (error: any) {
      throw new FileInfoError(`Failed to save wrapped fileInfo feed: ${error.message || error}`);
    }
  }

  private async fetchFileInfo(fi: FileInfo, feeData: FeedResultWithIndex, unwrap: boolean): Promise<FileInfo> {
    if (feeData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileInfoError(`File info not found for topic: ${fi.topic}`);
    }

    let dataRef: string;
    let dataHRef: string;

    if (unwrap) {
      const wrapperRef = new Reference(feeData.payload.toUint8Array());
      const wrapperBytes = await this.bee.downloadData(wrapperRef.toString());
      const unwrapped = wrapperBytes.toJSON() as ReferenceWithHistory;
      dataRef = unwrapped.reference.toString();
      dataHRef = unwrapped.historyRef.toString();
    } else {
      const data = feeData.payload.toJSON() as ReferenceWithHistory;
      dataRef = data.reference.toString();
      dataHRef = data.historyRef.toString();
    }

    const fileBytes = await this.bee.downloadData(dataRef, {
      actHistoryAddress: dataHRef,
      actPublisher: fi.actPublisher,
    });

    const fileInfo = fileBytes.toJSON() as FileInfo;
    assertFileInfo(fileInfo);

    return fileInfo;
  }

  private async saveDriveList(requestOptions?: BeeRequestOptions): Promise<void> {
    if (!this.stateFeedTopic || !this.isInitialized) {
      throw new DriveError('Drive list topic not initialized');
    }

    const adminStamp = this.adminStamp;
    if (!adminStamp) {
      throw new StampError('Admin stamp not found');
    }

    if (!adminStamp.usable || adminStamp.remainingSize.toBytes() < MINIMUM_ADMIN_CAPACITY_BYTES) {
      throw new AdminStampCapacityError(
        `Admin drive capacity too low. Minimum required: ${MINIMUM_ADMIN_CAPACITY_BYTES} bytes, ` +
          `Available: ${adminStamp.remainingSize.toBytes()} bytes. Please top up the admin drive.`,
      );
    }

    try {
      const driveListUploadResult = await this.bee.uploadData(
        adminStamp.batchID,
        JSON.stringify(this.driveList),
        {
          act: true,
        },
        requestOptions,
      );

      const fw = this.bee.makeFeedWriter(this.stateFeedTopic.toUint8Array(), this.signer, requestOptions);
      const driveListData = await this.bee.uploadData(
        adminStamp.batchID,
        JSON.stringify({
          reference: driveListUploadResult.reference.toString(),
          historyRef: driveListUploadResult.historyAddress.getOrThrow().toString(),
        }),
      );

      await fw.uploadReference(adminStamp.batchID, driveListData.reference, {
        index: FeedIndex.fromBigInt(this.driveListNextIndex),
      });

      this.driveListNextIndex += 1n;
    } catch (error: any) {
      throw new DriveError(`Failed to save drive list: ${error.message || error}`);
    }
  }

  async trashFile(fileInfo: FileInfo): Promise<void> {
    const fi = this.fileInfoList.find((f) => f.topic.toString() === fileInfo.topic.toString());
    if (!fi) {
      throw new FileInfoError(`Corresponding File Info doesnt exist: ${fileInfo.name}`);
    }

    if (fi.status === FileStatus.Trashed) {
      throw new FileInfoError(`File already Thrashed: ${fileInfo.name}`);
    }

    if (fi.version === undefined) {
      throw new FileInfoError(`File version is undefined: ${fileInfo.name}`);
    }

    fi.version = new FeedIndex(fi.version).next().toString();
    fi.status = FileStatus.Trashed;
    fi.timestamp = new Date().getTime();
    fi.customMetadata = { ...(fi.customMetadata ?? {}), ...(fileInfo.customMetadata ?? {}) };

    await this.saveFileInfoFeed(fi);

    this.emitter.emit(FileManagerEvents.FILE_TRASHED, { fileInfo: fi });
  }

  async recoverFile(fileInfo: FileInfo): Promise<void> {
    const fi = this.fileInfoList.find((f) => f.topic === fileInfo.topic);
    if (!fi) {
      throw new FileInfoError(`Corresponding File Info doesnt exist: ${fileInfo.name}`);
    }

    if (fi.status !== FileStatus.Trashed) {
      throw new FileInfoError(`Non-Thrashed files cannot be restored: ${fileInfo.name}`);
    }

    if (fi.version === undefined) {
      throw new FileInfoError(`File version is undefined: ${fileInfo.name}`);
    }

    fi.version = new FeedIndex(fi.version).next().toString();
    fi.status = FileStatus.Active;
    fi.timestamp = new Date().getTime();
    fi.customMetadata = { ...(fi.customMetadata ?? {}), ...(fileInfo.customMetadata ?? {}) };

    await this.saveFileInfoFeed(fi);
    this.emitter.emit(FileManagerEvents.FILE_RECOVERED, { fileInfo: fi });
  }

  async forgetFile(fileInfo: FileInfo): Promise<void> {
    const topicStr = fileInfo.topic.toString();

    const fiIndex = this.fileInfoList.findIndex((f) => f.topic.toString() === topicStr);
    if (fiIndex === -1) {
      throw new FileInfoError(`File info not found for name: ${fileInfo.name}`);
    }

    const driveIndex = this.driveList.findIndex((d) => d.id.toString() === fileInfo.driveId.toString());
    if (driveIndex === -1 || this.driveList[driveIndex].infoFeedList === undefined) {
      throw new FileInfoError(`Drive or file feed not found for name: ${fileInfo.name}`);
    }

    const infoIx = this.driveList[driveIndex].infoFeedList.findIndex((wf) => wf.topic.toString() === topicStr);
    if (infoIx === -1) {
      throw new FileInfoError(`File not found for name: ${fileInfo.name} and topic: ${topicStr}`);
    }

    this.fileInfoList.splice(fiIndex, 1);
    this.driveList[driveIndex].infoFeedList.splice(infoIx, 1);

    await this.saveDriveList();

    this.emitter.emit(FileManagerEvents.FILE_FORGOTTEN, { fileInfo });
  }

  private async fetchAndSetAdminStamp(batchId: string | BatchId): Promise<PostageBatch | undefined> {
    try {
      const adminStamp = (await this.bee.getPostageBatches()).find((s) => s.batchID.toString() === batchId.toString());

      if (adminStamp) {
        const logText = `Admin stamp with batchId: ${batchId.toString().slice(0, 6)}...`;

        if (adminStamp.usable) {
          console.debug(`${logText} found and set.`);
        } else {
          console.warn(`${logText} is unusable.`);
        }

        this._adminStamp = adminStamp;

        return this.adminStamp;
      }

      return undefined;
    } catch (error: any) {
      console.error(`Failed to get admin stamp: ${error.message || error}`);
      return;
    }
  }

  async destroyDrive(driveInfo: DriveInfo, stamp: PostageBatch): Promise<void> {
    const adminStamp = this.adminStamp;
    if (!adminStamp) {
      throw new StampError('Admin stamp not found');
    }

    if (driveInfo.batchId.toString() !== stamp.batchID.toString()) {
      throw new StampError('Stamp does not match drive stamp');
    }

    if (driveInfo.isAdmin || driveInfo.batchId.toString() === adminStamp.batchID.toString()) {
      throw new DriveError(`Cannot destroy admin drive / stamp, batchId: ${driveInfo.batchId.toString()}`);
    }

    const ttlDays = stamp.duration.toDays();
    const halvings = Math.floor(Math.log2(ttlDays));
    await this.bee.diluteBatch(driveInfo.batchId.toString(), stamp.depth + halvings);
    await this.pruneDriveMetadata(driveInfo);
    console.debug(`Drive destroyed: ${driveInfo.name}`);
    this.emitter.emit(FileManagerEvents.DRIVE_DESTROYED, { driveInfo });
  }

  async forgetDrive(driveInfo: DriveInfo): Promise<void> {
    if (driveInfo.isAdmin) {
      throw new DriveError('Cannot forget admin drive');
    }
    await this.pruneDriveMetadata(driveInfo);
    console.debug(`Drive forgotten (metadata only): ${driveInfo.name}`);
    this.emitter.emit(FileManagerEvents.DRIVE_FORGOTTEN, { driveInfo });
  }

  async getGrantees(fileInfo: FileInfo): Promise<GetGranteesResult> {
    const driveIx = this.driveList.findIndex((d) => d.id.toString() === fileInfo.driveId);
    if (driveIx === -1) {
      throw new GranteeError(`Drive not found for file: ${fileInfo.name}`);
    }

    const info = this.driveList[driveIx].infoFeedList?.find((wf) => wf.topic === fileInfo.topic);
    if (!info || !info.eGranteeRef) {
      throw new GranteeError(`Grantee list or file not found for file: ${fileInfo.name}`);
    }

    return this.bee.getGrantees(info.eGranteeRef);
  }

  async subscribeToSharedInbox(_topic: string, _callback?: (_data: ShareItem) => void): Promise<void> {
    /** no-op */
    return;
  }

  unsubscribeFromSharedInbox(): void {
    /** no-op */
    return;
  }

  async share(_fileInfo: FileInfo, _targetOverlays: string[], _recipients: string[], _message?: string): Promise<void> {
    /** no-op */
    return;
  }
}
