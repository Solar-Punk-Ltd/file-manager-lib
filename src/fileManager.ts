import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  CollectionUploadOptions,
  DownloadOptions,
  FeedIndex,
  FileUploadOptions,
  Identifier,
  PostageBatch,
  PrivateKey,
  PublicKey,
  RedundancyLevel,
  RedundantUploadOptions,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { FileManager } from './types/fileManager';
import { DriveInfo, FileInfo, FileStatus } from './types/info';
import { FeedResultWithIndex, FileInfoOptions, ReferenceWithHistory, StateTopicInfo } from './types/utils';
import type { DownloadResource } from './types/v2/download';
import type { DriveInfo as DriveInfoV2 } from './types/v2/info';
import type { UploadSource } from './types/v2/upload';
import { assertDriveInfo, assertFileInfo, assertStateTopicInfo } from './utils/asserts';
import {
  fetchStamp,
  getFeedData,
  getTopicAndVersion,
  getWrappedData,
  verifyStampUsability,
  verifySupportedBeeVersions,
} from './utils/bee';
import { settlePromises } from './utils/common';
import { ADMIN_STAMP_LABEL, FEED_INDEX_ZERO, FILEMANAGER_STATE_TOPIC } from './utils/constants';
import { generateRandomBytes } from './utils/crypto';
import { DriveError, ErrorHandler, FileInfoError, SignerError, StampError } from './utils/errors';
import { FileManagerEvents } from './utils/events';
import { Logger } from './utils/logger';
import { getForksMap, loadMantaray } from './utils/mantaray';
import { processDownload } from './download';
import { EventEmitter, EventEmitterBase } from './eventEmitter';
import { processUpload } from './upload';

export class FileManagerBase implements FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private signerAddress: string;
  private publisher: PublicKey | undefined = undefined;
  private driveListNextIndex: bigint = 0n;
  private stateFeedTopic: Topic | undefined = undefined;
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private _adminStamp: PostageBatch | undefined = undefined;

  private readonly errorHandler = ErrorHandler.getInstance();
  private readonly logger = Logger.getInstance();

  readonly driveList: DriveInfo[] = [];
  readonly fileInfoList: FileInfo[] = [];
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
    this.signerAddress = this.signer.publicKey().address().toString();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.debug('FileManager is already initialized');

      this.emitter.emit(FileManagerEvents.INITIALIZED, true);
      return;
    }

    if (this.isInitializing) {
      this.logger.debug('FileManager is being initialized');
      return;
    }

    this.isInitializing = true;

    try {
      await verifySupportedBeeVersions(this.bee);
      await this.initPublisher();

      this.logger.debug('Trying to load state from Swarm.');

      const success = await this.tryToFetchAdminState();
      if (success) {
        await this.initDriveList();
        await this.initFileInfoList();
      }

      this.isInitialized = true;
      this.emitter.emit(FileManagerEvents.INITIALIZED, true);
    } catch (err: unknown) {
      this.errorHandler.handleError(err, 'FileManagerBase.initialize');
      this.isInitialized = false;
      this.emitter.emit(FileManagerEvents.INITIALIZED, false);
    } finally {
      this.isInitializing = false;
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

    const { payload, feedIndex } = await getFeedData(this.bee, FILEMANAGER_STATE_TOPIC, this.signerAddress);

    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      this.logger.debug('State not found.');
      return false;
    }

    let stateTopicInfo: StateTopicInfo;
    try {
      stateTopicInfo = payload.toJSON() as StateTopicInfo;
      assertStateTopicInfo(stateTopicInfo);
    } catch (err: unknown) {
      this.errorHandler.handleError(err, 'FileManagerBase.tryToFetchAdminState: fetch admin state');
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
    } catch (err: unknown) {
      this.errorHandler.handleError(err, 'FileManagerBase.tryToFetchAdminState: decrypt admin state');
      this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
      return false;
    }

    this.stateFeedTopic = new Topic(topicBytes.toUint8Array());
    this.logger.debug('Drive list feed successfully fetched');

    return true;
  }

  // fetches the drive list topic and creates it if it does not exist, protected by ACT
  private async createNewDriveListTopic(batchId: string | BatchId, resetState?: boolean): Promise<void> {
    const { feedIndexNext } = await getFeedData(this.bee, FILEMANAGER_STATE_TOPIC, this.signerAddress);

    const isStateExisting = !feedIndexNext.equals(FEED_INDEX_ZERO);

    if (!resetState && isStateExisting) {
      throw new DriveError('Admin state already exists');
    }

    if (resetState) {
      this.logger.warn('Resetting existing admin state.');
    }

    const batchStr = batchId.toString();
    await this.fetchAndSetAdminStamp(batchStr);
    const verifiedAdminStamp = verifyStampUsability(this.adminStamp, batchStr);

    const randomTopic = generateRandomBytes(Topic.LENGTH);
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
    this.driveListNextIndex = 0n;
    this.logger.debug('Drive list feed topic successfully set');
    this.emitter.emit(FileManagerEvents.STATE_INVALID, false);
  }

  // fetches the latest list of fileinfo from the drive list topic
  private async initDriveList(): Promise<void> {
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    if (!this.stateFeedTopic) {
      this.logger.debug('Drive list topic not initialized');
      this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
      return;
    }

    const { feedIndexNext, payload, feedIndex } = await getFeedData(this.bee, this.stateFeedTopic, this.signerAddress);

    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      this.logger.debug('Invalid drive list');
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
      } catch (err: unknown) {
        this.errorHandler.handleError(
          err,
          `FileManagerBase.initDriveList: invalid DriveInfo item, skipping: ${JSON.stringify(item)}`,
        );
        continue;
      }

      if (item.isAdmin) {
        const batchIdStr = item.batchId.toString();
        await this.fetchAndSetAdminStamp(batchIdStr);

        if (!this.adminStamp) {
          this.logger.error(
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

    this.logger.debug('DriveInfo list fetched successfully.');
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
      this.logger.debug('Drive list is empty, skipping file info list initialization');
      return;
    }

    const fileInfoPromises: Promise<FileInfo | null>[] = [];

    for (const d of this.driveList) {
      if (d.infoFeedList && d.infoFeedList.length > 0) {
        for (const feed of d.infoFeedList) {
          const fileInfoPromise = async (): Promise<FileInfo | null> => {
            try {
              const feedData = await getFeedData(this.bee, new Topic(feed.topic), this.signerAddress);

              const fileInfoFeedData = feedData.payload.toJSON() as ReferenceWithHistory;
              const rawData = await this.bee.downloadData(fileInfoFeedData.reference.toString(), {
                actHistoryAddress: fileInfoFeedData.historyRef,
                actPublisher: tmpPublisher,
              });

              const unwrappedFileInfoData = rawData.toJSON() as FileInfo;
              assertFileInfo(unwrappedFileInfoData);

              return unwrappedFileInfoData;
            } catch (err: unknown) {
              this.errorHandler.handleError(err, 'FileManagerBase.initFileInfoList: invalid FileInfo item, skipping');
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

    this.logger.debug('FileInfo lists fetched successfully.');
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
      if (!isAdmin) {
        throw new DriveError(`Cannot reset non-admin drive: "${driveName}"`);
      }

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
      this.logger.debug('Creating admin drive with name: ', ADMIN_STAMP_LABEL);
      driveName = ADMIN_STAMP_LABEL;
      await this.createNewDriveListTopic(batchId.toString(), resetState);
    } else {
      const stamp = await fetchStamp(this.bee, batchId);
      verifyStampUsability(stamp, batchId.toString());
    }

    const randomId = generateRandomBytes(Identifier.LENGTH);
    const driveInfo: DriveInfo = {
      id: new Identifier(randomId).toString(),
      name: driveName,
      batchId: batchId.toString(),
      owner: this.signerAddress,
      redundancyLevel: redundancyLevel ?? RedundancyLevel.OFF,
      infoFeedList: [],
      isAdmin,
    };
    this.driveList.push(driveInfo);

    await this.saveDriveList(requestOptions);

    this.emitter.emit(FileManagerEvents.DRIVE_CREATED, { driveInfo });
  }

  async listFiles(
    fileInfo: FileInfo,
    paths?: string[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<Record<string, string>> {
    const wrappedData = await getWrappedData(
      this.bee,
      fileInfo.file.reference,
      fileInfo.actPublisher,
      fileInfo.file.historyRef,
      options,
      requestOptions,
    );

    // cannot use act again if the ref is already decrypted
    const mantaray = await loadMantaray(
      this.bee,
      wrappedData.uploadFilesRes.toString(),
      { ...options, actPublisher: undefined, actHistoryAddress: undefined },
      requestOptions,
    );

    return getForksMap(mantaray, paths);
  }

  async download(
    fileInfo: FileInfo,
    paths?: string[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReadableStream<Uint8Array>[] | Bytes[]> {
    const resources = await this.listFiles(fileInfo, paths, options, requestOptions);

    const downloadResources: DownloadResource[] = Object.entries(resources).map(([path, reference]) => ({
      path,
      reference,
      actHistoryAddress: fileInfo.file.historyRef.toString(),
      actPublisher: fileInfo.actPublisher,
    }));

    const results = await processDownload(this.bee, downloadResources, options, requestOptions);

    return results.map((r) => r.result);
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

    const owner = this.signerAddress;
    const { topic, version } = await getTopicAndVersion(
      this.bee,
      owner,
      fileOptions.version,
      fileOptions.topic?.toString(),
    );

    const { contentRefs, rLevel } = await processUpload(
      this.bee,
      driveInfo as unknown as DriveInfoV2,
      fileOptions as unknown as UploadSource,
      driveInfo.redundancyLevel,
      uploadOptions as RedundantUploadOptions | FileUploadOptions | undefined,
      requestOptions,
    );

    const fileInfo: FileInfo = {
      batchId: driveInfo.batchId.toString(),
      owner,
      topic,
      name: fileOptions.name,
      actPublisher: this.publisher.toCompressedHex(),
      file: contentRefs,
      driveId: driveInfo.id.toString(),
      timestamp: new Date().getTime(),
      preview: undefined,
      version,
      customMetadata: fileOptions.customMetadata,
      redundancyLevel: rLevel,
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

    this.driveList[driveIndex].infoFeedList[infoIx] = {
      topic,
    };
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
    if (feedIndex.equals(FeedIndex.MINUS_ONE.toString())) {
      throw new FileInfoError('FileInfo feed not found');
    }

    if (!versionToRestore.version) {
      throw new Error('Restore version has to be defined');
    }

    const versionToRestoreIndex = new FeedIndex(versionToRestore.version);
    if (feedIndex.equals(versionToRestoreIndex)) {
      this.logger.debug(
        `Head Slot cannot be restored. Please select a version lesser than: ${versionToRestore.version}`,
      );
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
    } catch (err: unknown) {
      throw new FileInfoError('Failed to save fileinfo', err);
    }
  }

  private async saveFileInfoFeed(fi: FileInfo, requestOptions?: BeeRequestOptions): Promise<void> {
    const fileInfoResult = await this.uploadFileInfo(fi, requestOptions);

    try {
      const fileInfoState = JSON.stringify({
        reference: fileInfoResult.reference.toString(),
        historyRef: fileInfoResult.historyRef.toString(),
      } as ReferenceWithHistory);

      const fw = this.bee.makeFeedWriter(new Topic(fi.topic).toUint8Array(), this.signer, requestOptions);

      await fw.uploadPayload(fi.batchId, fileInfoState, {
        index: fi.version !== undefined ? new FeedIndex(fi.version) : undefined,
      });
    } catch (err: unknown) {
      throw new FileInfoError('Failed to save wrapped fileInfo feed', err);
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

    const verifiedAdminStamp = verifyStampUsability(this.adminStamp, this.adminStamp?.batchID.toString());

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
    } catch (err: unknown) {
      throw new DriveError('Failed to save drive list', err);
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

  private async fetchAndSetAdminStamp(batchId: string): Promise<void> {
    const adminStamp = await fetchStamp(this.bee, batchId);

    if (!adminStamp) {
      this._adminStamp = undefined;

      return;
    }

    const logText = `Admin stamp with batchId: ${batchId.toString().slice(0, 6)}...`;

    if (adminStamp.usable) {
      this.logger.debug(`${logText} found and set.`);
    } else {
      this.logger.warn(`${logText} is unusable.`);
    }

    this._adminStamp = adminStamp;
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

    this.logger.debug(`Drive destroyed: ${driveInfo.name}`);
    this.emitter.emit(FileManagerEvents.DRIVE_DESTROYED, { driveInfo });
  }

  async forgetDrive(driveInfo: DriveInfo): Promise<void> {
    if (driveInfo.isAdmin) {
      throw new DriveError('Cannot forget admin drive');
    }

    await this.pruneDriveMetadata(driveInfo);
    this.logger.debug(`Drive forgotten (metadata only): ${driveInfo.name}`);
    this.emitter.emit(FileManagerEvents.DRIVE_FORGOTTEN, { driveInfo });
  }
}
