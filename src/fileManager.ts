import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  DownloadOptions,
  FeedIndex,
  FileUploadOptions,
  GetGranteesResult,
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

import { DownloadResource, DownloadResult } from './types/download';
import { FileManager } from './types/fileManager';
import {
  DirectoryEntry,
  DriveInfo,
  FileRecord,
  FileStatus,
  FolderInfo,
  ListDepth,
  ManifestHost,
  NodeType,
  ShareItem,
} from './types/info';
import { UpdateItem, UploadFilesResult, UploadItem } from './types/upload';
import { ActReferences, FeedResultWithIndex } from './types/utils';
import { assertActReferences, assertDriveInfoFromMetadata, assertFileRecord, assertReady } from './utils/asserts';
import { fetchStamp, getFeedData, getTopicAndVersion, verifyStampUsability } from './utils/bee';
import { awaitAllPromisesBounded, joinPath, settlePromises } from './utils/common';
import {
  ADMIN_STAMP_LABEL,
  DRIVE_FORK_PREFIX,
  FEED_INDEX_ZERO,
  FILEMANAGER_STATE_TOPIC,
  MANIFEST_METADATA_DRIVE_ACT_PUBLISHER,
  MANIFEST_METADATA_DRIVE_BATCH_ID,
  MANIFEST_METADATA_DRIVE_ID,
  MANIFEST_METADATA_DRIVE_IS_ADMIN,
  MANIFEST_METADATA_DRIVE_NAME,
  MANIFEST_METADATA_DRIVE_OWNER,
  MANIFEST_METADATA_FILE_TOPIC,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  MAX_CONCURRENT_FEED_FETCHES,
  MAX_CONCURRENT_UPLOADS,
  ROOT_PATH,
} from './utils/constants';
import { generateRandomBytes } from './utils/crypto';
import {
  BeeVersionError,
  DriveError,
  FileInfoError,
  GranteeError,
  SendShareMessageError,
  SignerError,
  StampError,
  SubscriptionError,
} from './utils/errors';
import { FileManagerEvents } from './utils/events';
import { addFileToManifest, getAllNodeEntries, loadMantaray, saveNodeManifest } from './utils/mantaray';
import { processDownload } from './download';
import { EventEmitter, EventEmitterBase } from './eventEmitter';
import { assertUploadableSource, processUpload } from './upload';

export class FileManagerBase implements FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private signerAddress: string;
  private publisher: PublicKey | undefined = undefined;
  private stateFeedTopic: Topic | undefined = undefined;
  private isInitialized: boolean = false; // TODO: provide getter
  private isInitializing: boolean = false;
  private _adminStamp: PostageBatch | undefined = undefined;
  private nodeManifestCache: Map<string, MantarayNode> = new Map();
  private nodeFeedIndexCache: Map<string, bigint> = new Map();
  private fileInfoHistoryCache: Map<string, string> = new Map();
  private adminManifestRef: ActReferences | undefined = undefined;
  private adminRedundancyLevel: RedundancyLevel = RedundancyLevel.OFF;

  readonly driveList: DriveInfo[] = [];
  readonly fileInfoList: FileRecord[] = [];
  readonly sharedWithMe: ShareItem[] = [];
  readonly emitter: EventEmitter;

  get adminStamp(): PostageBatch | undefined {
    return this._adminStamp;
  }
  // TODO: improve logging -> pass as ctor arg like emitter
  constructor(bee: Bee, emitter: EventEmitter = new EventEmitterBase()) {
    this.bee = bee;
    if (!this.bee.signer) {
      throw new SignerError('Signer required');
    }

    this.emitter = emitter;
    this.signer = this.bee.signer;
    this.signerAddress = this.signer.publicKey().address().toString();
  }

  // File records are loaded lazily via listFolder / download / move as the user navigates — no eager full-drive load at init.
  async initialize(requestOptions?: BeeRequestOptions): Promise<void> {
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
      await this.verifySupportedVersions(requestOptions);
      await this.initPublisher(requestOptions);

      console.debug('Trying to load state from Swarm.');

      const success = await this.tryToFetchAdminState(requestOptions);
      if (success) {
        await this.initDriveList(requestOptions);
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

  private async verifySupportedVersions(requestOptions?: BeeRequestOptions): Promise<void> {
    const beeVersions = await this.bee.getVersions(requestOptions);
    console.debug(`Bee version: ${beeVersions.beeVersion}`);
    console.debug(`Bee API version: ${beeVersions.beeApiVersion}`);
    const supportedApi = await this.bee.isSupportedApiVersion(requestOptions);

    if (!supportedApi) {
      console.error('Supported bee API version: ', beeVersions.supportedBeeApiVersion);
      console.error('Supported bee version: ', beeVersions.supportedBeeVersion);
      throw new BeeVersionError('Bee or Bee API version not supported');
    }
  }

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
      console.debug('State not found.');
      return false;
    }

    let stateTopicInfo: ActReferences;
    try {
      stateTopicInfo = payload.toJSON() as ActReferences;
      assertActReferences(stateTopicInfo);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error(`Failed to fetch admin state: ${error.message || error}`);
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

  private async createAdminManifest(
    batchId: string,
    resetState?: boolean,
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
    if (!resetState && isStateExisting) {
      throw new DriveError('Admin state already exists. Pass resetState=true to overwrite.');
    }

    const randomTopic = generateRandomBytes(Topic.LENGTH);
    const newStateFeedTopic = new Topic(randomTopic);
    const topicUploadRes = await this.bee.uploadData(
      batchId,
      newStateFeedTopic.toUint8Array(),
      { act: true },
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

    const emptyAdminMantaray = new MantarayNode();
    const saveResult = await emptyAdminMantaray.saveRecursively(this.bee, batchId, { act: false }, requestOptions);
    // TODO: development assert below manifestUpload.href === topicState.historyRef
    const manifestUpload = await this.bee.uploadData(
      batchId,
      saveResult.reference.toUint8Array(),
      { act: true, actHistoryAddress: historyRef },
      requestOptions,
    );
    const adminManifestRef: ActReferences = {
      reference: manifestUpload.reference.toString(),
      historyRef: manifestUpload.historyAddress.getOrThrow().toString(),
    };
    this.adminManifestRef = adminManifestRef;

    const adminfw = this.bee.makeFeedWriter(this.stateFeedTopic.toUint8Array(), this.signer, requestOptions);
    await adminfw.uploadPayload(batchId, JSON.stringify(adminManifestRef), {
      index: FEED_INDEX_ZERO,
    });

    this.nodeFeedIndexCache.set(this.stateFeedTopic.toString(), 1n);
    this.nodeManifestCache.set(this.stateFeedTopic.toString(), emptyAdminMantaray);
  }

  private async initDriveList(requestOptions?: BeeRequestOptions): Promise<void> {
    if (this.adminManifestRef) {
      throw new DriveError('Admin manifest already set');
    }
    if (!this.stateFeedTopic) {
      throw new DriveError('State feed topic not set');
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
      console.debug('Admin manifest feed empty — no drives to load');
      return;
    }

    const adminManifestRef: ActReferences = payload.toJSON() as ActReferences;
    assertActReferences(adminManifestRef);

    this.nodeFeedIndexCache.set(this.stateFeedTopic.toString(), feedIndexNext.toBigInt());
    // TODO: does it make sense to set the sate handling vars only at the end of each function call in case they throw later?
    this.adminManifestRef = adminManifestRef;

    const adminManifestRaw = await this.bee.downloadData(
      adminManifestRef.reference,
      {
        actHistoryAddress: adminManifestRef.historyRef,
        actPublisher: this.publisher,
      },
      requestOptions,
    );
    const adminMantaray = await loadMantaray(this.bee, new Reference(adminManifestRaw), undefined, requestOptions);
    this.nodeManifestCache.set(this.stateFeedTopic.toString(), adminMantaray);

    const entries = getAllNodeEntries(adminMantaray).filter((e) => e.type === NodeType.Drive);

    await settlePromises(
      entries.map(async (entry) => {
        const driveInfo = assertDriveInfoFromMetadata(entry.rawMetadata);

        const {
          payload: drivePayload,
          feedIndex: driveFeedIndex,
          feedIndexNext: driveFeedIndexNext,
        } = await getFeedData(this.bee, new Topic(driveInfo.topic), this.signerAddress, undefined, requestOptions);

        if (driveFeedIndex.equals(FeedIndex.MINUS_ONE)) {
          console.warn(
            `initDriveList: drive ${driveInfo.name} (${driveInfo.id}) has no manifest feed — skipping corrupt/incomplete drive`,
          );
          return;
        }

        driveInfo.manifestRef = drivePayload.toJSON() as ActReferences;
        assertActReferences(driveInfo.manifestRef);

        if (driveInfo.isAdmin) {
          await this.fetchAndSetAdminStamp(driveInfo.batchId, requestOptions);

          try {
            verifyStampUsability(this.adminStamp, driveInfo.batchId);
          } catch (error) {
            this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
            throw error;
          }
          // TODO: this.adminManifestRef setting vs driveInfo.manifestRef ?
          this.adminRedundancyLevel = driveInfo.redundancyLevel;
        }

        this.nodeFeedIndexCache.set(driveInfo.topic, driveFeedIndexNext.toBigInt());

        return driveInfo;
      }),
      (driveInfo) => {
        if (driveInfo) {
          this.driveList.push(driveInfo);
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (reason) => console.error(`initDriveList: failed to load drive from fork: ${(reason as any)?.message || reason}`),
    );
  }

  private async pruneDriveMetadata(
    driveInfo: DriveInfo,
    driveIndex: number,
    stateTopic: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    if (!this.adminManifestRef) {
      throw new DriveError('Admin manifest not set');
    }
    if (!this.adminStamp) {
      throw new DriveError('Admin stamp not found');
    }

    const adminMantaray = this.nodeManifestCache.get(stateTopic);
    if (!adminMantaray) {
      throw new DriveError('Admin manifest not loaded — initialize first.');
    }

    const adminHost: ManifestHost = {
      owner: this.signerAddress,
      topic: stateTopic,
      manifestRef: this.adminManifestRef,
      batchId: this.adminStamp.batchID.toString(),
      redundancyLevel: this.adminRedundancyLevel,
      actPublisher: publisher,
    };

    adminMantaray.removeFork(`${DRIVE_FORK_PREFIX}-${driveInfo.id}`);
    const newAdminManifestRef = await this.saveMantarayNode(adminMantaray, adminHost, requestOptions);
    this.adminManifestRef = newAdminManifestRef;

    this.driveList.splice(driveIndex, 1);
    this.nodeFeedIndexCache.delete(driveInfo.topic);
    this.nodeManifestCache.delete(driveInfo.topic);

    for (let i = this.fileInfoList.length - 1; i >= 0; --i) {
      if (this.fileInfoList[i].driveId === driveInfo.id) {
        this.fileInfoList.splice(i, 1);
      }
    }
  }

  async createDrive(
    batchId: string | BatchId,
    name: string,
    isAdmin: boolean,
    redundancyLevel?: RedundancyLevel,
    resetState?: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<DriveInfo> {
    requestOptions?.signal?.throwIfAborted();

    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized');
    }
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const batchIdStr = batchId.toString();
    let driveName = name;
    if (isAdmin) {
      console.debug('Creating admin drive with name: ', ADMIN_STAMP_LABEL);
      driveName = ADMIN_STAMP_LABEL;

      await this.fetchAndSetAdminStamp(batchIdStr, requestOptions);
      verifyStampUsability(this.adminStamp, batchIdStr).batchID.toString();
      await this.createAdminManifest(batchIdStr, resetState, requestOptions);
    } else {
      const fetchedStamp = await fetchStamp(this.bee, batchId);
      verifyStampUsability(fetchedStamp, batchIdStr).batchID.toString();
    }

    if (!this.adminManifestRef) {
      throw new DriveError('Admin manifest not set');
    }

    const stateTopic = this.stateFeedTopic?.toString();
    if (!stateTopic) {
      throw new DriveError('Admin state not initialized');
    }

    if (!this.adminStamp) {
      throw new DriveError('Admin stamp not found');
    }

    if (resetState) {
      if (!isAdmin) {
        throw new DriveError(`Cannot reset non-admin drive: "${driveName}"`);
      }

      this.driveList.length = 0;
      this.nodeManifestCache.clear();
      this.nodeFeedIndexCache.clear();
    } else {
      this.driveList.forEach((d) => {
        if (isAdmin && d.isAdmin) {
          throw new DriveError('Admin drive already exists');
        }

        if (d.name === driveName || d.batchId === batchIdStr) {
          throw new DriveError(`Drive with name "${driveName}" or batchId "${batchIdStr.slice(0, 6)}" already exists`);
        }
      });
    }

    const randomId = generateRandomBytes(Identifier.LENGTH);
    const newDrive: DriveInfo = {
      id: new Identifier(randomId).toString(),
      name: driveName,
      batchId: batchIdStr,
      owner: this.signerAddress,
      redundancyLevel: redundancyLevel ?? RedundancyLevel.OFF,
      topic: new Topic(generateRandomBytes(Topic.LENGTH)).toString(),
      isAdmin,
      actPublisher: this.publisher.toCompressedHex(),
    };
    this.driveList.push(newDrive);
    // TODO: empty mantaray save makes no sense ? drivename at least? -> always creates the same hash ?
    const emptyMantaray = new MantarayNode();
    const saveResult = await emptyMantaray.saveRecursively(this.bee, newDrive.batchId, { act: false }, requestOptions);
    const manifestUpload = await this.bee.uploadData(
      newDrive.batchId,
      saveResult.reference.toUint8Array(),
      { act: true, redundancyLevel: newDrive.redundancyLevel },
      requestOptions,
    );

    newDrive.manifestRef = {
      reference: manifestUpload.reference.toString(),
      historyRef: manifestUpload.historyAddress.getOrThrow().toString(),
    };
    const fw = this.bee.makeFeedWriter(new Topic(newDrive.topic).toUint8Array(), this.signer, requestOptions);
    await fw.uploadPayload(newDrive.batchId, JSON.stringify(newDrive.manifestRef), { index: FEED_INDEX_ZERO });

    this.nodeManifestCache.set(newDrive.topic, emptyMantaray);
    this.nodeFeedIndexCache.set(newDrive.topic, 1n);

    const adminHost: ManifestHost = {
      owner: this.signerAddress,
      topic: stateTopic,
      manifestRef: this.adminManifestRef,
      batchId: this.adminStamp.batchID.toString(),
      redundancyLevel: this.adminRedundancyLevel,
      actPublisher: this.publisher.toCompressedHex(),
    };

    const adminMantaray = this.nodeManifestCache.get(stateTopic);
    if (!adminMantaray) {
      throw new DriveError('Admin manifest not loaded — initialize first.');
    }

    adminMantaray.addFork(`${DRIVE_FORK_PREFIX}-${newDrive.id}`, new Reference(newDrive.topic), {
      [MANIFEST_METADATA_NODE_TOPIC]: newDrive.topic,
      [MANIFEST_METADATA_NODE_TYPE]: NodeType.Drive,
      [MANIFEST_METADATA_DRIVE_ID]: newDrive.id,
      [MANIFEST_METADATA_DRIVE_NAME]: newDrive.name,
      [MANIFEST_METADATA_DRIVE_OWNER]: newDrive.owner,
      [MANIFEST_METADATA_DRIVE_IS_ADMIN]: String(newDrive.isAdmin),
      [MANIFEST_METADATA_DRIVE_BATCH_ID]: newDrive.batchId,
      [MANIFEST_METADATA_DRIVE_ACT_PUBLISHER]: newDrive.actPublisher,
      [MANIFEST_METADATA_REDUNDANCY_LEVEL]: newDrive.redundancyLevel.toString(),
    });

    const newAdminManifestRef = await this.saveMantarayNode(adminMantaray, adminHost, requestOptions);
    this.adminManifestRef = newAdminManifestRef;

    this.emitter.emit(FileManagerEvents.DRIVE_CREATED, { driveInfo: newDrive });

    return newDrive;
  }

  // Per BFS walk: (1) expand current manifest node, (2) load file feeds found, (3) resolve folder feeds into next node. Each phase is concurrency-bounded.
  async listFolder(
    driveId: string | Identifier,
    path: string,
    depth: ListDepth = ListDepth.Shallow,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<DirectoryEntry[]> {
    requestOptions?.signal?.throwIfAborted();

    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { cachedDrive } = this.findDriveOrThrow(new Identifier(driveId).toString());

    const startFolder = await this.resolveFolder(cachedDrive, path, publisher, requestOptions);
    const startHost: ManifestHost = startFolder ?? {
      owner: this.signerAddress,
      topic: cachedDrive.topic,
      manifestRef: cachedDrive.manifestRef,
      batchId: cachedDrive.batchId,
      redundancyLevel: cachedDrive.redundancyLevel,
      actPublisher: cachedDrive.actPublisher,
    };
    const startBasePath = path.split('/').filter(Boolean).join('/');

    const results: DirectoryEntry[] = [];
    let visitedNodes: { host: ManifestHost; basePath: string }[] = [{ host: startHost, basePath: startBasePath }];
    let currentDepth = 0;
    const depthLimit = depth === ListDepth.Deep ? (maxDepth ?? Number.MAX_SAFE_INTEGER) : 1;

    while (visitedNodes.length > 0 && currentDepth < depthLimit) {
      requestOptions?.signal?.throwIfAborted();

      const currentDepthEntries: DirectoryEntry[] = [];

      await awaitAllPromisesBounded(
        visitedNodes.map((item) => async (): Promise<DirectoryEntry[]> => {
          const mantaray = await this.getMantarayNode(item.host, publisher, requestOptions);

          return getAllNodeEntries(mantaray).map((e) => ({ ...e, path: joinPath(item.basePath, e.path) }));
        }),
        MAX_CONCURRENT_FEED_FETCHES,
        (entries) => currentDepthEntries.push(...entries),
        (reason) => {
          if (requestOptions?.signal?.aborted) return;
          console.error(`listFolder: failed to expand manifest: ${reason}`);
        },
      );

      results.push(...currentDepthEntries);
      const newFileEntries = currentDepthEntries.filter(
        (e) => e.type === NodeType.File && !this.fileInfoList.some((f) => f.topic === e.topic),
      );
      // TODO: why feedindex / version is not tracked -> expensive lookup
      await awaitAllPromisesBounded(
        newFileEntries.map((e) => async (): Promise<FileRecord> => {
          const feedData = await getFeedData(
            this.bee,
            new Topic(e.topic),
            this.signerAddress,
            undefined,
            requestOptions,
          );

          const fr = await this.fetchFileInfo(e.topic, publisher, feedData, requestOptions);

          // In-memory copy is stamped with the path composed while walking — mirrors the
          // existing version stamp in fetchFileInfo.
          fr.path = e.path;

          return fr;
        }),
        MAX_CONCURRENT_FEED_FETCHES,
        (fr) => this.fileInfoList.push(fr),
        (reason, ix) => {
          if (requestOptions?.signal?.aborted) return;

          console.error(`listFolder: failed to load file ${newFileEntries[ix].topic}: ${reason}`);
        },
      );

      if (depth === ListDepth.Shallow) break;

      const folderEntries = currentDepthEntries.filter((e) => e.type === NodeType.Folder);
      const nextFrontier: { host: ManifestHost; basePath: string }[] = [];

      await awaitAllPromisesBounded(
        folderEntries.map((e) => async (): Promise<{ host: ManifestHost; basePath: string } | null> => {
          // TODO: why feedindex / version is not tracked -> expensive lookup
          const { payload, feedIndex, feedIndexNext } = await getFeedData(
            this.bee,
            new Topic(e.topic),
            this.signerAddress,
            undefined,
            requestOptions,
          );
          if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
            console.warn(`listFolder: folder feed not found for ${e.path} — skipping`);
            return null;
          }

          const manifestRef: ActReferences = payload.toJSON() as ActReferences;
          assertActReferences(manifestRef);

          this.nodeFeedIndexCache.set(e.topic, feedIndexNext.toBigInt());

          // TOOD: why as ManifestHost --> don't we need owner- the whole type?
          return {
            host: {
              topic: e.topic,
              manifestRef,
              batchId: cachedDrive.batchId,
              redundancyLevel: cachedDrive.redundancyLevel,
            } as ManifestHost,
            basePath: e.path,
          };
        }),
        MAX_CONCURRENT_FEED_FETCHES,
        (item) => {
          if (item) {
            nextFrontier.push(item);
          }
        },
        (reason, ix) => {
          if (requestOptions?.signal?.aborted) return;
          console.error(`listFolder: failed to resolve folder ${folderEntries[ix].path}: ${reason}`);
        },
      );

      visitedNodes = nextFrontier;
      currentDepth++;
    }

    requestOptions?.signal?.throwIfAborted();

    return results;
  }

  // Download an entire folder subtree of a drive: resolves the subtree's records fresh (hydrating
  // via listFolder), then fetches them. path '' (default) = the whole drive.
  async downloadFolder(
    driveId: string | Identifier,
    path: string = '',
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult[]> {
    requestOptions?.signal?.throwIfAborted();
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    await this.listFolder(driveId, path, ListDepth.Deep, undefined, requestOptions);

    const normalized = path.split('/').filter(Boolean).join('/');
    const prefix = normalized ? normalized + '/' : '';
    const files = this.fileInfoList.filter((f) => f.driveId === driveId.toString() && f.path.startsWith(prefix));

    return this.downloadFiles(files, options, requestOptions);
  }

  // Download a single file the caller already holds as a FileRecord — convenience wrapper over
  // downloadFiles(). Does not re-resolve against drive state (see downloadFiles).
  async downloadFile(
    fileRecord: FileRecord,
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult> {
    return (await this.downloadFiles([fileRecord], options, requestOptions))[0];
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
  ): Promise<DownloadResult[]> {
    requestOptions?.signal?.throwIfAborted();
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    if (fileRecords.length === 0) return [];

    const resources: DownloadResource[] = fileRecords.map((fr) => ({
      path: fr.path,
      reference: fr.content.reference,
      actHistoryAddress: fr.content.historyRef,
      actPublisher: fr.actPublisher,
    }));

    return await processDownload(this.bee, resources, options, requestOptions);
  }

  // TODO: now rLevel is derived from tha parent folder/ drive -> default to it and potentially overwrite it
  async uploadFile(
    driveId: string | Identifier,
    item: UploadItem,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(new Identifier(driveId).toString());

    await assertUploadableSource(item);

    // Resolve the parent folder up front so the new fork inherits the parent's redundancy level.
    const lastSlash = item.path.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? item.path.substring(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? item.path.substring(lastSlash + 1) : item.path;

    const parentFolder = await this.resolveFolder(cachedDrive, parentPath, publisher, requestOptions);
    const targetHost: ManifestHost = parentFolder ?? {
      owner: this.signerAddress,
      topic: cachedDrive.topic,
      manifestRef: cachedDrive.manifestRef,
      batchId: cachedDrive.batchId,
      redundancyLevel: cachedDrive.redundancyLevel,
      actPublisher: publisher,
    };

    const owner = this.signerAddress;
    const { topic, version } = await getTopicAndVersion(
      this.bee,
      owner,
      undefined,
      undefined,
      undefined,
      requestOptions,
    );

    const contentRefAndHistory = await processUpload(
      this.bee,
      cachedDrive,
      item,
      targetHost.redundancyLevel,
      uploadOptions,
      requestOptions,
    );
    const record: FileRecord = {
      batchId: cachedDrive.batchId,
      owner,
      topic,
      // Persisted value is the relative filename — see FileRecord.path doc comment.
      path: filename,
      actPublisher: publisher,
      content: contentRefAndHistory,
      driveId: cachedDrive.id,
      timestamp: new Date().getTime(),
      shared: false,
      version,
      customMetadata: item.customMetadata,
      redundancyLevel: targetHost.redundancyLevel,
      status: FileStatus.Active,
    };

    await this.saveFileInfoFeed(record, requestOptions);
    // In-memory copy is stamped with the caller-known absolute path — no walk needed here.
    record.path = item.path;

    const mantaray = await this.getMantarayNode(targetHost, publisher, requestOptions);

    addFileToManifest(mantaray, filename, topic);

    const newManifestRef = await this.saveMantarayNode(mantaray, targetHost, requestOptions);

    if (!parentFolder) {
      this.driveList[driveIx].manifestRef = newManifestRef;
    }

    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { record });

    return record;
  }

  async uploadFiles(
    driveId: string | Identifier,
    items: UploadItem[],
    destinationPath: string = '',
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<UploadFilesResult> {
    // Phase 0 — guards. Reject immediately if already aborted before any work starts.
    requestOptions?.signal?.throwIfAborted();

    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(new Identifier(driveId).toString());

    if (!items.length) {
      throw new FileInfoError('uploadFiles requires at least one entry');
    }

    for (const entry of items) {
      const rp = entry.path;
      if (!rp || rp.startsWith('/') || rp.includes('..') || rp.endsWith('/')) {
        throw new FileInfoError(`Invalid path: "${rp}"`);
      }
    }

    // Phase 1 — plan (no writes). Resolve the destination once (throws if invalid — correct
    // fail-fast), then walk the new hierarchy top-down classifying each needed folder path as
    // existing / missing / conflict before any write happens.
    const segmentsOf = (p: string): string[] => p.split('/').filter(Boolean);

    const destSegments = segmentsOf(destinationPath);
    const destKey = destSegments.join('/');
    const destFolder = await this.resolveFolder(cachedDrive, destinationPath, publisher, requestOptions);
    const destHost: ManifestHost = destFolder ?? {
      owner: this.signerAddress,
      topic: cachedDrive.topic,
      manifestRef: cachedDrive.manifestRef,
      batchId: cachedDrive.batchId,
      redundancyLevel: cachedDrive.redundancyLevel,
      actPublisher: publisher,
    };

    interface PlannedFile {
      item: UploadItem;
      fullPath: string;
      filename: string;
      parentPath: string;
    }

    const plannedFiles: PlannedFile[] = [];
    const neededFolderPaths = new Set<string>();

    for (const item of items) {
      const relSegments = segmentsOf(item.path);
      const filename = relSegments[relSegments.length - 1];
      const folderSegments = relSegments.slice(0, -1);
      const fullPath = [...destSegments, ...relSegments].join('/');
      const parentPath = [...destSegments, ...folderSegments].join('/');

      plannedFiles.push({ item, fullPath, filename, parentPath });

      for (let i = 1; i <= folderSegments.length; i++) {
        neededFolderPaths.add([...destSegments, ...folderSegments.slice(0, i)].join('/'));
      }
    }

    const sortedFolderPaths = Array.from(neededFolderPaths).sort((a, b) => segmentsOf(a).length - segmentsOf(b).length);

    const hostMap = new Map<string, ManifestHost>();
    hostMap.set(destKey, destHost);

    const missingFolderPaths = new Set<string>();
    const missingFolders: { path: string; parentPath: string; folderName: string }[] = [];

    for (const path of sortedFolderPaths) {
      const segments = segmentsOf(path);
      const folderName = segments[segments.length - 1];
      const parentPath = segments.slice(0, -1).join('/');

      if (missingFolderPaths.has(parentPath)) {
        // Parent doesn't exist yet (queued for Phase 2) — this folder can't exist either.
        missingFolderPaths.add(path);
        missingFolders.push({ path, parentPath, folderName });
        continue;
      }

      const parentHost = hostMap.get(parentPath);
      if (!parentHost) {
        throw new DriveError(`Internal error: parent folder not resolved for path: ${path}`);
      }

      const parentMantaray = await this.getMantarayNode(parentHost, publisher, requestOptions);
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
        throw new FileInfoError(`Folder fork missing topic: ${path}`);
      }

      // TODO: why feedindex / version is not tracked -> expensive lookup
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
        redundancyLevel: meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]
          ? (parseInt(meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]) as RedundancyLevel)
          : cachedDrive.redundancyLevel,
        actPublisher: publisher,
      });
    }

    // Any host that will receive a fork (folder or file) — saved exactly once in Phase 4.
    const dirtyHosts = new Map<string, ManifestHost>();

    // Phase 2 — create missing folders, shallow-to-deep, sequential (folder count is small and
    // ordering matters: each folder's parent must already be in hostMap when it's created).
    for (const { path, parentPath, folderName } of missingFolders) {
      const parentHost = hostMap.get(parentPath);
      if (!parentHost) {
        throw new DriveError(`Internal error: parent folder not resolved for path: ${path}`);
      }

      const folderInfo = await this.createFolderNode(
        cachedDrive,
        parentHost,
        parentPath,
        folderName,
        publisher,
        undefined,
        requestOptions,
      );

      hostMap.set(path, {
        owner: this.signerAddress,
        topic: folderInfo.topic,
        manifestRef: folderInfo.manifestRef,
        batchId: folderInfo.batchId,
        redundancyLevel: folderInfo.redundancyLevel,
        actPublisher: publisher,
      });
      dirtyHosts.set(parentHost.topic, parentHost);

      this.emitter.emit(FileManagerEvents.FOLDER_CREATED, { folderInfo });
    }

    // Phase 3 — upload files, bounded concurrency.
    const succeeded: FileRecord[] = [];
    const failed: { path: string; error: string }[] = [];
    const owner = this.signerAddress;

    await awaitAllPromisesBounded(
      plannedFiles.map((planned) => async (): Promise<FileRecord> => {
        // Between-files abort is benign — completed files are valid standalone nodes.
        requestOptions?.signal?.throwIfAborted();

        const parentHost = hostMap.get(planned.parentPath);
        if (!parentHost) {
          throw new FileInfoError(`Internal error: parent folder not resolved for path: ${planned.fullPath}`);
        }

        const { topic, version } = await getTopicAndVersion(
          this.bee,
          owner,
          undefined,
          undefined,
          undefined,
          requestOptions,
        );

        const contentRefAndHistory = await processUpload(
          this.bee,
          cachedDrive,
          planned.item,
          parentHost.redundancyLevel,
          uploadOptions,
          requestOptions,
        );

        const record: FileRecord = {
          batchId: cachedDrive.batchId,
          owner,
          topic,
          // Persisted value is the relative filename — see FileRecord.path doc comment.
          path: planned.filename,
          actPublisher: publisher,
          content: contentRefAndHistory,
          driveId: cachedDrive.id,
          timestamp: new Date().getTime(),
          shared: false,
          version,
          redundancyLevel: parentHost.redundancyLevel,
          status: FileStatus.Active,
        };

        await this.saveFileInfoFeed(record, requestOptions);
        // In-memory copy is stamped with the already-planned absolute path — no walk needed here.
        record.path = planned.fullPath;

        const parentMantaray = await this.getMantarayNode(parentHost, publisher, requestOptions);
        addFileToManifest(parentMantaray, planned.filename, topic);
        dirtyHosts.set(parentHost.topic, parentHost);

        this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { record });

        return record;
      }),
      MAX_CONCURRENT_UPLOADS,
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
      const mantaray = await this.getMantarayNode(host, publisher, requestOptions);
      const updatedRef = await this.saveMantarayNode(mantaray, host, requestOptions);

      if (host.topic === cachedDrive.topic) {
        this.driveList[driveIx].manifestRef = updatedRef;
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
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { cachedDrive } = this.findDriveOrThrow(new Identifier(driveId).toString());

    const noMeta = !changes.customMetadata || Object.keys(changes.customMetadata).length === 0;
    if (noMeta && !changes.item) {
      throw new FileInfoError('Neither a file/path nor customMetadata is provided');
    }

    const owner = this.signerAddress;
    // TODO: track versions for better performance
    const cached = this.fileInfoList.find((f) => f.topic === record.topic);
    const { topic, version } = await getTopicAndVersion(
      this.bee,
      owner,
      cached,
      record.topic,
      undefined,
      requestOptions,
    );

    const mergedMetadata = changes.customMetadata
      ? { ...record.customMetadata, ...changes.customMetadata }
      : record.customMetadata;

    let contentRefAndHistory: ActReferences;
    if (changes.item !== undefined) {
      const contentUploadOptions = {
        ...uploadOptions,
        actHistoryAddress: record.content.historyRef,
      };

      contentRefAndHistory = await processUpload(
        this.bee,
        cachedDrive,
        changes.item,
        record.redundancyLevel ?? cachedDrive.redundancyLevel,
        contentUploadOptions,
        requestOptions,
      );
    } else {
      contentRefAndHistory = record.content;
    }

    // TODO: update never renames; the manifest fork key stays authoritative and the
    // walkers re-derive path from it on hydration, so no split/reassembly here. -> is correct and intended?
    const fr: FileRecord = {
      batchId: record.batchId,
      owner,
      topic,
      path: record.path,
      actPublisher: record.actPublisher,
      content: contentRefAndHistory,
      driveId: record.driveId,
      timestamp: new Date().getTime(),
      shared: record.shared ?? false,
      version,
      customMetadata: mergedMetadata,
      redundancyLevel: record.redundancyLevel,
      status: record.status ?? FileStatus.Active,
    };

    await this.saveFileInfoFeed(fr, requestOptions);
    //TODO: verify, I think this is unnecessary Location is unchanged — restamp the caller-known absolute path (saveFileInfoFeed already
    // upserted the in-memory fileInfoList entry via uploadFileInfo.
    fr.path = record.path;

    this.emitter.emit(FileManagerEvents.FILE_UPDATED, { record: fr });

    return fr;
  }

  async getFileVersion(
    fr: FileRecord,
    version?: string | FeedIndex,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    const localHead = this.fileInfoList.find((f) => f.topic === fr.topic);

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
      throw new FileInfoError(`File feed not found for topic: ${fr.topic.slice(0, 6)}`);
    }

    return this.fetchFileInfo(topic.toString(), fr.actPublisher, feedData, requestOptions);
  }

  async restoreFileVersion(versionToRestore: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    const { feedIndex, feedIndexNext } = await getFeedData(
      this.bee,
      new Topic(versionToRestore.topic),
      versionToRestore.owner,
    );
    if (feedIndex.equals(FeedIndex.MINUS_ONE.toString())) {
      throw new FileInfoError('Record feed not found');
    }

    if (!versionToRestore.version) {
      throw new FileInfoError('Restore version has to be defined');
    }

    const versionToRestoreIndex = new FeedIndex(versionToRestore.version);
    if (feedIndex.equals(versionToRestoreIndex)) {
      throw new FileInfoError(
        `Head Slot cannot be restored. Please select a version lesser than: ${versionToRestore.version}`,
      );
    }

    // Restoring a version restores content, not location — keep the current tree position.
    // versionToRestore may come raw from getFileVersion (relative, unstamped path); the cached
    // entry carries the walk-derived absolute path.
    // TODO: if cached is not found -> split full path versionToRestore and only use the relative path/name
    const cached = this.fileInfoList.find((f) => f.topic === versionToRestore.topic);

    const restored: FileRecord = {
      ...versionToRestore,
      path: cached?.path ?? versionToRestore.path,
      version: feedIndexNext.toString(),
      content: {
        reference: versionToRestore.content.reference,
        historyRef: versionToRestore.content.historyRef,
      },
      timestamp: Date.now(),
    };

    await this.saveFileInfoFeed(restored, requestOptions);

    this.emitter.emit(FileManagerEvents.FILE_VERSION_RESTORED, {
      restored,
    });
  }

  private async uploadFileInfo(record: FileRecord, requestOptions?: BeeRequestOptions): Promise<ActReferences> {
    try {
      const topicStr = record.topic;
      let historyRef = this.fileInfoHistoryCache.get(topicStr);

      const uploadInfoRes = await this.bee.uploadData(
        record.batchId,
        JSON.stringify(record),
        {
          act: true,
          actHistoryAddress: historyRef,
          redundancyLevel: record.redundancyLevel,
        },
        requestOptions,
      );
      historyRef = uploadInfoRes.historyAddress.getOrThrow().toString();
      this.fileInfoHistoryCache.set(topicStr, historyRef);

      const existingIx = this.fileInfoList.findIndex((f) => f.topic === topicStr);
      if (existingIx !== -1) {
        this.fileInfoList[existingIx] = record;
      } else {
        this.fileInfoList.push(record);
      }

      return {
        reference: uploadInfoRes.reference.toString(),
        historyRef: historyRef,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      throw new FileInfoError(`Failed to save record: ${error.message || error}`);
    }
  }

  private async getMantarayNode(
    host: ManifestHost,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<MantarayNode> {
    const cached = this.nodeManifestCache.get(host.topic);
    if (cached) return cached;

    if (!host.manifestRef) {
      throw new DriveError(`Node ${host.topic} has no manifestRef — cannot load manifest`);
    }

    const raw = await this.bee.downloadData(
      host.manifestRef.reference,
      { actHistoryAddress: host.manifestRef.historyRef, actPublisher: publisher },
      requestOptions,
    );
    const mantaray = await loadMantaray(this.bee, new Reference(raw), undefined, requestOptions);

    this.nodeManifestCache.set(host.topic, mantaray);

    return mantaray;
  }

  private async saveMantarayNode(
    mantaray: MantarayNode,
    host: ManifestHost,
    requestOptions?: BeeRequestOptions,
  ): Promise<ActReferences> {
    const cachedIx = this.nodeFeedIndexCache.get(host.topic);

    const { contentRefs, newIndex } = await saveNodeManifest(
      this.bee,
      this.signer,
      mantaray,
      host,
      cachedIx,
      requestOptions,
    );
    this.nodeFeedIndexCache.set(host.topic, newIndex);

    return contentRefs;
  }

  private async saveFileInfoFeed(fr: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
    const fileInfoResult = await this.uploadFileInfo(fr, requestOptions);

    try {
      const fileInfoState = JSON.stringify({
        reference: fileInfoResult.reference,
        historyRef: fileInfoResult.historyRef,
      } as ActReferences);

      const fw = this.bee.makeFeedWriter(new Topic(fr.topic).toUint8Array(), this.signer, requestOptions);

      await fw.uploadPayload(fr.batchId, fileInfoState, {
        index: fr.version !== undefined ? new FeedIndex(fr.version) : undefined,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      throw new FileInfoError(`Failed to save wrapped record feed: ${error.message || error}`);
    }
  }

  private async fetchFileInfo(
    topic: string,
    actPublisher: string,
    feeData: FeedResultWithIndex,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    if (feeData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileInfoError(`File record not found for topic: ${topic.slice(0, 6)}`);
    }

    const contentRefs = feeData.payload.toJSON() as ActReferences;
    assertActReferences(contentRefs);

    const fileBytes = await this.bee.downloadData(
      contentRefs.reference,
      {
        actHistoryAddress: contentRefs.historyRef,
        actPublisher,
      },
      requestOptions,
    );

    const record = fileBytes.toJSON() as FileRecord;
    assertFileRecord(record);

    if (topic !== record.topic) {
      throw new FileInfoError(
        `Feed topic ${topic.slice(0, 6)} != record.topic ${record.topic.slice(0, 6)} for: ${record.path}`,
      );
    }

    // make sure that version tracks the actual feed index
    record.version = feeData.feedIndex.toString();
    this.fileInfoHistoryCache.set(topic, contentRefs.historyRef);

    return record;
  }

  private async setFileStatus(
    record: FileRecord,
    expectedStatus: FileStatus | undefined,
    newStatus: FileStatus,
    invalidStateMessage: string,
  ): Promise<FileRecord> {
    const fr = this.fileInfoList.find((f) => f.topic === record.topic);

    if (!fr) {
      throw new FileInfoError(`Corresponding File record does not exist: ${record.path}`);
    }

    if (expectedStatus !== undefined && fr.status !== expectedStatus) {
      throw new FileInfoError(`${invalidStateMessage}: ${record.path}`);
    }

    if (expectedStatus === undefined && fr.status === newStatus) {
      throw new FileInfoError(`${invalidStateMessage}: ${record.path}`);
    }

    if (fr.version === undefined) {
      throw new FileInfoError(`File version is undefined: ${record.path}`);
    }

    fr.version = new FeedIndex(fr.version).next().toString();
    fr.status = newStatus;
    fr.timestamp = new Date().getTime();
    fr.customMetadata = { ...(fr.customMetadata ?? {}), ...(record.customMetadata ?? {}) };

    await this.saveFileInfoFeed(fr);

    return fr;
  }

  async trashFile(record: FileRecord): Promise<void> {
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    const fr = await this.setFileStatus(record, undefined, FileStatus.Trashed, 'File already Trashed');
    this.emitter.emit(FileManagerEvents.FILE_TRASHED, { record: fr });
  }

  async recoverFile(record: FileRecord): Promise<void> {
    assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    const fr = await this.setFileStatus(
      record,
      FileStatus.Trashed,
      FileStatus.Active,
      'Non-Trashed files cannot be restored',
    );
    this.emitter.emit(FileManagerEvents.FILE_RECOVERED, { record: fr });
  }

  async forget(driveId: string | Identifier, path: string, requestOptions?: BeeRequestOptions): Promise<void> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(new Identifier(driveId).toString());

    if (!path || path === ROOT_PATH) {
      throw new DriveError('Cannot forget drive root');
    }

    const lastSlash = path.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? path.substring(0, lastSlash) : '';
    const name = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

    const parentFolder = await this.resolveFolder(cachedDrive, parentPath, publisher, requestOptions);
    const parentHost: ManifestHost = parentFolder ?? {
      owner: this.signerAddress,
      topic: cachedDrive.topic,
      manifestRef: cachedDrive.manifestRef,
      batchId: cachedDrive.batchId,
      redundancyLevel: cachedDrive.redundancyLevel,
      actPublisher: publisher,
    };
    const parentMantaray = await this.getMantarayNode(parentHost, publisher, requestOptions);

    const fork = parentMantaray.find(name);
    if (!fork) {
      throw new FileInfoError(`Path not found: ${path}`);
    }

    const meta = fork.metadata ?? {};
    const nodeType = meta[MANIFEST_METADATA_NODE_TYPE] as NodeType | undefined;
    const nodeTopic = meta[MANIFEST_METADATA_NODE_TOPIC];

    parentMantaray.removeFork(name);
    const newManifestRef = await this.saveMantarayNode(parentMantaray, parentHost, requestOptions);

    if (!parentFolder) {
      this.driveList[driveIx].manifestRef = newManifestRef;
    }

    if (nodeType === NodeType.Folder) {
      // TODO: folder status change (trash/recover for folders) — fork-metadata-based, not yet implemented
      if (nodeTopic) this.nodeManifestCache.delete(nodeTopic);
      const prefix = path.endsWith('/') ? path : path + '/';
      for (let i = this.fileInfoList.length - 1; i >= 0; --i) {
        const f = this.fileInfoList[i];
        if (f.driveId === cachedDrive.id && f.path.startsWith(prefix)) {
          this.fileInfoList.splice(i, 1);
        }
      }
      this.emitter.emit(FileManagerEvents.FOLDER_FORGOTTEN, { driveInfo: cachedDrive, path });
    } else {
      const fiIndex = this.fileInfoList.findIndex((f) => f.driveId === cachedDrive.id && f.path === path);

      const forgotten = fiIndex !== -1 ? this.fileInfoList[fiIndex] : undefined;
      if (fiIndex !== -1) {
        this.fileInfoList.splice(fiIndex, 1);
      }

      this.emitter.emit(FileManagerEvents.FILE_FORGOTTEN, { record: forgotten, path });
    }
  }

  private async fetchAndSetAdminStamp(batchId: string | BatchId, requestOptions?: BeeRequestOptions): Promise<void> {
    const adminStamp = await fetchStamp(this.bee, batchId, requestOptions);
    const logText = `Admin stamp with batchId: ${batchId.toString().slice(0, 6)}...`;

    if (!adminStamp) {
      this._adminStamp = undefined;
      console.warn(`${logText} not found.`);
      return;
    }
    if (adminStamp.usable) {
      console.debug(`${logText} found and set.`);
    } else {
      console.warn(`${logText} is unusable.`);
    }

    this._adminStamp = adminStamp;
  }

  async destroyDrive(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<void> {
    const { publisher, stateFeedTopic } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);

    const adminStamp = this.adminStamp;
    if (!adminStamp) {
      throw new StampError('Admin stamp not found');
    }

    const { driveIx, cachedDrive } = this.findDriveOrThrow(new Identifier(driveId).toString());

    if (cachedDrive.isAdmin || cachedDrive.batchId === adminStamp.batchID.toString()) {
      throw new DriveError(`Cannot destroy admin drive / stamp, batchId: ${cachedDrive.batchId.slice(0, 6)}`);
    }

    const fetchedStamp = await fetchStamp(this.bee, cachedDrive.batchId, requestOptions);
    const validStamp = verifyStampUsability(fetchedStamp, undefined, false);

    if (cachedDrive.batchId !== validStamp.batchID.toString()) {
      throw new StampError(
        `Stamp ${validStamp.batchID.toString().slice(0, 6)} does not match drive stamp ${cachedDrive.batchId.toString().slice(0, 6)}`,
      );
    }

    const ttlDays = validStamp.duration.toDays();
    const halvings = Math.floor(Math.log2(ttlDays));

    await this.bee.diluteBatch(cachedDrive.batchId, validStamp.depth + halvings, requestOptions);
    await this.pruneDriveMetadata(cachedDrive, driveIx, stateFeedTopic, publisher, requestOptions);

    console.debug(`Drive destroyed: ${cachedDrive.name}`);
    this.emitter.emit(FileManagerEvents.DRIVE_DESTROYED, { driveInfo: cachedDrive });
  }

  async forgetDrive(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<void> {
    const { publisher, stateFeedTopic } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(new Identifier(driveId).toString());

    if (cachedDrive.isAdmin) {
      throw new DriveError('Cannot forget admin drive');
    }

    await this.pruneDriveMetadata(cachedDrive, driveIx, stateFeedTopic, publisher, requestOptions);
    console.debug(`Drive forgotten (metadata only): ${cachedDrive.name}`);
    this.emitter.emit(FileManagerEvents.DRIVE_FORGOTTEN, { driveInfo: cachedDrive });
  }

  // eslint-disable-next-line require-await
  async getGrantees(_: FileRecord): Promise<GetGranteesResult> {
    throw new GranteeError('getGrantees: not yet implemented');
  }

  // eslint-disable-next-line require-await
  async subscribeToSharedInbox(_topic: string, _callback?: (_data: ShareItem) => void): Promise<void> {
    throw new SubscriptionError('subscribeToSharedInbox: not yet implemented');
  }

  unsubscribeFromSharedInbox(): void {
    throw new SubscriptionError('unsubscribeFromSharedInbox: not yet implemented');
  }

  // eslint-disable-next-line require-await
  async share(
    _fileInfo: FileRecord,
    _targetOverlays: string[],
    _recipients: string[],
    _message?: string,
  ): Promise<void> {
    throw new SendShareMessageError('share: not yet implemented');
  }

  async move(
    fromPath: string,
    toPath: string,
    sourceDriveId: string | Identifier,
    targetDriveId?: string | Identifier,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx: targetDriveIx, cachedDrive: cachedSource } = this.findDriveOrThrow(
      new Identifier(sourceDriveId).toString(),
    );

    if (!fromPath || fromPath === ROOT_PATH) {
      throw new DriveError('Cannot move root folder');
    }
    if (!toPath || toPath === ROOT_PATH) {
      throw new DriveError('Invalid destination path');
    }

    // TODO: sameParnet === !!sourceDriveId ?
    const isCrossDrive = !!targetDriveId && targetDriveId !== sourceDriveId;
    const effectiveTargetId = (targetDriveId ?? sourceDriveId).toString();

    let cachedTargetDrive: DriveInfo = cachedSource;
    if (targetDriveId) {
      const { cachedDrive } = this.findDriveOrThrow(new Identifier(targetDriveId).toString());
      cachedTargetDrive = cachedDrive;
    }

    if (!isCrossDrive && fromPath === toPath) {
      throw new DriveError('Source and destination paths are identical');
    }

    const srcLastSlash = fromPath.lastIndexOf('/');
    const srcParentPath = srcLastSlash > 0 ? fromPath.substring(0, srcLastSlash) : '';
    const srcName = srcLastSlash >= 0 ? fromPath.substring(srcLastSlash + 1) : fromPath;

    const tgtLastSlash = toPath.lastIndexOf('/');
    const tgtParentPath = tgtLastSlash > 0 ? toPath.substring(0, tgtLastSlash) : '';
    const tgtName = tgtLastSlash >= 0 ? toPath.substring(tgtLastSlash + 1) : toPath;

    const srcParentFolder = await this.resolveFolder(cachedSource, srcParentPath, publisher, requestOptions);
    const srcParentHost: ManifestHost = srcParentFolder ?? {
      owner: this.signerAddress,
      topic: cachedSource.topic,
      manifestRef: cachedSource.manifestRef,
      batchId: cachedSource.batchId,
      redundancyLevel: cachedSource.redundancyLevel,
      actPublisher: publisher,
    };
    // TODO: important! drivinfo shall also have a publisher and shall be passed on to each manifest get ! not always the node.address -> fm owner != shared drive publisher
    const sourceMantaray = await this.getMantarayNode(srcParentHost, publisher, requestOptions);

    const sourceFork = sourceMantaray.find(srcName);
    if (!sourceFork) {
      throw new DriveError(`Path not found: ${fromPath}`);
    }

    const forkMetadata = sourceFork.metadata ?? {};
    const isFile = !!forkMetadata[MANIFEST_METADATA_FILE_TOPIC];

    const tgtParentFolder = await this.resolveFolder(cachedTargetDrive, tgtParentPath, publisher, requestOptions);
    const tgtParentHost: ManifestHost = tgtParentFolder ?? {
      owner: this.signerAddress,
      topic: cachedTargetDrive.topic,
      manifestRef: cachedTargetDrive.manifestRef,
      batchId: cachedTargetDrive.batchId,
      redundancyLevel: cachedTargetDrive.redundancyLevel,
      actPublisher: publisher,
    };
    const sameParent = srcParentHost.topic === tgtParentHost.topic;
    const targetMantaray = sameParent
      ? sourceMantaray
      : await this.getMantarayNode(tgtParentHost, publisher, requestOptions);

    if (isFile) {
      const fileTopic = forkMetadata[MANIFEST_METADATA_FILE_TOPIC];
      if (!fileTopic) {
        throw new FileInfoError(`Fork at ${fromPath} has no file topic — cannot move`);
      }

      let fr = this.fileInfoList.find((f) => f.topic === fileTopic);
      // Lazy init - fetch it on demand.
      if (!fr) {
        // TODO: why feedindex / version is not tracked -> expensive lookup
        const feedData = await getFeedData(
          this.bee,
          new Topic(fileTopic),
          this.signerAddress,
          undefined,
          requestOptions,
        );

        if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
          throw new FileInfoError(`File feed not found for topic: ${fileTopic.slice(0, 6)}`);
        }

        this.nodeFeedIndexCache.set(fileTopic, feedData.feedIndexNext.toBigInt());

        fr = await this.fetchFileInfo(fileTopic, publisher, feedData, requestOptions);

        this.fileInfoList.push(fr);
      }

      // Persisted value is the relative filename — see FileRecord.path doc comment.
      fr.path = tgtName;
      if (isCrossDrive) {
        fr.driveId = effectiveTargetId;
      }

      const newVersion = fr.version !== undefined ? new FeedIndex(fr.version) : FEED_INDEX_ZERO;
      fr.version = newVersion.next().toString();

      await this.saveFileInfoFeed(fr, requestOptions);
      // In-memory copy is stamped with the caller-known absolute destination — no walk needed here.
      fr.path = toPath;
    }

    const updatedMetadata: Record<string, string> = { ...forkMetadata };

    sourceMantaray.removeFork(srcName);
    if (sameParent) {
      sourceMantaray.addFork(tgtName, sourceFork.targetAddress, updatedMetadata);
    } else {
      targetMantaray.addFork(tgtName, sourceFork.targetAddress, updatedMetadata);
    }

    const newSrcManifestRef = await this.saveMantarayNode(sourceMantaray, srcParentHost, requestOptions);

    if (!srcParentFolder) {
      this.driveList[targetDriveIx].manifestRef = newSrcManifestRef;
    }

    if (!sameParent && targetDriveIx) {
      const newTgtManifestRef = await this.saveMantarayNode(targetMantaray, tgtParentHost, requestOptions);

      if (!tgtParentFolder) {
        this.driveList[targetDriveIx].manifestRef = newTgtManifestRef;
      }
    }

    if (!isFile) {
      // Folder move only relocates the folder's own fork — nothing on Swarm claims an absolute
      // position anymore, so descendants need no re-upload. Just re-stamp the in-memory cache
      // (nodeManifestCache/nodeFeedIndexCache are keyed by topic, not path — untouched).
      const fromPrefix = fromPath + '/';
      const toPrefix = toPath + '/';
      for (const f of this.fileInfoList) {
        if (f.driveId === sourceDriveId.toString() && f.path.startsWith(fromPrefix)) {
          f.path = toPrefix + f.path.substring(fromPrefix.length);
          if (isCrossDrive) {
            f.driveId = effectiveTargetId;
          }
        }
      }
    }

    this.emitter.emit(FileManagerEvents.FILE_MOVED, { fromPath, toPath });
  }

  private async resolveFolder(
    driveInfo: DriveInfo,
    path: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo | null> {
    if (!path || path === ROOT_PATH) return null;

    const segments = path.split('/').filter(Boolean);
    const driveHost: ManifestHost = {
      owner: this.signerAddress,
      topic: driveInfo.topic,
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
      actPublisher: driveInfo.actPublisher,
    };

    let currentMantaray = await this.getMantarayNode(driveHost, publisher, requestOptions);
    let currentPath = '';
    let currentFolderInfo: FolderInfo | null = null;

    for (const segment of segments) {
      currentPath += '/' + segment;
      const fork = currentMantaray.find(segment);
      if (!fork) {
        throw new DriveError(`Path not found: ${currentPath}`);
      }

      const meta = fork.metadata ?? {};
      if (meta[MANIFEST_METADATA_NODE_TYPE] !== NodeType.Folder) {
        throw new DriveError(`Path is not a folder: ${currentPath}`);
      }

      const folderTopic = meta[MANIFEST_METADATA_NODE_TOPIC];
      if (!folderTopic) {
        throw new FileInfoError(`Folder fork missing topic: ${currentPath}`);
      }
      // TODO: is this call here efficient and indeed necessary + version - review
      const {
        payload: folderPayload,
        feedIndex: folderFeedIndex,
        feedIndexNext: folderFeedIndexNext,
      } = await getFeedData(this.bee, new Topic(folderTopic), this.signerAddress, undefined, requestOptions);
      if (folderFeedIndex.equals(FeedIndex.MINUS_ONE)) {
        throw new DriveError(`Folder feed not found for path: ${currentPath}`);
      }
      const folderManifestRef: ActReferences = folderPayload.toJSON() as ActReferences;
      assertActReferences(folderManifestRef);

      this.nodeFeedIndexCache.set(folderTopic, folderFeedIndexNext.toBigInt());

      currentFolderInfo = {
        owner: this.signerAddress,
        topic: folderTopic,
        manifestRef: folderManifestRef,
        batchId: driveInfo.batchId,
        redundancyLevel: meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]
          ? (parseInt(meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]) as RedundancyLevel)
          : driveInfo.redundancyLevel,
        path: currentPath,
        driveId: driveInfo.id,
        actPublisher: publisher,
      };

      currentMantaray = await this.getMantarayNode(currentFolderInfo, publisher, requestOptions);
    }

    return currentFolderInfo;
  }

  private async createFolderNode(
    driveInfo: DriveInfo,
    parentHost: ManifestHost,
    parentPath: string,
    folderName: string,
    publisher: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo> {
    const effectiveRedundancy = redundancyLevel ?? parentHost.redundancyLevel;

    const newFolderTopic = new Topic(generateRandomBytes(Topic.LENGTH)).toString();
    const emptyMantaray = new MantarayNode();

    const saveResult = await emptyMantaray.saveRecursively(this.bee, driveInfo.batchId, { act: false }, requestOptions);
    const manifestUpload = await this.bee.uploadData(
      driveInfo.batchId,
      saveResult.reference.toUint8Array(),
      { act: true, redundancyLevel: effectiveRedundancy },
      requestOptions,
    );
    const newFolderManifestRef: ActReferences = {
      reference: manifestUpload.reference.toString(),
      historyRef: manifestUpload.historyAddress.getOrThrow().toString(),
    };

    const fw = this.bee.makeFeedWriter(new Topic(newFolderTopic).toUint8Array(), this.signer, requestOptions);
    await fw.uploadPayload(driveInfo.batchId, JSON.stringify(newFolderManifestRef), { index: FEED_INDEX_ZERO });

    const folderInfo: FolderInfo = {
      owner: this.signerAddress,
      topic: newFolderTopic,
      manifestRef: newFolderManifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: effectiveRedundancy,
      path: (parentPath === ROOT_PATH || !parentPath ? '' : parentPath) + '/' + folderName,
      driveId: driveInfo.id,
      actPublisher: publisher,
    };

    this.nodeManifestCache.set(newFolderTopic, emptyMantaray);
    this.nodeFeedIndexCache.set(newFolderTopic, 1n);

    const parentMantaray = await this.getMantarayNode(parentHost, publisher, requestOptions);

    parentMantaray.addFork(folderName, new Reference(newFolderTopic), {
      [MANIFEST_METADATA_NODE_TOPIC]: newFolderTopic,
      [MANIFEST_METADATA_NODE_TYPE]: NodeType.Folder,
      [MANIFEST_METADATA_REDUNDANCY_LEVEL]: effectiveRedundancy.toString(),
    });

    return folderInfo;
  }

  async createFolder(
    driveId: string | Identifier,
    parentPath: string,
    folderName: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo> {
    requestOptions?.signal?.throwIfAborted();
    const { publisher } = assertReady(this.publisher, this.isInitialized, this.stateFeedTopic);
    const { driveIx, cachedDrive } = this.findDriveOrThrow(new Identifier(driveId).toString());

    if (!folderName || folderName.includes('/')) {
      throw new DriveError(`Invalid folder name ${folderName}`);
    }

    const parentFolder = await this.resolveFolder(cachedDrive, parentPath, publisher, requestOptions);
    const parentHost: ManifestHost = parentFolder ?? {
      owner: this.signerAddress,
      topic: cachedDrive.topic,
      manifestRef: cachedDrive.manifestRef,
      batchId: cachedDrive.batchId,
      redundancyLevel: cachedDrive.redundancyLevel,
      actPublisher: publisher,
    };

    const folderInfo = await this.createFolderNode(
      cachedDrive,
      parentHost,
      parentPath,
      folderName,
      publisher,
      redundancyLevel,
      requestOptions,
    );

    const parentMantaray = await this.getMantarayNode(parentHost, publisher, requestOptions);
    const updatedParentManifestRef = await this.saveMantarayNode(parentMantaray, parentHost, requestOptions);

    if (!parentFolder) {
      this.driveList[driveIx].manifestRef = updatedParentManifestRef;
    }

    return folderInfo;
  }

  private findDriveOrThrow(driveId: string): { driveIx: number; cachedDrive: DriveInfo } {
    const driveIx = this.driveList.findIndex((d) => d.id === driveId);

    if (driveIx == -1) {
      throw new DriveError(`Drive with id ${driveId.slice(0, 6)} not found`);
    }

    const cachedDrive = this.driveList[driveIx];

    return { driveIx, cachedDrive };
  }
}
