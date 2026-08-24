import {
  type BatchId,
  type Bee,
  type BeeRequestOptions,
  type Bytes,
  type DownloadOptions,
  FeedIndex,
  type FileUploadOptions,
  Identifier,
  MantarayNode,
  type PostageBatch,
  type PrivateKey,
  type PublicKey,
  RedundancyLevel,
  type RedundantUploadOptions,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { type DownloadFilesResult, type DownloadResource, type DownloadResult } from './types/download';
import { type FileManager, type FileManagerConfig } from './types/fileManager';
import {
  type DriveInfo,
  FailureScope,
  type FileRecord,
  type FolderInfo,
  ListDepth,
  type ListFolderResult,
  type ManifestHost,
  type NodeEntry,
  type NodeFailure,
  type NodeHeader,
  NodeStatus,
  NodeType,
  type ResolvedFileFork,
  type UnresolvedDrive,
} from './types/info';
import { type UpdateItem, type UploadFilesResult, type UploadItem } from './types/upload';
import { type ActReferences, type FailedResult } from './types/utils';
import { assertActReferences, assertDriveInfoFromMetadata, assertReady } from './utils/asserts';
import {
  fetchStamp,
  getFeedData,
  getTopicAndVersion,
  verifyStampUsability,
  verifySupportedBeeVersions,
} from './utils/bee';
import { awaitAllPromisesBounded, errorMessage, getRecordStatus, joinPath, settlePromises } from './utils/common';
import {
  ADMIN_DRIVE_NAME,
  FEED_INDEX_ZERO,
  FILEMANAGER_STATE_TOPIC,
  MANIFEST_METADATA_DRIVE_ID,
  MANIFEST_METADATA_DRIVE_NAME,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_NODE_VERSION,
  MANIFEST_METADATA_TRASHED_FROM,
  MAX_CONCURRENT_FEED_FETCHES,
  MAX_CONCURRENT_UPLOADS,
  ROOT_PATH,
  TRASH_FOLDER_NAME,
} from './utils/constants';
import { generateRandomBytes } from './utils/crypto';
import { DriveError, ErrorHandler, FileError, FileRecordError, FolderError, SignerError } from './utils/errors';
import { FileManagerEvents } from './utils/events';
import { Logger } from './utils/logger';
import {
  driveForkMetadata,
  fileForkMetadata,
  folderForkMetadata,
  folderInfoFromMetadata,
  getAllNodeEntries,
  getDriveForkPath,
  getRlevel,
} from './utils/mantaray';
import {
  assertNotTrashPath,
  assertValidNodePath,
  assertValidRelativePath,
  isTrashPath,
  normalizePath,
  pathSegments,
  splitPath,
  trashPathOf,
} from './utils/path';
import { processDownload } from './download';
import { type EventEmitter, EventEmitterBase } from './eventEmitter';
import { MantarayStore } from './mantarayStore';
import { assertUploadableSource, processUpload } from './upload';

export class FileManagerBase implements FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private signerAddress: string;
  private publisher: PublicKey | undefined = undefined;
  private stateFeedTopic: Topic | undefined = undefined;
  private isInitializing: boolean = false;
  private adminRedundancyLevel: RedundancyLevel = RedundancyLevel.OFF;
  private uploadConcurrency: number;
  private feedFetchConcurrency: number;
  private _adminStamp: PostageBatch | undefined = undefined;
  private _isInitialized: boolean = false;
  private readonly _driveList: DriveInfo[] = [];
  private readonly _recordList: FileRecord[] = [];
  private readonly store: MantarayStore;
  private readonly errorHandler = ErrorHandler.getInstance();
  private readonly logger = Logger.getInstance();

  // --- Public member getters ---

  readonly emitter: EventEmitter;

  get adminStamp(): PostageBatch | undefined {
    return this._adminStamp;
  }

  get driveList(): readonly DriveInfo[] {
    return this._driveList;
  }

  get recordList(): readonly FileRecord[] {
    return this._recordList;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  // --- Initialization ---

  constructor(bee: Bee, emitter: EventEmitter = new EventEmitterBase(), config?: FileManagerConfig) {
    this.bee = bee;
    if (!this.bee.signer) {
      throw new SignerError('Signer required');
    }

    this.emitter = emitter;
    this.uploadConcurrency = Math.max(1, config?.uploadConcurrency ?? MAX_CONCURRENT_UPLOADS);
    this.feedFetchConcurrency = Math.max(1, config?.feedFetchConcurrency ?? MAX_CONCURRENT_FEED_FETCHES);
    this.signer = this.bee.signer;
    this.signerAddress = this.signer.publicKey().address().toString();
    this.store = new MantarayStore(this.bee, this.signer);
  }

  // File records are loaded lazily via listFolder / download / move as the user navigates — no eager full-drive load at init.
  async initialize(requestOptions?: BeeRequestOptions): Promise<void> {
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
      await verifySupportedBeeVersions(this.bee, requestOptions);
      await this.initPublisher(requestOptions);

      this.logger.debug('Trying to load state from Swarm.');

      const success = await this.tryToFetchAdminState(requestOptions);
      if (success) {
        await this.initDriveList(requestOptions);
      }

      this._isInitialized = true;
    } catch (err: unknown) {
      this.resetState();
      this.errorHandler.handleError(err, 'Failed to initialize FileManager');
      this.emitter.emit(FileManagerEvents.INITIALIZED, false);

      return;
    } finally {
      this.isInitializing = false;
    }

    this.emitter.emit(FileManagerEvents.INITIALIZED, true);
  }

  // --- Drive operations ---

  async createAdminDrive(
    batchId: string | BatchId,
    redundancyLevel?: RedundancyLevel,
    reset?: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<DriveInfo> {
    requestOptions?.signal?.throwIfAborted();

    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized');
    }
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }
    if (!reset && this.driveList.some((d) => d.isAdmin)) {
      throw new DriveError('Admin drive already exists');
    }

    const publisher = this.publisher.toCompressedHex();
    const batchIdStr = batchId.toString();
    const level = redundancyLevel ?? RedundancyLevel.OFF;

    this.logger.debug('Creating admin drive with name: ', ADMIN_DRIVE_NAME);
    await this.fetchAndSetAdminStamp(batchIdStr, requestOptions);
    verifyStampUsability(this.adminStamp, batchIdStr);

    await this.establishAdminState(batchIdStr, level, reset, requestOptions);

    return this.registerDrive(
      { name: ADMIN_DRIVE_NAME, batchId: batchIdStr, isAdmin: true, redundancyLevel: level, publisher },
      requestOptions,
    );
  }

  async createDrive(
    batchId: string | BatchId,
    name: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<DriveInfo> {
    requestOptions?.signal?.throwIfAborted();

    const { publisher, stateFeedTopic } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    if (!this.store.getNodeRef(stateFeedTopic)) {
      throw new DriveError('Admin manifest not set');
    }

    const batchIdStr = batchId.toString();
    const fetchedStamp = await fetchStamp(this.bee, batchId, requestOptions);
    verifyStampUsability(fetchedStamp, batchIdStr);

    return this.registerDrive(
      { name, batchId: batchIdStr, isAdmin: false, redundancyLevel: redundancyLevel ?? RedundancyLevel.OFF, publisher },
      requestOptions,
    );
  }

  async forgetDrive(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<void> {
    const { publisher, stateFeedTopic } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    if (cachedDrive.isAdmin) {
      throw new DriveError('Cannot forget admin drive');
    }

    await this.pruneDriveMetadata(cachedDrive, driveIx, stateFeedTopic, publisher, requestOptions);
    this.logger.debug(`Drive forgotten (metadata only): ${cachedDrive.name}`);
    this.emitter.emit(FileManagerEvents.DRIVE_FORGOTTEN, { driveInfo: cachedDrive });
  }

  // --- File write operations ---

  async uploadFile(
    driveId: string | Identifier,
    item: UploadItem,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    assertUploadableSource(item);
    assertValidNodePath(item.path);
    assertNotTrashPath(item.path);

    // Resolve the parent folder up front so the new fork inherits the parent's redundancy level.
    const { parentPath, name: filename } = splitPath(item.path);

    const { host: targetHost, folder: parentFolder } = await this.store.resolveHost(
      cachedDrive,
      parentPath,
      publisher,
      requestOptions,
    );

    const mantarayNode = await this.store.getMantarayNode(
      targetHost.topic,
      publisher,
      targetHost.manifestRef,
      requestOptions,
    );
    if (mantarayNode.find(filename)) {
      throw new DriveError(`Node already exists at "${item.path}" — use updateFile to re-version a file`);
    }

    const owner = this.signerAddress;
    const { topic, version } = await getTopicAndVersion(this.bee, owner, undefined, undefined, requestOptions);

    const { contentRefs, rLevel } = await processUpload(
      this.bee,
      cachedDrive,
      item,
      targetHost.redundancyLevel,
      uploadOptions,
      requestOptions,
    );
    const record: FileRecord = {
      type: NodeType.File,
      batchId: cachedDrive.batchId,
      owner,
      topic,
      name: filename,
      path: filename,
      actPublisher: publisher,
      content: contentRefs,
      driveId: cachedDrive.id,
      timestamp: new Date().getTime(),
      version,
      customMetadata: item.customMetadata,
      redundancyLevel: rLevel,
      status: NodeStatus.Active,
    };

    await this.persistRecord(record, requestOptions);
    // In-memory copy is the caller-known absolute path — no walk needed here.
    record.path = item.path;

    mantarayNode.addFork(filename, new Reference(record.topic), fileForkMetadata(record));

    const newManifestRef = await this.store.saveMantarayNode(mantarayNode, targetHost, requestOptions);

    if (!parentFolder) {
      this.driveList[driveIx].manifestRef = newManifestRef;
    }

    this.cacheRecord(record);
    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { record });

    return record;
  }

  async uploadFiles(
    driveId: string | Identifier,
    items: UploadItem[],
    destinationPath: string = ROOT_PATH,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<UploadFilesResult> {
    requestOptions?.signal?.throwIfAborted();

    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    if (!items.length) {
      throw new FileRecordError('uploadFiles requires at least one entry');
    }

    for (const entry of items) {
      assertValidRelativePath(entry.path);
      assertUploadableSource(entry);
    }

    assertNotTrashPath(destinationPath);

    const destSegments = pathSegments(destinationPath);
    const destKey = destSegments.join('/');
    const { host: destHost } = await this.store.resolveHost(cachedDrive, destinationPath, publisher, requestOptions);

    interface PlannedFile {
      item: UploadItem;
      fullPath: string;
      filename: string;
      parentPath: string;
    }

    const plannedFiles: PlannedFile[] = [];
    const neededFolderPaths = new Set<string>();
    const plannedPaths = new Set<string>();

    for (const item of items) {
      const relSegments = pathSegments(item.path);
      const filename = relSegments[relSegments.length - 1];
      const folderSegments = relSegments.slice(0, -1);
      const fullPath = [...destSegments, ...relSegments].join('/');
      const parentPath = [...destSegments, ...folderSegments].join('/');

      assertNotTrashPath(fullPath);

      if (plannedPaths.has(fullPath)) {
        throw new FileRecordError(`Duplicate destination path in batch: "${fullPath}"`);
      }
      plannedPaths.add(fullPath);

      plannedFiles.push({ item, fullPath, filename, parentPath });

      for (let i = 1; i <= folderSegments.length; i++) {
        neededFolderPaths.add([...destSegments, ...folderSegments.slice(0, i)].join('/'));
      }
    }

    const sortedFolderPaths = Array.from(neededFolderPaths).sort(
      (a, b) => pathSegments(a).length - pathSegments(b).length,
    );

    const hostMap = new Map<string, ManifestHost>();
    hostMap.set(destKey, destHost);

    const missingFolderPaths = new Set<string>();
    const missingFolders: { path: string; parentPath: string; folderName: string }[] = [];

    for (const path of sortedFolderPaths) {
      const segments = pathSegments(path);
      const folderName = segments[segments.length - 1];
      const parentPath = segments.slice(0, -1).join('/');

      if (missingFolderPaths.has(parentPath)) {
        missingFolderPaths.add(path);
        missingFolders.push({ path, parentPath, folderName });
        continue;
      }

      const parentHost = hostMap.get(parentPath);
      if (!parentHost) {
        throw new DriveError(`Internal error: parent folder not resolved for path: ${path}`);
      }

      const parentMantaray = await this.store.getMantarayNode(
        parentHost.topic,
        publisher,
        parentHost.manifestRef,
        requestOptions,
      );
      const fork = parentMantaray.find(folderName);

      if (!fork) {
        missingFolderPaths.add(path);
        missingFolders.push({ path: path, parentPath, folderName });
        continue;
      }

      const meta = fork.metadata ?? {};
      if (meta[MANIFEST_METADATA_NODE_TYPE] !== NodeType.Folder) {
        throw new DriveError(`Path is not a folder: ${path}`);
      }

      const folderTopic = meta[MANIFEST_METADATA_NODE_TOPIC];
      if (!folderTopic) {
        throw new FileRecordError(`Folder fork missing topic: ${path}`);
      }

      // Folder manifest reads always probe the feed head. A folder is a container and carries no stored version
      const { payload, feedIndex } = await getFeedData(
        this.bee,
        new Topic(folderTopic),
        this.signerAddress,
        undefined,
        requestOptions,
      );

      if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
        throw new DriveError(`Folder feed not found for path: ${path}`);
      }
      const manifestRef: ActReferences = payload.toJSON() as ActReferences;
      assertActReferences(manifestRef);

      hostMap.set(path, {
        owner: this.signerAddress,
        topic: folderTopic,
        manifestRef,
        batchId: cachedDrive.batchId,
        redundancyLevel: getRlevel(meta, cachedDrive.redundancyLevel),
        actPublisher: publisher,
      });
    }

    const dirtyHosts = new Map<string, ManifestHost>();
    const createdFolders: FolderInfo[] = [];

    for (const { path, parentPath, folderName } of missingFolders) {
      const parentHost = hostMap.get(parentPath);
      if (!parentHost) {
        throw new DriveError(`Internal error: parent folder not resolved for path: ${path}`);
      }

      const { folder: folderInfo } = await this.createFolderNode(
        cachedDrive,
        parentHost,
        parentPath,
        folderName,
        publisher,
        undefined,
        requestOptions,
      );

      hostMap.set(path, folderInfo);
      createdFolders.push(folderInfo);
      dirtyHosts.set(parentHost.topic, parentHost);
    }

    const succeeded: FileRecord[] = [];
    const failed: FailedResult[] = [];
    const owner = this.signerAddress;

    await awaitAllPromisesBounded(
      plannedFiles.map((planned) => async (): Promise<FileRecord> => {
        // Stop starting files as soon as the caller aborts
        requestOptions?.signal?.throwIfAborted();

        const parentHost = hostMap.get(planned.parentPath);
        if (!parentHost) {
          throw new FileRecordError(`Internal error: parent folder not resolved for path: ${planned.fullPath}`);
        }

        const parentMantaray = await this.store.getMantarayNode(
          parentHost.topic,
          publisher,
          parentHost.manifestRef,
          requestOptions,
        );

        if (parentMantaray.find(planned.filename)) {
          throw new DriveError(`Node already exists at "${planned.fullPath}" — use updateFile to re-version a file`);
        }

        const { topic, version } = await getTopicAndVersion(this.bee, owner, undefined, undefined, requestOptions);

        const { contentRefs, rLevel } = await processUpload(
          this.bee,
          cachedDrive,
          planned.item,
          parentHost.redundancyLevel,
          uploadOptions,
          requestOptions,
        );

        const record: FileRecord = {
          type: NodeType.File,
          batchId: cachedDrive.batchId,
          owner,
          topic,
          name: planned.filename,
          path: planned.filename,
          actPublisher: publisher,
          content: contentRefs,
          driveId: cachedDrive.id,
          timestamp: new Date().getTime(),
          version,
          customMetadata: planned.item.customMetadata,
          redundancyLevel: rLevel,
          status: NodeStatus.Active,
        };

        await this.persistRecord(record, requestOptions);
        // In-memory copy is stamped with the already-planned absolute path — no walk needed here.
        record.path = planned.fullPath;

        parentMantaray.addFork(planned.filename, new Reference(record.topic), fileForkMetadata(record));
        dirtyHosts.set(parentHost.topic, parentHost);

        return record;
      }),
      this.uploadConcurrency,
      (record) => succeeded.push(record),
      (reason, ix) => {
        if (requestOptions?.signal?.aborted) return;
        failed.push({ path: plannedFiles[ix].fullPath, error: errorMessage(reason) });
      },
    );

    const mutatedTopics = (): string[] => [...dirtyHosts.keys(), ...createdFolders.map((f) => f.topic)];

    if (requestOptions?.signal?.aborted) {
      this.discardCachedUploads(succeeded, mutatedTopics());
      requestOptions.signal.throwIfAborted();
    }

    // Until every dirty manifest is saved no fork addition is durable, so the batch's records stay
    // uncommitted — a partial finalize discards the whole batch rather than caching half a tree.
    try {
      for (const host of dirtyHosts.values()) {
        const mantarayNode = await this.store.getMantarayNode(host.topic, publisher, host.manifestRef, requestOptions);
        const updatedNodeRef = await this.store.saveMantarayNode(mantarayNode, host, requestOptions);

        if (host.topic === cachedDrive.topic) {
          this.driveList[driveIx].manifestRef = updatedNodeRef;
        }
      }
    } catch (err: unknown) {
      this.discardCachedUploads(succeeded, mutatedTopics());
      this.errorHandler.handleError(err, 'Failed to finalize upload batch');
      throw err;
    }

    for (const record of succeeded) {
      this.cacheRecord(record);
    }
    for (const folderInfo of createdFolders) {
      this.emitter.emit(FileManagerEvents.FOLDER_CREATED, { folderInfo });
    }
    for (const record of succeeded) {
      this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { record });
    }

    const result: UploadFilesResult = { succeeded, failed };
    this.emitter.emit(FileManagerEvents.FILES_UPLOADED, result);

    return result;
  }

  async updateFile(
    driveId: string | Identifier,
    record: FileRecord,
    changes: UpdateItem,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    const noMeta = !changes.customMetadata || Object.keys(changes.customMetadata).length === 0;
    if (noMeta && !changes.item) {
      throw new FileRecordError('Neither a file/path nor customMetadata is provided');
    }

    if (changes.item !== undefined) {
      assertUploadableSource(changes.item);
    }

    const owner = this.signerAddress;
    // Always resolve the current head
    const { record: cached, fromCache } = await this.loadRecord(
      record.topic,
      record.owner,
      record.actPublisher,
      undefined,
      requestOptions,
    );

    if (cached.driveId && cached.driveId !== cachedDrive.id) {
      throw new FileRecordError(`Record ${record.topic.slice(0, 6)} does not belong to drive "${cachedDrive.name}"`);
    }
    cached.driveId = cachedDrive.id;

    // A cached record already holds the authoritative absolute path; keep it.
    if (!fromCache) {
      cached.path = record.path;
    }

    if (getRecordStatus(cached.path) === NodeStatus.Trashed) {
      throw new FileRecordError(
        `Cannot update a trashed file: ${cached.trashedFrom ?? cached.path} — recover it first`,
      );
    }
    cached.status = NodeStatus.Active;

    const { topic, version } = await getTopicAndVersion(this.bee, owner, cached.version, record.topic, requestOptions);

    const resolvedFork = await this.resolveFileFork(cachedDrive, cached.path, cached.topic, publisher, requestOptions);
    const filename = resolvedFork.filename;

    const mergedMetadata = changes.customMetadata
      ? { ...cached.customMetadata, ...changes.customMetadata }
      : cached.customMetadata;

    let contentRefAndHistory: ActReferences;
    if (changes.item !== undefined) {
      const contentUploadOptions = {
        ...uploadOptions,
        actHistoryAddress: cached.content.historyRef,
      };

      const { contentRefs } = await processUpload(
        this.bee,
        cachedDrive,
        changes.item,
        cached.redundancyLevel ?? cachedDrive.redundancyLevel,
        contentUploadOptions,
        requestOptions,
      );
      contentRefAndHistory = contentRefs;
    } else {
      contentRefAndHistory = cached.content;
    }

    const fr: FileRecord = {
      type: NodeType.File,
      batchId: cached.batchId,
      owner,
      topic,
      name: filename,
      path: filename,
      actPublisher: cached.actPublisher,
      content: contentRefAndHistory,
      driveId: cached.driveId,
      timestamp: new Date().getTime(),
      version,
      customMetadata: mergedMetadata,
      redundancyLevel: cached.redundancyLevel,
      status: cached.status ?? NodeStatus.Active,
    };

    const writtenVersion = await this.persistRecord(fr, requestOptions);
    await this.commitForkVersion(driveIx, resolvedFork, writtenVersion, requestOptions);

    fr.path = cached.path;

    this.cacheRecord(fr);
    this.emitter.emit(FileManagerEvents.FILE_UPDATED, { record: fr });

    return fr;
  }

  // --- File read operations ---

  // Download a single file the caller already holds as a FileRecord — convenience wrapper over
  // downloadFiles(). Does not re-resolve against drive state (see downloadFiles).
  async downloadFile(
    fileRecord: FileRecord,
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult> {
    const { succeeded, failed } = await this.downloadFiles([fileRecord], options, requestOptions);

    if (succeeded.length === 0) {
      throw new FileError(`Failed to download ${fileRecord.path}: ${failed[0]?.error ?? 'unknown error'}`);
    }

    return succeeded[0];
  }

  /**
   * Download files whose FileRecords the caller already holds — no drive traversal or hydration.
   * Fetches exactly the passed records: it does NOT re-resolve them against current drive state,
   * so the caller is responsible for record currency (a stale record fetches whatever it points at,
   * e.g. an older version). For folder- or drive-based fetching that resolves fresh, use downloadFolder().
   */
  async downloadFiles(
    fileRecords: FileRecord[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadFilesResult> {
    requestOptions?.signal?.throwIfAborted();
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    if (fileRecords.length === 0) return { succeeded: [], failed: [] };

    const resources: DownloadResource[] = fileRecords.map((fr) => ({
      path: fr.path,
      reference: fr.content.reference,
      actHistoryAddress: fr.content.historyRef,
      actPublisher: fr.actPublisher,
    }));

    return await processDownload(this.bee, resources, options, requestOptions);
  }

  // --- File version operations ---

  async getFileVersion(
    fr: FileRecord,
    version?: string | FeedIndex,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    const localHead = this.recordList.find((f) => f.topic === fr.topic);

    if (localHead && localHead.version && version) {
      const requested = new FeedIndex(version);
      const cachedIdx = new FeedIndex(localHead.version);
      if (cachedIdx.equals(requested)) {
        return localHead;
      }
    }

    const topic = new Topic(fr.topic);
    const index = version !== undefined ? new FeedIndex(version).toBigInt() : undefined;
    const feedData = await getFeedData(this.bee, topic, fr.owner, index, requestOptions);
    if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileRecordError(`File feed not found for topic: ${fr.topic.slice(0, 6)}`);
    }

    const versionRecord = await this.store.getRecord(
      topic.toString(),
      fr.actPublisher,
      feedData,
      { isHeadRead: version === undefined },
      requestOptions,
    );
    versionRecord.driveId = fr.driveId;
    versionRecord.path = localHead?.path ?? fr.path;
    versionRecord.name = localHead?.name ?? fr.name;

    return versionRecord;
  }

  async restoreFileVersion(versionToRestore: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    if (!versionToRestore.driveId) {
      throw new FileRecordError(
        'Cannot restore: record has no driveId — obtain it via listFolder/getFileVersion first',
      );
    }
    const { driveIx, cachedDrive } = this.findDriveOrThrow(versionToRestore.driveId);

    const { feedIndex, feedIndexNext } = await getFeedData(
      this.bee,
      new Topic(versionToRestore.topic),
      versionToRestore.owner,
      undefined,
      requestOptions,
    );
    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileRecordError('Record feed not found');
    }

    if (!versionToRestore.version) {
      throw new FileRecordError('Restore version has to be defined');
    }

    const versionToRestoreIndex = new FeedIndex(versionToRestore.version);
    if (feedIndex.equals(versionToRestoreIndex)) {
      throw new FileRecordError(
        `Head Slot cannot be restored. Please select a version lesser than: ${versionToRestore.version}`,
      );
    }

    const cached = this.recordList.find((f) => f.topic === versionToRestore.topic);

    const restoredPath = cached?.path ?? versionToRestore.path;
    const resolvedFork = await this.resolveFileFork(
      cachedDrive,
      restoredPath,
      versionToRestore.topic,
      publisher,
      requestOptions,
    );

    const newVersion = feedIndexNext.toString();
    const restored: FileRecord = {
      ...versionToRestore,
      name: resolvedFork.filename,
      path: restoredPath,
      version: newVersion,
      content: {
        reference: versionToRestore.content.reference,
        historyRef: versionToRestore.content.historyRef,
      },
      timestamp: Date.now(),
    };

    const writtenVersion = await this.persistRecord(restored, requestOptions);
    await this.commitForkVersion(driveIx, resolvedFork, writtenVersion, requestOptions);

    this.cacheRecord(restored);
    this.emitter.emit(FileManagerEvents.FILE_VERSION_RESTORED, {
      restored,
    });
  }

  // --- Folder operations ---

  async createFolder(
    driveId: string | Identifier,
    parentPath: string,
    folderName: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    if (!folderName || folderName.includes('/')) {
      throw new FolderError(`Invalid folder name ${folderName}`);
    }
    const actualPath = joinPath(normalizePath(parentPath), folderName);
    assertNotTrashPath(actualPath);

    const { host: parentHost, folder: parentFolder } = await this.store.resolveHost(
      cachedDrive,
      parentPath,
      publisher,
      requestOptions,
    );

    const existingParentNode = await this.store.getMantarayNode(
      parentHost.topic,
      publisher,
      parentHost.manifestRef,
      requestOptions,
    );
    if (existingParentNode.find(folderName)) {
      throw new FolderError(`Node already exists at "${actualPath}"`);
    }

    const { folder, node: parentNode } = await this.createFolderNode(
      cachedDrive,
      parentHost,
      parentPath,
      folderName,
      publisher,
      redundancyLevel,
      requestOptions,
    );

    const updatedParentManifestRef = await this.store.saveMantarayNode(parentNode, parentHost, requestOptions);

    if (!parentFolder) {
      this.driveList[driveIx].manifestRef = updatedParentManifestRef;
    }

    this.emitter.emit(FileManagerEvents.FOLDER_CREATED, { folderInfo: folder });

    return folder;
  }

  async listFolder(
    driveId: string | Identifier,
    path: string,
    depth: ListDepth = ListDepth.Shallow,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<ListFolderResult> {
    requestOptions?.signal?.throwIfAborted();

    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { cachedDrive } = this.findDriveOrThrow(driveId);
    assertNotTrashPath(path);

    if (maxDepth !== undefined && maxDepth <= 0) {
      throw new FolderError(`Invalid maxDepth: ${maxDepth}`);
    }

    const { host: startHost } = await this.store.resolveHost(cachedDrive, path, publisher, requestOptions);

    return await this.walkFolder(
      cachedDrive,
      startHost,
      normalizePath(path),
      depth,
      maxDepth,
      publisher,
      requestOptions,
    );
  }

  // Per BFS walk: (1) expand current manifest node, (2) load file feeds found, (3) resolve folder feeds into next node. Each phase is concurrency-bounded.
  private async walkFolder(
    cachedDrive: DriveInfo,
    startHost: ManifestHost,
    startBasePath: string,
    depth: ListDepth,
    maxDepth: number | undefined,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<ListFolderResult> {
    const results: NodeEntry[] = [];
    const failed: NodeFailure[] = [];
    let visitedNodes: { host: ManifestHost; basePath: string }[] = [{ host: startHost, basePath: startBasePath }];
    let currentDepth = 0;
    const depthLimit = depth === ListDepth.Deep ? (maxDepth ?? Number.MAX_SAFE_INTEGER) : 1;

    while (visitedNodes.length > 0 && currentDepth < depthLimit) {
      requestOptions?.signal?.throwIfAborted();

      const headers: NodeHeader[] = [];
      const expanding = visitedNodes;
      await awaitAllPromisesBounded(
        expanding.map((item) => async (): Promise<NodeHeader[]> => {
          const mantarayNode = await this.store.getMantarayNode(
            item.host.topic,
            item.host.actPublisher ?? publisher,
            item.host.manifestRef,
            requestOptions,
          );

          return getAllNodeEntries(mantarayNode)
            .map((e) => ({ ...e, path: joinPath(item.basePath, e.path) }))
            .filter((e) => e.path !== TRASH_FOLDER_NAME);
        }),
        this.feedFetchConcurrency,
        (entries) => headers.push(...entries),
        (reason, ix) => {
          if (requestOptions?.signal?.aborted) return;
          const item = expanding[ix];
          const error = errorMessage(reason);
          this.logger.error(`walkFolder: failed to expand manifest at "${item.basePath || ROOT_PATH}": ${error}`);
          failed.push({
            path: item.basePath || ROOT_PATH,
            scope: FailureScope.Subtree,
            error,
            topic: item.host.topic,
          });
        },
      );

      const fileHeaders = headers.filter((e) => e.type === NodeType.File);
      await awaitAllPromisesBounded(
        fileHeaders.map((e) => async (): Promise<FileRecord> => {
          const owner = e.owner ?? this.signerAddress;
          const actPublisher = e.actPublisher ?? publisher;
          const version = e.version ? new FeedIndex(e.version).toBigInt() : undefined;

          const { record } = await this.loadRecord(e.topic, owner, actPublisher, version, requestOptions);
          record.path = e.path;
          record.name = splitPath(e.path).name;
          record.driveId = cachedDrive.id;
          record.status = getRecordStatus(e.path);
          return record;
        }),
        this.feedFetchConcurrency,
        (record) => {
          if (!this.recordList.some((f) => f.topic === record.topic)) this._recordList.push(record);
          results.push(record);
        },
        (reason, ix) => {
          if (requestOptions?.signal?.aborted) return;
          const header = fileHeaders[ix];
          const error = errorMessage(reason);
          this.logger.error(`walkFolder: failed to load file "${header.path}": ${error}`);
          failed.push({
            path: header.path,
            scope: FailureScope.Entry,
            error,
            type: NodeType.File,
            topic: header.topic,
          });
        },
      );

      const folderHeaders = headers.filter((e) => e.type === NodeType.Folder);
      const nextFrontier: { host: ManifestHost; basePath: string }[] = [];
      await awaitAllPromisesBounded(
        folderHeaders.map((e) => async (): Promise<FolderInfo> => {
          const owner = e.owner ?? this.signerAddress;
          // Probe the feed head. A folder is a container and carries no stored version
          const { payload, feedIndex, feedIndexNext } = await getFeedData(
            this.bee,
            new Topic(e.topic),
            owner,
            undefined,
            requestOptions,
          );

          if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
            throw new FolderError(`Folder feed not found for path: ${e.path}`);
          }

          const manifestRef: ActReferences = payload.toJSON() as ActReferences;
          assertActReferences(manifestRef);
          this.store.setNodeNextIndexCache(e.topic, feedIndexNext.toBigInt());

          return {
            type: NodeType.Folder,
            owner,
            topic: e.topic,
            manifestRef,
            batchId: cachedDrive.batchId,
            redundancyLevel: getRlevel(e.rawMetadata, cachedDrive.redundancyLevel),
            actPublisher: e.actPublisher ?? publisher,
            path: e.path,
            driveId: cachedDrive.id,
            status: getRecordStatus(e.path),
          };
        }),
        this.feedFetchConcurrency,
        (folder) => {
          results.push(folder);
          nextFrontier.push({ host: folder, basePath: folder.path });
        },
        (reason, ix) => {
          if (requestOptions?.signal?.aborted) return;
          const header = folderHeaders[ix];
          const error = errorMessage(reason);
          this.logger.error(`walkFolder: failed to resolve folder "${header.path}": ${error}`);
          failed.push({
            path: header.path,
            scope: FailureScope.Subtree,
            error,
            type: NodeType.Folder,
            topic: header.topic,
          });
        },
      );

      // Shallow lists one level: depthLimit is 1, so the loop exits before descending into nextFrontier.
      visitedNodes = nextFrontier;
      currentDepth++;
    }

    requestOptions?.signal?.throwIfAborted();

    return { entries: results, failed };
  }

  // Download an entire folder subtree of a drive: resolves the subtree's records fresh (hydrating
  // via listFolder), then fetches them. path '/' the whole drive.
  async downloadFolder(
    driveId: string | Identifier,
    path: string = ROOT_PATH,
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadFilesResult> {
    requestOptions?.signal?.throwIfAborted();
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { failed: listFailures } = await this.listFolder(driveId, path, ListDepth.Deep, undefined, requestOptions);

    const normalized = normalizePath(path);
    const prefix = normalized ? normalized + '/' : '';
    const driveIdStr = new Identifier(driveId).toString();
    const files = this.recordList.filter(
      (f) => f.driveId === driveIdStr && f.path.startsWith(prefix) && !isTrashPath(f.path),
    );

    const result = await this.downloadFiles(files, options, requestOptions);

    return {
      ...result,
      failed: [
        ...result.failed,
        ...listFailures.map((f) => ({
          path: f.path,
          error:
            f.scope === FailureScope.Subtree
              ? `Could not list contents of "${f.path}": ${f.error}`
              : `Could not list "${f.path}": ${f.error}`,
        })),
      ],
    };
  }

  async move(
    fromPath: string,
    toPath: string,
    sourceDriveId: string | Identifier,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx: sourceDriveIx, cachedDrive: cachedSource } = this.findDriveOrThrow(sourceDriveId);

    if (fromPath === ROOT_PATH) {
      if (!toPath || toPath === ROOT_PATH || toPath.includes('/')) {
        throw new FolderError('Cannot move root folder');
      }

      return await this.renameDrive(sourceDriveIx, cachedSource, toPath, publisher, requestOptions);
    }

    if (!fromPath) {
      throw new FolderError('Cannot move root folder');
    }
    if (!toPath || toPath === ROOT_PATH) {
      throw new FolderError('Invalid destination path');
    }
    assertNotTrashPath(fromPath);
    assertNotTrashPath(toPath);

    if (fromPath === toPath) {
      throw new FolderError('Source and destination paths are identical');
    }

    const { parentPath: srcParentPath, name: srcName } = splitPath(fromPath);
    const { parentPath: tgtParentPath, name: tgtName } = splitPath(toPath);

    const {
      host: srcParentHost,
      folder: srcParentFolder,
      node: sourceNode,
    } = await this.store.resolveHostMantaray(cachedSource, srcParentPath, publisher, requestOptions);

    const sourceFork = sourceNode.find(srcName);
    if (!sourceFork) {
      throw new FolderError(`Path not found: ${fromPath}`);
    }

    const forkMetadata = sourceFork.metadata ?? {};
    const isFile = forkMetadata[MANIFEST_METADATA_NODE_TYPE] === NodeType.File;

    const { host: tgtParentHost, folder: tgtParentFolder } = await this.store.resolveHost(
      cachedSource,
      tgtParentPath,
      publisher,
      requestOptions,
    );

    const sameParent = srcParentHost.topic === tgtParentHost.topic;
    const targetMantaray = sameParent
      ? sourceNode
      : await this.store.getMantarayNode(tgtParentHost.topic, publisher, tgtParentHost.manifestRef, requestOptions);

    const existing = targetMantaray.find(tgtName);
    if (existing) {
      throw new FolderError(`Destination already exists: ${toPath}`);
    }

    let moved: FileRecord | undefined;
    if (isFile) {
      const fileTopic = forkMetadata[MANIFEST_METADATA_NODE_TOPIC];
      if (!fileTopic) {
        throw new FileRecordError(`Fork at ${fromPath} has no file topic — cannot move`);
      }

      moved = this.recordList.find((f) => f.topic === fileTopic);
    }

    if (sameParent) {
      sourceNode.removeFork(srcName);
      sourceNode.addFork(tgtName, sourceFork.targetAddress, forkMetadata);

      const newSrcManifestRef = await this.store.saveMantarayNode(sourceNode, srcParentHost, requestOptions);

      if (!srcParentFolder) {
        this.driveList[sourceDriveIx].manifestRef = newSrcManifestRef;
      }
    } else {
      targetMantaray.addFork(tgtName, sourceFork.targetAddress, forkMetadata);
      const newTgtManifestRef = await this.store.saveMantarayNode(targetMantaray, tgtParentHost, requestOptions);

      if (!tgtParentFolder) {
        this.driveList[sourceDriveIx].manifestRef = newTgtManifestRef;
      }

      sourceNode.removeFork(srcName);
      const newSrcManifestRef = await this.store.saveMantarayNode(sourceNode, srcParentHost, requestOptions);

      if (!srcParentFolder) {
        this.driveList[sourceDriveIx].manifestRef = newSrcManifestRef;
      }
    }

    if (!isFile) {
      this.rewriteRecordPaths(cachedSource.id, fromPath, toPath);
      this.emitter.emit(FileManagerEvents.FOLDER_MOVED, {
        driveId: cachedSource.id,
        fromPath,
        toPath,
        folderInfo: folderInfoFromMetadata(forkMetadata, cachedSource, toPath, {
          owner: this.signerAddress,
          actPublisher: publisher,
        }),
      });

      return;
    }

    if (moved) {
      moved.path = toPath;
      moved.name = tgtName;
      moved.status = getRecordStatus(toPath);
    }

    this.emitter.emit(FileManagerEvents.FILE_MOVED, {
      driveId: cachedSource.id,
      fromPath,
      toPath,
      record: moved,
    });
  }

  async forget(driveId: string | Identifier, path: string, requestOptions?: BeeRequestOptions): Promise<void> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    if (!path || path === ROOT_PATH) {
      throw new FolderError('Cannot forget drive root');
    }
    if (normalizePath(path) === TRASH_FOLDER_NAME) {
      throw new FolderError(`Cannot forget "${TRASH_FOLDER_NAME}" — use emptyTrash`);
    }

    const { parentPath, name } = splitPath(path);

    const {
      host: parentHost,
      folder: parentFolder,
      node: parentNode,
    } = await this.store.resolveHostMantaray(cachedDrive, parentPath, publisher, requestOptions);

    const fork = parentNode.find(name);
    if (!fork) {
      throw new FileRecordError(`Path not found: ${path}`);
    }

    const meta = fork.metadata ?? {};
    const nodeType = meta[MANIFEST_METADATA_NODE_TYPE] as NodeType | undefined;
    const nodeTopic = meta[MANIFEST_METADATA_NODE_TOPIC];

    if (!nodeType || !nodeTopic) {
      this.logger.warn(`forget: fork "${path}" missing node metadata - removing it with best-effort cleanup`);
    }

    parentNode.removeFork(name);
    const newManifestRef = await this.store.saveMantarayNode(parentNode, parentHost, requestOptions);

    if (!parentFolder) {
      this.driveList[driveIx].manifestRef = newManifestRef;
    }

    if (nodeTopic) {
      this.store.evict(nodeTopic);
    }

    if (nodeType === NodeType.Folder) {
      const prefix = path.endsWith('/') ? path : path + '/';
      for (let i = this.recordList.length - 1; i >= 0; --i) {
        const f = this.recordList[i];
        if (f.driveId === cachedDrive.id && f.path.startsWith(prefix)) {
          this._recordList.splice(i, 1);
        }
      }

      this.emitter.emit(FileManagerEvents.FOLDER_FORGOTTEN, {
        driveId: cachedDrive.id,
        path,
        folderInfo: folderInfoFromMetadata(meta, cachedDrive, path, {
          owner: this.signerAddress,
          actPublisher: publisher,
        }),
      });

      return;
    }

    const fiIndex = this.recordList.findIndex((f) => f.driveId === cachedDrive.id && f.path === path);

    const forgotten = fiIndex !== -1 ? this.recordList[fiIndex] : undefined;
    if (fiIndex !== -1) {
      this._recordList.splice(fiIndex, 1);
    }
    this.emitter.emit(FileManagerEvents.FILE_FORGOTTEN, { driveId: cachedDrive.id, path, record: forgotten });
  }

  // --- Trash operations ---

  async trash(driveId: string | Identifier, path: string, requestOptions?: BeeRequestOptions): Promise<void> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    if (!path || path === ROOT_PATH) {
      throw new FolderError('Cannot trash drive root');
    }
    assertNotTrashPath(path);

    const sourcePath = normalizePath(path);
    const source = await this.resolveNodeFork(cachedDrive, sourcePath, publisher, requestOptions);
    const topic = source.metadata[MANIFEST_METADATA_NODE_TOPIC];
    const type = source.metadata[MANIFEST_METADATA_NODE_TYPE] as NodeType | undefined;
    if (!topic || !type) {
      throw new FileRecordError(`Fork at ${sourcePath} is missing node metadata — cannot trash`);
    }

    const trash = await this.ensureTrashHost(driveIx, cachedDrive, publisher, requestOptions);
    const trashedPath = trashPathOf(topic);

    const trashedMetadata = { ...source.metadata, [MANIFEST_METADATA_TRASHED_FROM]: sourcePath };

    source.node.removeFork(source.filename);
    trash.node.addFork(topic, source.targetAddress, trashedMetadata);

    await this.store.saveMantarayNode(trash.node, trash.host, requestOptions);
    const newSourceRef = await this.store.saveMantarayNode(source.node, source.host, requestOptions);
    if (!source.folder) {
      this.driveList[driveIx].manifestRef = newSourceRef;
    }

    if (type === NodeType.Folder) {
      this.rewriteRecordPaths(cachedDrive.id, sourcePath, trashedPath);
      this.emitter.emit(FileManagerEvents.FOLDER_TRASHED, {
        driveId: cachedDrive.id,
        path: sourcePath,
        trashedPath,
        folderInfo: folderInfoFromMetadata(trashedMetadata, cachedDrive, trashedPath, {
          owner: this.signerAddress,
          actPublisher: publisher,
        }),
      });

      return;
    }

    const record = this.recordList.find((f) => f.topic === topic);
    if (record) {
      record.path = trashedPath;
      record.trashedFrom = sourcePath;
      record.status = NodeStatus.Trashed;
    }

    this.emitter.emit(FileManagerEvents.FILE_TRASHED, {
      driveId: cachedDrive.id,
      path: sourcePath,
      trashedPath,
      record,
    });
  }

  async recover(
    driveId: string | Identifier,
    trashedPath: string,
    toPath?: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<string> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    const segments = pathSegments(trashedPath);
    if (segments.length !== 2 || segments[0] !== TRASH_FOLDER_NAME) {
      throw new FileRecordError(`Not a trashed node path: "${trashedPath}" — expected "${TRASH_FOLDER_NAME}/<topic>"`);
    }
    const topic = segments[1];
    const normalizedTrashedPath = trashPathOf(topic);

    const trash = await this.resolveTrashHost(cachedDrive, publisher, requestOptions);
    const trashedFork = trash?.node.find(topic);
    if (!trash || !trashedFork) {
      throw new FileRecordError(`Not trashed, cannot recover: ${trashedPath}`);
    }

    const metadata = { ...(trashedFork.metadata ?? {}) };
    const trashedFrom = metadata[MANIFEST_METADATA_TRASHED_FROM];
    const destination = toPath ?? trashedFrom;
    if (!destination) {
      throw new FileRecordError(`No recorded origin for ${trashedPath} — pass an explicit destination`);
    }
    assertValidNodePath(destination);
    assertNotTrashPath(destination);
    delete metadata[MANIFEST_METADATA_TRASHED_FROM];

    const { parentPath, name } = splitPath(destination);
    const {
      host: destHost,
      folder: destFolder,
      node: destNode,
    } = await this.store.resolveHostMantaray(cachedDrive, parentPath, publisher, requestOptions);

    if (destNode.find(name)) {
      throw new DriveError(`Destination already exists: ${destination}`);
    }

    destNode.addFork(name, trashedFork.targetAddress, metadata);
    const newDestRef = await this.store.saveMantarayNode(destNode, destHost, requestOptions);

    if (!destFolder) {
      this.driveList[driveIx].manifestRef = newDestRef;
    }

    trash.node.removeFork(topic);
    await this.store.saveMantarayNode(trash.node, trash.host, requestOptions);

    const restoredPath = normalizePath(destination);
    if (metadata[MANIFEST_METADATA_NODE_TYPE] === NodeType.Folder) {
      this.rewriteRecordPaths(cachedDrive.id, normalizedTrashedPath, restoredPath);
      this.emitter.emit(FileManagerEvents.FOLDER_RECOVERED, {
        driveId: cachedDrive.id,
        trashedPath: normalizedTrashedPath,
        restoredPath,
        folderInfo: folderInfoFromMetadata(metadata, cachedDrive, restoredPath, {
          owner: this.signerAddress,
          actPublisher: publisher,
        }),
      });

      return restoredPath;
    }

    const record = this.recordList.find((f) => f.topic === topic);
    if (record) {
      record.path = restoredPath;
      record.name = splitPath(restoredPath).name;
      delete record.trashedFrom;
      record.status = NodeStatus.Active;
    }

    this.emitter.emit(FileManagerEvents.FILE_RECOVERED, {
      driveId: cachedDrive.id,
      trashedPath: normalizedTrashedPath,
      restoredPath,
      record,
    });

    return restoredPath;
  }

  async listTrash(
    driveId: string | Identifier,
    depth: ListDepth = ListDepth.Shallow,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<ListFolderResult> {
    requestOptions?.signal?.throwIfAborted();

    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { cachedDrive } = this.findDriveOrThrow(driveId);

    if (maxDepth !== undefined && maxDepth <= 0) {
      throw new FolderError(`Invalid maxDepth: ${maxDepth}`);
    }

    const trash = await this.resolveTrashHost(cachedDrive, publisher, requestOptions);
    if (!trash) {
      return { entries: [], failed: [] };
    }

    const { entries, failed } = await this.walkFolder(
      cachedDrive,
      trash.host,
      TRASH_FOLDER_NAME,
      depth,
      maxDepth,
      publisher,
      requestOptions,
    );

    const originByTopic = new Map<string, string>();
    for (const header of getAllNodeEntries(trash.node)) {
      const from = header.rawMetadata[MANIFEST_METADATA_TRASHED_FROM];
      if (from) {
        originByTopic.set(header.topic, from);
      }
    }

    for (const entry of entries) {
      const segments = pathSegments(entry.path);
      const origin = originByTopic.get(segments[1]);
      if (origin) {
        entry.trashedFrom = segments.length > 2 ? joinPath(origin, segments.slice(2).join('/')) : origin;
      }
    }

    return { entries, failed };
  }

  async emptyTrash(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<number> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { cachedDrive } = this.findDriveOrThrow(driveId);

    const trash = await this.resolveTrashHost(cachedDrive, publisher, requestOptions);
    if (!trash) {
      return 0;
    }

    const topics = getAllNodeEntries(trash.node)
      .filter((e) => pathSegments(e.path).length === 1)
      .map((e) => e.topic);

    if (topics.length === 0) {
      return 0;
    }

    for (const topic of topics) {
      trash.node.removeFork(topic);
    }
    await this.store.saveMantarayNode(trash.node, trash.host, requestOptions);

    const trashPrefix = TRASH_FOLDER_NAME + '/';
    for (let i = this.recordList.length - 1; i >= 0; --i) {
      const record = this.recordList[i];
      if (record.driveId === cachedDrive.id && record.path.startsWith(trashPrefix)) {
        this._recordList.splice(i, 1);
      }
    }
    for (const topic of topics) {
      this.store.evict(topic);
    }

    this.emitter.emit(FileManagerEvents.TRASH_EMPTIED, { driveId: cachedDrive.id, count: topics.length });

    return topics.length;
  }

  // --- Private helpers ---

  private async initPublisher(requestOptions?: BeeRequestOptions): Promise<void> {
    this.publisher = (await this.bee.getNodeAddresses(requestOptions)).publicKey;
  }

  private resetState(): void {
    this._isInitialized = false;
    this.publisher = undefined;
    this.stateFeedTopic = undefined;
    this._adminStamp = undefined;
    this.adminRedundancyLevel = RedundancyLevel.OFF;
    this._driveList.length = 0;
    this._recordList.length = 0;
    this.store.clear();
  }

  private discardCachedUploads(records: FileRecord[], mutatedTopics: string[]): void {
    for (const record of records) {
      this.store.evict(record.topic);
    }

    for (const topic of mutatedTopics) {
      this.store.evict(topic);
    }
  }

  private async tryToFetchAdminState(requestOptions?: BeeRequestOptions): Promise<boolean> {
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const { payload, feedIndex } = await getFeedData(
      this.bee,
      FILEMANAGER_STATE_TOPIC,
      this.signerAddress,
      undefined,
      requestOptions,
    );

    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      this.logger.debug('State not found.');
      return false;
    }

    let stateTopicInfo: ActReferences;
    try {
      stateTopicInfo = payload.toJSON() as ActReferences;
      assertActReferences(stateTopicInfo);
    } catch (err: unknown) {
      this.errorHandler.handleError(err, 'Failed to fetch admin state');
      this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
      return false;
    }

    const stateTopicRef = new Reference(stateTopicInfo.reference);
    const topicHistoryRef = new Reference(stateTopicInfo.historyRef);

    let topicBytes: Bytes;
    try {
      topicBytes = await this.bee.downloadData(
        stateTopicRef,
        {
          actHistoryAddress: topicHistoryRef,
          actPublisher: this.publisher,
        },
        requestOptions,
      );
    } catch (err: unknown) {
      this.errorHandler.handleError(err, 'Failed to decrypt admin state');
      this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
      return false;
    }

    this.stateFeedTopic = new Topic(topicBytes.toUint8Array());
    this.logger.debug('Drive list feed successfully fetched');
    this.emitter.emit(FileManagerEvents.STATE_INVALID, false);

    return true;
  }

  private async registerDrive(
    params: { name: string; batchId: string; isAdmin: boolean; redundancyLevel: RedundancyLevel; publisher: string },
    requestOptions?: BeeRequestOptions,
  ): Promise<DriveInfo> {
    const { name, batchId, isAdmin, redundancyLevel, publisher } = params;

    this.driveList.forEach((d) => {
      if (d.name === name || d.batchId === batchId) {
        throw new DriveError(`Drive with name "${name}" or batchId "${batchId.slice(0, 6)}" already exists`);
      }
    });

    const newDrive: DriveInfo = {
      type: NodeType.Drive,
      id: new Identifier(generateRandomBytes(Identifier.LENGTH)).toString(),
      name,
      batchId,
      owner: this.signerAddress,
      redundancyLevel,
      topic: new Topic(generateRandomBytes(Topic.LENGTH)).toString(),
      isAdmin,
      actPublisher: publisher,
    };

    const driveNode = new MantarayNode();
    this.store.setNodeNextIndexCache(newDrive.topic, 0n);
    newDrive.manifestRef = await this.store.saveMantarayNode(driveNode, newDrive, requestOptions);
    this.store.setManifestCache(newDrive.topic, driveNode);

    const adminHost = this.adminHost(publisher);
    const adminMantaray = this.store.getManifestCache(adminHost.topic);
    if (!adminMantaray) {
      throw new DriveError('Admin manifest not loaded — initialize first.');
    }
    adminMantaray.addFork(getDriveForkPath(newDrive.id), new Reference(newDrive.topic), driveForkMetadata(newDrive));
    await this.store.saveMantarayNode(adminMantaray, adminHost, requestOptions);

    this._driveList.push(newDrive);
    this.emitter.emit(FileManagerEvents.DRIVE_CREATED, { driveInfo: newDrive });

    return newDrive;
  }

  private async renameDrive(
    driveIx: number,
    drive: DriveInfo,
    newName: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    if (drive.isAdmin) {
      throw new DriveError('Cannot rename the admin drive');
    }
    if (drive.name === newName) {
      throw new DriveError('Source and destination names are identical');
    }
    if (this.driveList.some((d) => d.name === newName)) {
      throw new DriveError(`Drive with name "${newName}" already exists`);
    }

    const adminHost = this.adminHost(publisher);
    const adminMantaray = this.store.getManifestCache(adminHost.topic);
    if (!adminMantaray) {
      throw new DriveError('Admin manifest not loaded — initialize first.');
    }

    const renamed: DriveInfo = { ...drive, name: newName };
    const forkPath = getDriveForkPath(drive.id);

    adminMantaray.removeFork(forkPath);
    adminMantaray.addFork(forkPath, new Reference(drive.topic), driveForkMetadata(renamed));
    await this.store.saveMantarayNode(adminMantaray, adminHost, requestOptions);

    this.driveList[driveIx].name = newName;
    this.emitter.emit(FileManagerEvents.DRIVE_RENAMED, { driveInfo: this.driveList[driveIx] });
  }

  private async establishAdminState(
    batchId: string,
    redundancyLevel: RedundancyLevel,
    reset?: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    const { feedIndexNext } = await getFeedData(
      this.bee,
      FILEMANAGER_STATE_TOPIC,
      this.signerAddress,
      undefined,
      requestOptions,
    );
    const isStateExisting = !feedIndexNext.equals(FEED_INDEX_ZERO);
    if (!reset && isStateExisting) {
      throw new DriveError('Admin state already exists. Pass reset=true to overwrite.');
    }

    const randomTopic = generateRandomBytes(Topic.LENGTH);
    const newStateFeedTopic = new Topic(randomTopic);
    const topicUploadRes = await this.bee.uploadData(
      batchId,
      newStateFeedTopic.toUint8Array(),
      { act: true, redundancyLevel },
      requestOptions,
    );
    const historyRef = topicUploadRes.historyAddress.getOrThrow().toString();
    const topicState: ActReferences = {
      reference: topicUploadRes.reference.toString(),
      historyRef: historyRef,
    };

    const statefw = this.bee.makeFeedWriter(FILEMANAGER_STATE_TOPIC.toUint8Array(), this.signer, requestOptions);
    await statefw.uploadPayload(batchId, JSON.stringify(topicState), { index: feedIndexNext });

    if (reset) {
      this._recordList.length = 0;
      this._driveList.length = 0;
      this.store.clear();
    }

    this.stateFeedTopic = newStateFeedTopic;
    this.adminRedundancyLevel = redundancyLevel;
    this.store.setManifestCache(newStateFeedTopic.toString(), new MantarayNode());
    this.store.setNodeNextIndexCache(newStateFeedTopic.toString(), 0n);
  }

  private async initDriveList(requestOptions?: BeeRequestOptions): Promise<void> {
    if (!this.stateFeedTopic) {
      throw new DriveError('State feed topic not set');
    }
    if (this.store.getNodeRef(this.stateFeedTopic.toString())) {
      throw new DriveError('Admin manifest already set');
    }
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const { payload, feedIndex, feedIndexNext } = await getFeedData(
      this.bee,
      this.stateFeedTopic,
      this.signerAddress,
      undefined,
      requestOptions,
    );

    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      this.logger.debug('Admin manifest feed empty — no drives to load');
      return;
    }

    const adminManifestRef: ActReferences = payload.toJSON() as ActReferences;
    assertActReferences(adminManifestRef);

    const adminMantaray = await this.store.getMantarayNode(
      this.stateFeedTopic.toString(),
      this.publisher.toCompressedHex(),
      adminManifestRef,
      requestOptions,
    );

    const entries = getAllNodeEntries(adminMantaray).filter((e) => e.type === NodeType.Drive);

    this.store.setNodeNextIndexCache(this.stateFeedTopic.toString(), feedIndexNext.toBigInt());

    const forks = entries.map((entry) => ({
      entry,
      id: entry.rawMetadata[MANIFEST_METADATA_DRIVE_ID] ?? 'unknown',
      name: entry.rawMetadata[MANIFEST_METADATA_DRIVE_NAME] ?? 'unknown',
    }));

    await settlePromises(
      forks.map(async ({ entry }) => {
        const driveInfo = assertDriveInfoFromMetadata(entry.rawMetadata);

        // Probe the drive feed head. A drive is a container and carries no stored version
        const {
          payload: drivePayload,
          feedIndex: driveFeedIndex,
          feedIndexNext: driveFeedIndexNext,
        } = await getFeedData(this.bee, new Topic(driveInfo.topic), this.signerAddress, undefined, requestOptions);

        if (driveFeedIndex.equals(FeedIndex.MINUS_ONE)) {
          throw new DriveError('Drive has no manifest feed — corrupt or incomplete');
        }

        driveInfo.manifestRef = drivePayload.toJSON() as ActReferences;
        assertActReferences(driveInfo.manifestRef);

        if (driveInfo.isAdmin) {
          await this.fetchAndSetAdminStamp(driveInfo.batchId, requestOptions);
          try {
            verifyStampUsability(this.adminStamp, driveInfo.batchId, false);
          } catch (err: unknown) {
            this.errorHandler.handleError(err, 'Amdin stamp verification failed');
            this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
            throw err;
          }

          this.adminRedundancyLevel = driveInfo.redundancyLevel;
        }

        this.store.setNodeNextIndexCache(driveInfo.topic, driveFeedIndexNext.toBigInt());

        return driveInfo;
      }),
      (driveInfo) => {
        if (driveInfo) {
          this._driveList.push(driveInfo);
        }
      },
      (reason, ix) => {
        const { id, name } = forks[ix];
        const error = errorMessage(reason);
        this.logger.error(`initDriveList: failed to load drive "${name}" (${id.slice(0, 6)}): ${error}`);
        this.emitter.emit(FileManagerEvents.DRIVE_UNRESOLVED, { id, name, error } as UnresolvedDrive);
      },
    );
  }

  private async fetchAndSetAdminStamp(batchId: string | BatchId, requestOptions?: BeeRequestOptions): Promise<void> {
    const adminStamp = await fetchStamp(this.bee, batchId, requestOptions);
    const logText = `Admin stamp with batchId: ${batchId.toString().slice(0, 6)}...`;

    if (!adminStamp) {
      this._adminStamp = undefined;
      this.logger.warn(`${logText} not found.`);
      return;
    }
    if (adminStamp.usable) {
      this.logger.debug(`${logText} found and set.`);
    } else {
      this.logger.warn(`${logText} is unusable.`);
    }

    this._adminStamp = adminStamp;
  }

  private findDriveOrThrow(driveId: string | Identifier): { driveIx: number; cachedDrive: DriveInfo } {
    let driveIdStr: string;
    try {
      driveIdStr = new Identifier(driveId).toString();
    } catch (err: unknown) {
      this.errorHandler.handleError(err, `Invalid driveId: ${driveId}`);
      throw new DriveError(`Invalid driveId: ${driveId}`);
    }
    const driveIx = this.driveList.findIndex((d) => d.id === driveIdStr);

    if (driveIx === -1) {
      throw new DriveError(`Drive with id ${driveIdStr.slice(0, 6)} not found`);
    }

    const cachedDrive = this.driveList[driveIx];

    return { driveIx, cachedDrive };
  }

  private async pruneDriveMetadata(
    driveInfo: DriveInfo,
    driveIndex: number,
    stateTopic: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    if (!this.adminStamp) {
      throw new DriveError('Admin stamp not found');
    }

    const adminMantaray = this.store.getManifestCache(stateTopic);
    if (!adminMantaray) {
      throw new DriveError('Admin manifest not loaded — initialize first.');
    }

    const adminHost = this.adminHost(publisher);

    adminMantaray.removeFork(getDriveForkPath(driveInfo.id));
    await this.store.saveMantarayNode(adminMantaray, adminHost, requestOptions);

    this._driveList.splice(driveIndex, 1);
    this.store.evict(driveInfo.topic);

    for (let i = this.recordList.length - 1; i >= 0; --i) {
      if (this.recordList[i].driveId === driveInfo.id) {
        this._recordList.splice(i, 1);
      }
    }
  }

  private async createFolderNode(
    driveInfo: DriveInfo,
    parentHost: ManifestHost,
    parentPath: string,
    folderName: string,
    publisher: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<{ folder: FolderInfo; node: MantarayNode }> {
    const effectiveRedundancy = redundancyLevel ?? parentHost.redundancyLevel;

    const newFolderTopic = new Topic(generateRandomBytes(Topic.LENGTH)).toString();
    const fi: FolderInfo = {
      type: NodeType.Folder,
      owner: this.signerAddress,
      topic: newFolderTopic,
      batchId: driveInfo.batchId,
      redundancyLevel: effectiveRedundancy,
      path: parentPath === ROOT_PATH || !parentPath ? folderName : `${parentPath}/${folderName}`,
      driveId: driveInfo.id,
      actPublisher: publisher,
      status: NodeStatus.Active,
    };

    const folderNode = new MantarayNode();
    this.store.setNodeNextIndexCache(newFolderTopic, 0n);
    fi.manifestRef = await this.store.saveMantarayNode(folderNode, fi, requestOptions);
    this.store.setManifestCache(newFolderTopic, folderNode);

    const parentNode = await this.store.getMantarayNode(
      parentHost.topic,
      publisher,
      parentHost.manifestRef,
      requestOptions,
    );
    parentNode.addFork(folderName, new Reference(fi.topic), folderForkMetadata(fi));

    return { folder: fi, node: parentNode };
  }

  private async resolveNodeFork(
    drive: DriveInfo,
    absolutePath: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<ResolvedFileFork> {
    const { parentPath, name: filename } = splitPath(absolutePath);

    const {
      host: parentHost,
      folder: parentFolder,
      node: parentNode,
    } = await this.store.resolveHostMantaray(drive, parentPath, publisher, requestOptions);
    const fork = parentNode.find(filename);
    if (!fork) {
      throw new FolderError(`Path not found: ${absolutePath}`);
    }

    return {
      host: parentHost,
      folder: parentFolder,
      node: parentNode,
      filename,
      targetAddress: fork.targetAddress,
      metadata: { ...(fork.metadata ?? {}) },
    };
  }

  private async resolveFileFork(
    drive: DriveInfo,
    absolutePath: string,
    expectedTopic: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<ResolvedFileFork> {
    const fork = await this.resolveNodeFork(drive, absolutePath, publisher, requestOptions);

    if (fork.metadata[MANIFEST_METADATA_NODE_TOPIC] !== expectedTopic) {
      throw new FileRecordError(
        `Fork at ${absolutePath} belongs to a different node than ${expectedTopic.slice(0, 6)} — refusing to write its version`,
      );
    }

    return fork;
  }

  private async resolveTrashHost(
    drive: DriveInfo,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<{ host: ManifestHost; node: MantarayNode } | null> {
    const rootNode = await this.store.getMantarayNode(drive.topic, publisher, drive.manifestRef, requestOptions);
    if (!rootNode.find(TRASH_FOLDER_NAME)) {
      return null;
    }

    const { host, node } = await this.store.resolveHostMantaray(drive, TRASH_FOLDER_NAME, publisher, requestOptions);

    return { host, node };
  }

  private async ensureTrashHost(
    driveIx: number,
    drive: DriveInfo,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<{ host: ManifestHost; node: MantarayNode }> {
    const existing = await this.resolveTrashHost(drive, publisher, requestOptions);
    if (existing) {
      return existing;
    }

    const { host: rootHost } = await this.store.resolveHost(drive, ROOT_PATH, publisher, requestOptions);
    const { folder, node: rootNode } = await this.createFolderNode(
      drive,
      rootHost,
      ROOT_PATH,
      TRASH_FOLDER_NAME,
      publisher,
      undefined,
      requestOptions,
    );

    this.driveList[driveIx].manifestRef = await this.store.saveMantarayNode(rootNode, rootHost, requestOptions);
    const node = await this.store.getMantarayNode(folder.topic, publisher, folder.manifestRef, requestOptions);

    return { host: folder, node };
  }

  private rewriteRecordPaths(driveId: string, fromPath: string, toPath: string): void {
    const fromPrefix = normalizePath(fromPath) + '/';
    const toPrefix = normalizePath(toPath) + '/';

    for (const record of this.recordList) {
      if (record.driveId === driveId && record.path.startsWith(fromPrefix)) {
        record.path = toPrefix + record.path.substring(fromPrefix.length);
        record.status = getRecordStatus(record.path);
      }
    }
  }

  // Re-stamps a resolved fork's cached version so it tracks the file's new feed head
  private async commitForkVersion(
    driveIx: number,
    fork: ResolvedFileFork,
    newVersion: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    const forkMetadata = { ...fork.metadata, [MANIFEST_METADATA_NODE_VERSION]: newVersion };
    fork.node.removeFork(fork.filename);
    fork.node.addFork(fork.filename, fork.targetAddress, forkMetadata);

    const newManifestRef = await this.store.saveMantarayNode(fork.node, fork.host, requestOptions);
    if (!fork.folder) {
      this.driveList[driveIx].manifestRef = newManifestRef;
    }
  }

  private async loadRecord(
    topic: string,
    owner: string,
    actPublisher: string,
    version?: bigint,
    requestOptions?: BeeRequestOptions,
  ): Promise<{ record: FileRecord; fromCache: boolean }> {
    const cachedIx = this.recordList.findIndex((f) => f.topic === topic);
    const cached = cachedIx === -1 ? undefined : this.recordList[cachedIx];

    if (cached && (version === undefined || cached.version === FeedIndex.fromBigInt(version).toString())) {
      return { record: cached, fromCache: true };
    }

    const feedData = await getFeedData(this.bee, new Topic(topic), owner, version, requestOptions);
    if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileRecordError(`File record not found for topic: ${topic.slice(0, 6)}`);
    }

    const loaded = await this.store.getRecord(topic, actPublisher, feedData, { isHeadRead: true }, requestOptions);
    if (cachedIx === -1) {
      this._recordList.push(loaded);
    } else {
      this._recordList[cachedIx] = loaded;
    }

    return { record: loaded, fromCache: false };
  }

  private async persistRecord(fr: FileRecord, requestOptions?: BeeRequestOptions): Promise<string> {
    let index: bigint;
    try {
      ({ index } = await this.store.saveRecord(fr, requestOptions));
    } catch (err: unknown) {
      this.errorHandler.handleError(err, `Failed to save record: ${fr.path}`);
      throw new FileRecordError(`Failed to save record`, err);
    }

    fr.version = FeedIndex.fromBigInt(index).toString();

    return fr.version;
  }

  private cacheRecord(fr: FileRecord): void {
    const existingIx = this.recordList.findIndex((f) => f.topic === fr.topic);
    if (existingIx !== -1) {
      this._recordList[existingIx] = fr;
    } else {
      this._recordList.push(fr);
    }
  }

  private adminHost(publisher: string): ManifestHost {
    const { stateFeedTopic } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    if (!this.adminStamp) {
      throw new DriveError('Admin stamp not found');
    }

    return {
      owner: this.signerAddress,
      topic: stateFeedTopic,
      batchId: this.adminStamp.batchID.toString(),
      redundancyLevel: this.adminRedundancyLevel,
      actPublisher: publisher,
    };
  }
}
