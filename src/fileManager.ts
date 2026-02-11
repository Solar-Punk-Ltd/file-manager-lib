import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  CollectionUploadOptions,
  DownloadOptions,
  EthAddress,
  FeedIndex,
  FileUploadOptions,
  GetGranteesResult,
  Identifier,
  PostageBatch,
  PrivateKey,
  PublicKey,
  RedundancyLevel,
  RedundantUploadOptions,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { FeedResultWithIndex, ReferenceWithHistory, StateTopicInfo } from './types/utils';
import { assertDriveInfo, assertFileInfo, assertStateTopicInfo } from './utils/asserts';
import { fetchStamp, getFeedData, getWrappedData, settlePromises } from './utils/common';
import { FEED_INDEX_ZERO } from './utils/constants';
import { generateRandomBytes } from './utils/crypto';
import { getForksMap, loadMantaray } from './utils/mantaray';
import { processDownload } from './download';
import { EventEmitter, EventEmitterBase } from './eventEmitter';
import { DriveInfo, FileInfo, FileInfoOptions, FileManager, FileStatus, ShareItem } from './types';
import { processUpload } from './upload';
import {
  ADMIN_STAMP_LABEL,
  BeeVersionError,
  DriveError,
  FileInfoError,
  FILEMANAGER_STATE_TOPIC,
  FileManagerEvents,
  GranteeError,
  SignerError,
  StampError,
} from './utils';

export class FileManagerBase implements FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private publisher: PublicKey | undefined = undefined;
  private driveListNextIndex: bigint = 0n;
  private stateFeedTopic: Topic | undefined = undefined;
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private _adminStamp: PostageBatch | undefined = undefined;

  readonly driveList: DriveInfo[] = [];
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const verifiedAdminStamp = this.verifyStampUsability(adminStamp, batchId.toString());

    const randomTopic = await generateRandomBytes(Topic.LENGTH);
    const newStateFeedTopic = new Topic(randomTopic);
    const topicUploadRes = await this.bee.uploadData(verifiedAdminStamp.batchID, newStateFeedTopic.toUint8Array(), {
      act: true,
    });

    const topicState: StateTopicInfo = {
      topicReference: topicUploadRes.reference.toString(),
      historyAddress: topicUploadRes.historyAddress.getOrThrow().toString(),
      index: feedIndexNext.toString(),
    };
    const fw = this.bee.makeFeedWriter(FILEMANAGER_STATE_TOPIC.toUint8Array(), this.signer);
    await fw.uploadPayload(verifiedAdminStamp.batchID, JSON.stringify(topicState), { index: feedIndexNext });

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    const fileInfoPromises: Promise<FileInfo | null>[] = [];

    for (const d of this.driveList) {
      if (d.infoFeedList && d.infoFeedList.length > 0) {
        for (const feed of d.infoFeedList) {
          const fileInfoPromise = async (): Promise<FileInfo | null> => {
            try {
              const feedData = await getFeedData(
                this.bee,
                new Topic(feed.topic),
                this.signer.publicKey().address().toString(),
              );

              const fileInfoFeedData = feedData.payload.toJSON() as ReferenceWithHistory;
              const rawData = await this.bee.downloadData(fileInfoFeedData.reference.toString(), {
                actHistoryAddress: fileInfoFeedData.historyRef,
                actPublisher: tmpPublisher,
              });

              const unwrappedFileInfoData = rawData.toJSON() as FileInfo;
              assertFileInfo(unwrappedFileInfoData);

              return unwrappedFileInfoData;

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (error: any) {
              console.error(`Invalid FileInfo item, skipping it: ${error.message || error}`);
              return null;
            }
          };

          fileInfoPromises.push(fileInfoPromise());
        }
      }
    }

    await settlePromises(fileInfoPromises, (fileInfo) => {
      if (fileInfo !== null) {
        this.fileInfoList.push(fileInfo);
      }
    });

    console.debug('FileInfo lists fetched successfully.');
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
      this.driveList.length = 0;
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

    if (isAdmin) {
      console.debug('Creating admin drive with name: ', ADMIN_STAMP_LABEL);
      driveName = ADMIN_STAMP_LABEL;
      await this.createNewDriveListTopic(batchId.toString(), resetState);
    } else {
      const stamp = await fetchStamp(this.bee, batchId);
      this.verifyStampUsability(stamp, batchId.toString());
    }

    const randomId = await generateRandomBytes(Identifier.LENGTH);
    const driveInfo: DriveInfo = {
      id: new Identifier(randomId).toString(),
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

    // no need to save the drive list again if the file info feed is already saved in state
    if (!fileOptions.topic) {
      this.updateDriveList(driveIndex, topic.toString());

      await this.saveDriveList(requestOptions);
    }

    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { fileInfo });
  }

  private updateDriveList(driveIndex: number, topic: string): void {
    if (!this.driveList[driveIndex].infoFeedList) {
      this.driveList[driveIndex].infoFeedList = [];
    }

    const infoIx = this.driveList[driveIndex].infoFeedList.findIndex((wf) => wf.topic === topic);
    if (infoIx === -1) {
      this.driveList[driveIndex].infoFeedList.push({
        topic,
      });

      return;
    }

    // overwrite the existing grantee reference if it exists, as they do not have access to the new version
    this.driveList[driveIndex].infoFeedList[infoIx] = {
      topic,
      eGranteeRef: undefined,
    };
  }

  private verifyStampUsability(s: PostageBatch | undefined, batchId?: string): PostageBatch {
    if (!s || !s.usable) {
      throw new StampError(`Stamp with batchId: ${batchId?.slice(0, 6)}... not found OR not usable`);
    }

    return s;
  }

  private async getTopicAndVersion(
    address: string | EthAddress,
    currentTopic?: string | Topic,
    currentVersion?: string,
  ): Promise<{ topic: string; version: string }> {
    let version: string | undefined;
    let topic: string;

    if (!currentTopic) {
      const randomTopic = await generateRandomBytes(Topic.LENGTH);
      version = FEED_INDEX_ZERO.toString();
      topic = new Topic(randomTopic).toString();
    } else {
      version = currentVersion;
      topic = currentTopic.toString();
    }

    if (!version) {
      const { feedIndexNext } = await getFeedData(this.bee, new Topic(topic), address);
      version = feedIndexNext.toString();
    }

    return { topic, version: version ? version : FEED_INDEX_ZERO.toString() };
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
    const index = version !== undefined ? new FeedIndex(version).toBigInt() : undefined;
    const feedData = await getFeedData(this.bee, topic, fi.owner, index);

    return this.fetchFileInfo(fi, feedData);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      throw new FileInfoError(`Failed to save fileinfo: ${error.message || error}`);
    }
  }

  private async saveFileInfoFeed(fi: FileInfo, requestOptions?: BeeRequestOptions): Promise<void> {
    const fileInfoResult = await this.uploadFileInfo(fi);

    try {
      const fileInfoState = JSON.stringify({
        reference: fileInfoResult.reference.toString(),
        historyRef: fileInfoResult.historyRef.toString(),
      } as ReferenceWithHistory);

      const fw = this.bee.makeFeedWriter(new Topic(fi.topic).toUint8Array(), this.signer, requestOptions);

      await fw.uploadPayload(fi.batchId, fileInfoState, {
        index: fi.version !== undefined ? new FeedIndex(fi.version) : undefined,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      throw new FileInfoError(`Failed to save wrapped fileInfo feed: ${error.message || error}`);
    }
  }

  private async fetchFileInfo(fi: FileInfo, feeData: FeedResultWithIndex): Promise<FileInfo> {
    if (feeData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileInfoError(`File info not found for topic: ${fi.topic}`);
    }

    const data = feeData.payload.toJSON() as ReferenceWithHistory;

    const fileBytes = await this.bee.downloadData(data.reference.toString(), {
      actHistoryAddress: data.historyRef.toString(),
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

    const verifiedAdminStamp = this.verifyStampUsability(this.adminStamp, this.adminStamp?.batchID.toString());

    const adminRedundancyLevel = this.driveList.find((d) => d.isAdmin)?.redundancyLevel || RedundancyLevel.OFF;

    try {
      const driveListUploadResult = await this.bee.uploadData(
        verifiedAdminStamp.batchID,
        JSON.stringify(this.driveList),
        {
          act: true,
          redundancyLevel: adminRedundancyLevel,
        },
        requestOptions,
      );

      const driveListState = JSON.stringify({
        reference: driveListUploadResult.reference.toString(),
        historyRef: driveListUploadResult.historyAddress.getOrThrow().toString(),
      });

      const fw = this.bee.makeFeedWriter(this.stateFeedTopic.toUint8Array(), this.signer, requestOptions);
      await fw.uploadPayload(verifiedAdminStamp.batchID, driveListState, {
        index: FeedIndex.fromBigInt(this.driveListNextIndex),
      });

      this.driveListNextIndex += 1n;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const adminStamp = await fetchStamp(this.bee, batchId);

    if (!adminStamp) {
      return undefined;
    }

    const logText = `Admin stamp with batchId: ${batchId.toString().slice(0, 6)}...`;

    if (adminStamp.usable) {
      console.debug(`${logText} found and set.`);
    } else {
      console.warn(`${logText} is unusable.`);
    }

    this._adminStamp = adminStamp;

    return this.adminStamp;
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

  // eslint-disable-next-line require-await
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

  // eslint-disable-next-line require-await
  async subscribeToSharedInbox(_topic: string, _callback?: (_data: ShareItem) => void): Promise<void> {
    /** no-op */
    return;
  }

  unsubscribeFromSharedInbox(): void {
    /** no-op */
    return;
  }

  // eslint-disable-next-line require-await
  async share(_fileInfo: FileInfo, _targetOverlays: string[], _recipients: string[], _message?: string): Promise<void> {
    /** no-op */
    return;
  }
}
