import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  DownloadOptions,
  FeedIndex,
  FileUploadOptions,
  Identifier,
  MantarayNode,
  PostageBatch,
  PrivateKey,
  PublicKey,
  RedundancyLevel,
  RedundantUploadOptions,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { DownloadFilesResult, DownloadResource, DownloadResult } from './types/download';
import { FileManager, FileManagerConfig } from './types/fileManager';
import {
  DriveInfo,
  FileRecord,
  FolderInfo,
  ListDepth,
  ManifestHost,
  NodeEntry,
  NodeHeader,
  NodeStatus,
  NodeType,
  TrashEntry,
} from './types/info';
import { UpdateItem, UploadFilesResult, UploadItem } from './types/upload';
import { ActReferences, FailedResult } from './types/utils';
import { assertActReferences, assertDriveInfoFromMetadata, assertReady } from './utils/asserts';
import {
  fetchStamp,
  getFeedData,
  getTopicAndVersion,
  verifyStampUsability,
  verifySupportedBeeVersions,
} from './utils/bee';
import { awaitAllPromisesBounded, getRecordStatus, joinPath, settlePromises } from './utils/common';
import {
  ADMIN_STAMP_LABEL,
  FEED_INDEX_ZERO,
  FILEMANAGER_STATE_TOPIC,
  MANIFEST_METADATA_FILE_TOPIC,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_NODE_VERSION,
  MAX_CONCURRENT_FEED_FETCHES,
  MAX_CONCURRENT_UPLOADS,
  ROOT_PATH,
} from './utils/constants';
import { generateRandomBytes } from './utils/crypto';
import { DriveError, ErrorHandler, FileError, FileRecordError, SignerError } from './utils/errors';
import { FileManagerEvents } from './utils/events';
import { Logger } from './utils/logger';
import {
  driveForkMetadata,
  fileForkMetadata,
  folderForkMetadata,
  getAllNodeEntries,
  getDriveForkPath,
  getRlevel,
} from './utils/mantaray';
import { assertValidRelativePath, normalizePath, pathSegments, splitPath } from './utils/path';
import { processDownload } from './download';
import { EventEmitter, EventEmitterBase } from './eventEmitter';
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
      this.emitter.emit(FileManagerEvents.INITIALIZED, true);
    } catch (err: unknown) {
      this.errorHandler.handleError(err, 'Failed to initialize FileManager');
      this._isInitialized = false;
      this.emitter.emit(FileManagerEvents.INITIALIZED, false);
    } finally {
      this.isInitializing = false;
    }
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

    this.logger.debug('Creating admin drive with name: ', ADMIN_STAMP_LABEL);
    await this.fetchAndSetAdminStamp(batchIdStr, requestOptions);
    verifyStampUsability(this.adminStamp, batchIdStr);

    await this.establishAdminState(batchIdStr, level, reset, requestOptions);

    return this.registerDrive(
      { name: ADMIN_STAMP_LABEL, batchId: batchIdStr, isAdmin: true, redundancyLevel: level, publisher },
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

    // Resolve the parent folder up front so the new fork inherits the parent's redundancy level.
    const { parentPath, name: filename } = splitPath(item.path);

    const { host: targetHost, folder: parentFolder } = await this.store.resolveHost(
      cachedDrive,
      parentPath,
      publisher,
      requestOptions,
    );

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

    const mantarayNode = await this.store.getMantarayNode(
      targetHost.topic,
      publisher,
      targetHost.manifestRef,
      requestOptions,
    );

    mantarayNode.addFork(filename, new Reference(record.topic), fileForkMetadata(record));

    const newManifestRef = await this.store.saveMantarayNode(mantarayNode, targetHost, requestOptions);

    if (!parentFolder) {
      this.driveList[driveIx].manifestRef = newManifestRef;
    }

    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { record });

    return record;
  }

  async uploadFiles(
    driveId: string | Identifier,
    items: UploadItem[],
    destinationPath: string,
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

    for (const item of items) {
      const relSegments = pathSegments(item.path);
      const filename = relSegments[relSegments.length - 1];
      const folderSegments = relSegments.slice(0, -1);
      const fullPath = [...destSegments, ...relSegments].join('/');
      const parentPath = [...destSegments, ...folderSegments].join('/');

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
      dirtyHosts.set(parentHost.topic, parentHost);

      this.emitter.emit(FileManagerEvents.FOLDER_CREATED, { folderInfo });
    }

    const succeeded: FileRecord[] = [];
    const failed: FailedResult[] = [];
    const owner = this.signerAddress;

    await awaitAllPromisesBounded(
      plannedFiles.map((planned) => async (): Promise<FileRecord> => {
        // Between-files abort is benign — completed files are valid standalone nodes.
        requestOptions?.signal?.throwIfAborted();

        const parentHost = hostMap.get(planned.parentPath);
        if (!parentHost) {
          throw new FileRecordError(`Internal error: parent folder not resolved for path: ${planned.fullPath}`);
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

        const parentMantaray = await this.store.getMantarayNode(
          parentHost.topic,
          publisher,
          parentHost.manifestRef,
          requestOptions,
        );
        parentMantaray.addFork(planned.filename, new Reference(record.topic), fileForkMetadata(record));
        dirtyHosts.set(parentHost.topic, parentHost);

        this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { record });

        return record;
      }),
      this.uploadConcurrency,
      (record) => succeeded.push(record),
      (reason, ix) => {
        if (requestOptions?.signal?.aborted) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        failed.push({ path: plannedFiles[ix].fullPath, error: (reason as any)?.message || String(reason) });
      },
    );

    // Batched saves. Run-to-completion, interrupting them mid-flight would tear state
    requestOptions?.signal?.throwIfAborted();

    for (const host of dirtyHosts.values()) {
      const mantarayNode = await this.store.getMantarayNode(host.topic, publisher, host.manifestRef, requestOptions);
      const updatedNodeRef = await this.store.saveMantarayNode(mantarayNode, host, requestOptions);

      if (host.topic === cachedDrive.topic) {
        this.driveList[driveIx].manifestRef = updatedNodeRef;
      }
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
    cached.status = getRecordStatus(cachedDrive, record.topic);

    const { topic, version } = await getTopicAndVersion(this.bee, owner, cached.version, record.topic, requestOptions);

    const { name: filename } = splitPath(cached.path);

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

    await this.persistRecord(fr, requestOptions);
    await this.syncForkVersion(cachedDrive, driveIx, cached.path, version, publisher, requestOptions);

    fr.path = cached.path;

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

    const versionRecord = await this.store.getRecord(topic.toString(), fr.actPublisher, feedData, requestOptions);
    versionRecord.driveId = fr.driveId;

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

    const newVersion = feedIndexNext.toString();
    const restored: FileRecord = {
      ...versionToRestore,
      path: cached?.path ?? versionToRestore.path,
      version: newVersion,
      content: {
        reference: versionToRestore.content.reference,
        historyRef: versionToRestore.content.historyRef,
      },
      timestamp: Date.now(),
    };

    await this.persistRecord(restored, requestOptions);
    await this.syncForkVersion(cachedDrive, driveIx, restored.path, newVersion, publisher, requestOptions);

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
      throw new DriveError(`Invalid folder name ${folderName}`);
    }

    const { host: parentHost, folder: parentFolder } = await this.store.resolveHost(
      cachedDrive,
      parentPath,
      publisher,
      requestOptions,
    );

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

  // Per BFS walk: (1) expand current manifest node, (2) load file feeds found, (3) resolve folder feeds into next node. Each phase is concurrency-bounded.
  async listFolder(
    driveId: string | Identifier,
    path: string,
    depth: ListDepth = ListDepth.Shallow,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<NodeEntry[]> {
    requestOptions?.signal?.throwIfAborted();

    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { cachedDrive } = this.findDriveOrThrow(driveId);

    const { host: startHost } = await this.store.resolveHost(cachedDrive, path, publisher, requestOptions);
    const startBasePath = normalizePath(path);

    const results: NodeEntry[] = [];
    let visitedNodes: { host: ManifestHost; basePath: string }[] = [{ host: startHost, basePath: startBasePath }];
    let currentDepth = 0;
    const depthLimit = depth === ListDepth.Deep ? (maxDepth ?? Number.MAX_SAFE_INTEGER) : 1;

    while (visitedNodes.length > 0 && currentDepth < depthLimit) {
      requestOptions?.signal?.throwIfAborted();

      const headers: NodeHeader[] = [];
      await awaitAllPromisesBounded(
        visitedNodes.map((item) => async (): Promise<NodeHeader[]> => {
          const mantarayNode = await this.store.getMantarayNode(
            item.host.topic,
            item.host.actPublisher ?? publisher,
            item.host.manifestRef,
            requestOptions,
          );

          return getAllNodeEntries(mantarayNode).map((e) => ({ ...e, path: joinPath(item.basePath, e.path) }));
        }),
        this.feedFetchConcurrency,
        (entries) => headers.push(...entries),
        (reason) => {
          if (requestOptions?.signal?.aborted) return;
          this.logger.error(`listFolder: failed to expand manifest: ${reason}`);
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
          record.driveId = cachedDrive.id;
          record.status = getRecordStatus(cachedDrive, e.topic);
          return record;
        }),
        this.feedFetchConcurrency,
        (record) => {
          if (!this.recordList.some((f) => f.topic === record.topic)) this._recordList.push(record);
          results.push(record);
        },
        (reason, ix) => {
          if (requestOptions?.signal?.aborted) return;
          this.logger.error(`listFolder: failed to load file ${fileHeaders[ix].topic}: ${reason}`);
        },
      );

      const folderHeaders = headers.filter((e) => e.type === NodeType.Folder);
      const nextFrontier: { host: ManifestHost; basePath: string }[] = [];
      await awaitAllPromisesBounded(
        folderHeaders.map((e) => async (): Promise<FolderInfo | null> => {
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
            this.logger.warn(`listFolder: folder feed not found for ${e.path} — skipping`);
            return null;
          }

          const manifestRef: ActReferences = payload.toJSON() as ActReferences;
          assertActReferences(manifestRef);
          this.store.setNodeFeedIndex(e.topic, feedIndexNext.toBigInt());

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
            status: getRecordStatus(cachedDrive, e.topic),
          };
        }),
        this.feedFetchConcurrency,
        (folder) => {
          if (folder) {
            results.push(folder);
            if (folder.status !== NodeStatus.Trashed) {
              nextFrontier.push({ host: folder, basePath: folder.path });
            }
          }
        },
        (reason, ix) => {
          if (requestOptions?.signal?.aborted) return;
          this.logger.error(`listFolder: failed to resolve folder ${folderHeaders[ix].path}: ${reason}`);
        },
      );

      // Shallow lists one level: depthLimit is 1, so the loop exits before descending into nextFrontier.
      visitedNodes = nextFrontier;
      currentDepth++;
    }

    requestOptions?.signal?.throwIfAborted();

    return results;
  }

  // Download an entire folder subtree of a drive: resolves the subtree's records fresh (hydrating
  // via listFolder), then fetches them. path '/' the whole drive.
  async downloadFolder(
    driveId: string | Identifier,
    path: string,
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadFilesResult> {
    requestOptions?.signal?.throwIfAborted();
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    await this.listFolder(driveId, path, ListDepth.Deep, undefined, requestOptions);

    const normalized = normalizePath(path);
    const prefix = normalized ? normalized + '/' : '';
    const driveIdStr = new Identifier(driveId).toString();
    const files = this.recordList.filter((f) => f.driveId === driveIdStr && f.path.startsWith(prefix));

    return this.downloadFiles(files, options, requestOptions);
  }

  // TODO: test move then download with new (ok) and old (fail) paths too
  async move(
    fromPath: string,
    toPath: string,
    sourceDriveId: string | Identifier,
    targetDriveId?: string | Identifier,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const sourceDriveIdStr = new Identifier(sourceDriveId).toString();
    const { driveIx: sourceDriveIx, cachedDrive: cachedSource } = this.findDriveOrThrow(sourceDriveIdStr);

    // disable drive move
    if (!fromPath || fromPath === ROOT_PATH) {
      throw new DriveError('Cannot move root folder');
    }
    if (!toPath || toPath === ROOT_PATH) {
      throw new DriveError('Invalid destination path');
    }

    const targetDriveIdStr = targetDriveId ? new Identifier(targetDriveId).toString() : undefined;

    const isCrossDrive = !!targetDriveIdStr && targetDriveIdStr !== sourceDriveIdStr;
    const effectiveTargetId = targetDriveIdStr ?? sourceDriveIdStr;

    let cachedTargetDrive: DriveInfo = cachedSource;
    let cachedTargetDriveIx = sourceDriveIx;
    if (targetDriveIdStr) {
      const { driveIx, cachedDrive } = this.findDriveOrThrow(targetDriveIdStr);
      cachedTargetDrive = cachedDrive;
      cachedTargetDriveIx = driveIx;
    }

    if (!isCrossDrive && fromPath === toPath) {
      throw new DriveError('Source and destination paths are identical');
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
      throw new DriveError(`Path not found: ${fromPath}`);
    }

    const forkMetadata = sourceFork.metadata ?? {};
    const isFile = forkMetadata[MANIFEST_METADATA_NODE_TYPE] === NodeType.File;

    const movedTopic = forkMetadata[MANIFEST_METADATA_NODE_TOPIC];
    if (movedTopic && getRecordStatus(cachedSource, movedTopic) === NodeStatus.Trashed) {
      throw new FileRecordError('Cannot move a trashed file/folder; recover it first');
    }

    const { host: tgtParentHost, folder: tgtParentFolder } = await this.store.resolveHost(
      cachedTargetDrive,
      tgtParentPath,
      publisher,
      requestOptions,
    );

    const sameParent = srcParentHost.topic === tgtParentHost.topic;
    const targetMantaray = sameParent
      ? sourceNode
      : await this.store.getMantarayNode(tgtParentHost.topic, publisher, tgtParentHost.manifestRef, requestOptions);

    // TODO: add test case for collision
    const existing = targetMantaray.find(tgtName);
    if (existing) {
      throw new DriveError(`Destination already exists: ${toPath}`);
    }

    if (isFile) {
      const fileTopic = forkMetadata[MANIFEST_METADATA_FILE_TOPIC];
      if (!fileTopic) {
        throw new FileRecordError(`Fork at ${fromPath} has no file topic — cannot move`);
      }

      const { record } = await this.loadRecord(fileTopic, this.signerAddress, publisher, undefined, requestOptions);

      record.path = tgtName;
      record.driveId = effectiveTargetId;

      const newVersion = record.version !== undefined ? new FeedIndex(record.version) : FEED_INDEX_ZERO;
      record.version = newVersion.next().toString();

      await this.persistRecord(record, requestOptions);

      record.path = toPath;
      forkMetadata[MANIFEST_METADATA_NODE_VERSION] = record.version;
    }

    sourceNode.removeFork(srcName);
    if (sameParent) {
      sourceNode.addFork(tgtName, sourceFork.targetAddress, forkMetadata);
    } else {
      targetMantaray.addFork(tgtName, sourceFork.targetAddress, forkMetadata);
    }

    const newSrcManifestRef = await this.store.saveMantarayNode(sourceNode, srcParentHost, requestOptions);
    if (!srcParentFolder) {
      this.driveList[sourceDriveIx].manifestRef = newSrcManifestRef;
    }

    if (!sameParent) {
      const newTgtManifestRef = await this.store.saveMantarayNode(targetMantaray, tgtParentHost, requestOptions);

      if (!tgtParentFolder) {
        this.driveList[cachedTargetDriveIx].manifestRef = newTgtManifestRef;
      }
    }

    if (!isFile) {
      // reset the in-memory cache
      const fromPrefix = fromPath + '/';
      const toPrefix = toPath + '/';
      for (const f of this.recordList) {
        if (f.driveId === sourceDriveIdStr && f.path.startsWith(fromPrefix)) {
          f.path = toPrefix + f.path.substring(fromPrefix.length);
          if (isCrossDrive) {
            f.driveId = effectiveTargetId;
          }
        }
      }

      const sourceTrash = cachedSource.trashedNodes ?? [];
      const affected = sourceTrash.filter((n) => n.path.startsWith(fromPrefix));

      if (affected.length > 0) {
        const rewrite = (n: TrashEntry): TrashEntry => ({
          ...n,
          path: toPrefix + n.path.substring(fromPrefix.length),
        });

        if (isCrossDrive) {
          cachedSource.trashedNodes = sourceTrash.filter((n) => !n.path.startsWith(fromPrefix));
          cachedTargetDrive.trashedNodes = [...(cachedTargetDrive.trashedNodes ?? []), ...affected.map(rewrite)];
          await this.persistAdminDriveFork(sourceDriveIx, requestOptions);
          await this.persistAdminDriveFork(cachedTargetDriveIx, requestOptions);
        } else {
          cachedSource.trashedNodes = sourceTrash.map((n) => (n.path.startsWith(fromPrefix) ? rewrite(n) : n));
          await this.persistAdminDriveFork(sourceDriveIx, requestOptions);
        }
      }
    }

    this.emitter.emit(FileManagerEvents.FILE_MOVED, { fromPath, toPath });
  }

  async forget(driveId: string | Identifier, path: string, requestOptions?: BeeRequestOptions): Promise<void> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);

    if (!path || path === ROOT_PATH) {
      throw new DriveError('Cannot forget drive root');
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

      await this.pruneTrashOverlay(driveIx, (n) => n.topic === nodeTopic || n.path.startsWith(prefix), requestOptions);
      this.emitter.emit(FileManagerEvents.FOLDER_FORGOTTEN, { driveInfo: cachedDrive, path });

      return;
    }

    const fiIndex = this.recordList.findIndex((f) => f.driveId === cachedDrive.id && f.path === path);

    const forgotten = fiIndex !== -1 ? this.recordList[fiIndex] : undefined;
    if (fiIndex !== -1) {
      this._recordList.splice(fiIndex, 1);
    }
    // TODO: add tests to make sure that the correct file is removed in case of smae file names in different folders
    await this.pruneTrashOverlay(driveIx, (n) => n.topic === nodeTopic || n.path === path, requestOptions);
    this.emitter.emit(FileManagerEvents.FILE_FORGOTTEN, { record: forgotten, path });
  }

  // --- Trash operations ---

  async trashFile(record: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
    await this.setTrashState(
      record.driveId,
      { topic: record.topic, type: NodeType.File, path: record.path, version: record.version },
      true,
      requestOptions,
    );
    record.status = NodeStatus.Trashed;
    this.emitter.emit(FileManagerEvents.FILE_TRASHED, { record });
  }

  async recoverFile(record: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
    await this.setTrashState(
      record.driveId,
      { topic: record.topic, type: NodeType.File, path: record.path },
      false,
      requestOptions,
    );
    record.status = NodeStatus.Active;
    this.emitter.emit(FileManagerEvents.FILE_RECOVERED, { record });
  }

  async trashFolder(folder: FolderInfo, requestOptions?: BeeRequestOptions): Promise<void> {
    await this.setTrashState(
      folder.driveId,
      { topic: folder.topic, type: NodeType.Folder, path: folder.path },
      true,
      requestOptions,
    );
    folder.status = NodeStatus.Trashed;
    this.emitter.emit(FileManagerEvents.FOLDER_TRASHED, { folder });
  }

  async recoverFolder(folder: FolderInfo, requestOptions?: BeeRequestOptions): Promise<void> {
    await this.setTrashState(
      folder.driveId,
      { topic: folder.topic, type: NodeType.Folder, path: folder.path },
      false,
      requestOptions,
    );
    folder.status = NodeStatus.Active;
    this.emitter.emit(FileManagerEvents.FOLDER_RECOVERED, { folder });
  }

  async listTrash(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<NodeEntry[]> {
    requestOptions?.signal?.throwIfAborted();

    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { cachedDrive } = this.findDriveOrThrow(driveId);

    const entries = cachedDrive.trashedNodes ?? [];
    const owner = this.signerAddress;
    const trashedResults: NodeEntry[] = [];

    await awaitAllPromisesBounded(
      entries.map((entry) => async (): Promise<NodeEntry | null> => {
        const version = entry.version ? new FeedIndex(entry.version).toBigInt() : undefined;

        const feedData = await getFeedData(this.bee, new Topic(entry.topic), owner, version, requestOptions);

        if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
          this.logger.warn(`listTrash: feed not found for ${entry.path} — skipping`);
          return null;
        }

        if (entry.type === NodeType.File) {
          const fr = await this.store.getRecord(entry.topic, publisher, feedData, requestOptions);
          fr.path = entry.path;
          fr.status = NodeStatus.Trashed;
          fr.driveId = cachedDrive.id;

          return fr;
        }

        const manifestRef = feedData.payload.toJSON() as ActReferences;
        assertActReferences(manifestRef);

        return {
          type: NodeType.Folder,
          owner,
          topic: entry.topic,
          manifestRef,
          batchId: cachedDrive.batchId,
          redundancyLevel: cachedDrive.redundancyLevel,
          actPublisher: publisher,
          path: entry.path,
          driveId: cachedDrive.id,
          status: NodeStatus.Trashed,
        };
      }),
      this.feedFetchConcurrency,
      (node) => {
        if (node) trashedResults.push(node);
      },
      (reason, ix) => {
        if (requestOptions?.signal?.aborted) return;
        this.logger.error(`listTrash: failed to resolve ${entries[ix].path}: ${reason}`);
      },
    );

    return trashedResults;
  }

  // --- Private helpers ---

  private async initPublisher(requestOptions?: BeeRequestOptions): Promise<void> {
    this.publisher = (await this.bee.getNodeAddresses(requestOptions)).publicKey;
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
      trashedNodes: [],
    };

    const driveNode = new MantarayNode();
    this.store.setNodeFeedIndex(newDrive.topic, 0n);
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

    if (reset) {
      this._driveList.length = 0;
      this.store.clear();
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

    this.stateFeedTopic = newStateFeedTopic;
    this.adminRedundancyLevel = redundancyLevel;
    this.store.setManifestCache(newStateFeedTopic.toString(), new MantarayNode());
    this.store.setNodeFeedIndex(newStateFeedTopic.toString(), 0n);
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

    this.store.setNodeFeedIndex(this.stateFeedTopic.toString(), feedIndexNext.toBigInt());

    await settlePromises(
      entries.map(async (entry) => {
        const driveInfo = assertDriveInfoFromMetadata(entry.rawMetadata);

        // Probe the drive feed head. A drive is a container and carries no stored version
        const {
          payload: drivePayload,
          feedIndex: driveFeedIndex,
          feedIndexNext: driveFeedIndexNext,
        } = await getFeedData(this.bee, new Topic(driveInfo.topic), this.signerAddress, undefined, requestOptions);

        if (driveFeedIndex.equals(FeedIndex.MINUS_ONE)) {
          this.logger.warn(
            `initDriveList: drive ${driveInfo.name} (${driveInfo.id}) has no manifest feed — skipping corrupt/incomplete drive`,
          );
          return;
        }

        driveInfo.manifestRef = drivePayload.toJSON() as ActReferences;
        assertActReferences(driveInfo.manifestRef);

        if (driveInfo.isAdmin) {
          await this.fetchAndSetAdminStamp(driveInfo.batchId, requestOptions);
          try {
            verifyStampUsability(this.adminStamp, driveInfo.batchId, false);
          } catch (err: unknown) {
            this.errorHandler.handleError(err);
            this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
            throw err;
          }

          this.adminRedundancyLevel = driveInfo.redundancyLevel;
        }

        this.store.setNodeFeedIndex(driveInfo.topic, driveFeedIndexNext.toBigInt());

        return driveInfo;
      }),
      (driveInfo) => {
        if (driveInfo) {
          this._driveList.push(driveInfo);
        }
      },
      (reason) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.logger.error(`initDriveList: failed to load drive from fork: ${(reason as any)?.message || reason}`),
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
    const driveIdStr = new Identifier(driveId).toString();
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
    this.store.setNodeFeedIndex(newFolderTopic, 0n);
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

  private async syncForkVersion(
    drive: DriveInfo,
    driveIx: number,
    absolutePath: string,
    newVersion: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    const { parentPath, name: filename } = splitPath(absolutePath);

    const {
      host: parentHost,
      folder: parentFolder,
      node: parentNode,
    } = await this.store.resolveHostMantaray(drive, parentPath, publisher, requestOptions);
    const fileFork = parentNode.find(filename);
    if (!fileFork) {
      throw new DriveError(`Path not found: ${absolutePath}`);
    }

    const forkMetadata = { ...(fileFork.metadata ?? {}) };
    forkMetadata[MANIFEST_METADATA_NODE_VERSION] = newVersion;
    parentNode.removeFork(filename);
    parentNode.addFork(filename, fileFork.targetAddress, forkMetadata);

    const newManifestRef = await this.store.saveMantarayNode(parentNode, parentHost, requestOptions);
    if (!parentFolder) {
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
    const cached = this.recordList.find((f) => f.topic === topic);
    if (cached) {
      return { record: cached, fromCache: true };
    }

    const feedData = await getFeedData(this.bee, new Topic(topic), owner, version, requestOptions);
    if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileRecordError(`File record not found for topic: ${topic.slice(0, 6)}`);
    }

    const loaded = await this.store.getRecord(topic, actPublisher, feedData, requestOptions);
    this._recordList.push(loaded);

    return { record: loaded, fromCache: false };
  }

  private async persistRecord(fr: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
    try {
      await this.store.saveRecord(fr, requestOptions);
    } catch (err: unknown) {
      this.errorHandler.handleError(err, `Failed to save record: ${fr.path}`);
      throw new FileRecordError(`Failed to save record`, err);
    }

    const existingIx = this.recordList.findIndex((f) => f.topic === fr.topic);
    if (existingIx !== -1) {
      this._recordList[existingIx] = fr;
    } else {
      this._recordList.push(fr);
    }
  }

  private async setTrashState(
    driveId: string | undefined,
    entry: TrashEntry,
    isTrashed: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<DriveInfo> {
    if (!driveId) {
      throw new FileRecordError(`Drive ID missing for: ${entry.path}`);
    }

    const { driveIx, cachedDrive } = this.findDriveOrThrow(driveId);
    const isAlreadyTrashed = getRecordStatus(cachedDrive, entry.topic) === NodeStatus.Trashed;

    if (isTrashed && isAlreadyTrashed) {
      throw new FileRecordError(`Already trashed: ${entry.path}`);
    }
    if (!isTrashed && !isAlreadyTrashed) {
      throw new FileRecordError(`Not trashed, cannot recover: ${entry.path}`);
    }

    const current = cachedDrive.trashedNodes ?? [];
    const withoutEntry = current.filter((n) => n.topic !== entry.topic);
    cachedDrive.trashedNodes = isTrashed ? [...withoutEntry, entry] : withoutEntry;
    await this.persistAdminDriveFork(driveIx, requestOptions);

    return cachedDrive;
  }

  private async persistAdminDriveFork(driveIx: number, requestOptions?: BeeRequestOptions): Promise<void> {
    const { publisher, stateFeedTopic } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    const adminMantaray = this.store.getManifestCache(stateFeedTopic);
    if (!adminMantaray) {
      throw new DriveError('Admin manifest not loaded — initialize first.');
    }

    const drive = this.driveList[driveIx];
    const adminHost = this.adminHost(publisher);

    adminMantaray.removeFork(getDriveForkPath(drive.id));
    adminMantaray.addFork(getDriveForkPath(drive.id), new Reference(drive.topic), driveForkMetadata(drive));

    await this.store.saveMantarayNode(adminMantaray, adminHost, requestOptions);
  }

  private async pruneTrashOverlay(
    driveIx: number,
    predicate: (entry: TrashEntry) => boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    const drive = this.driveList[driveIx];
    const current = drive.trashedNodes ?? [];
    const remaining = current.filter((e) => !predicate(e));
    if (remaining.length === current.length) {
      return;
    }

    drive.trashedNodes = remaining;
    await this.persistAdminDriveFork(driveIx, requestOptions);
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
