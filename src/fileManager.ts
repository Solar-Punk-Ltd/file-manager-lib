import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  DownloadOptions,
  EthAddress,
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

import { FeedResultWithIndex, ListDepth, NodeType, ReferenceWithHistory, StateTopicInfo } from './types/utils';
import { assertFileRecord, assertStateTopicInfo, driveInfoFromMetadata } from './utils/asserts';
import { fetchStamp, getFeedData } from './utils/bee';
import { awaitAllPromisesBounded, joinPath, settlePromises, verifyStampUsability } from './utils/common';
import {
  DRIVE_FORK_PREFIX,
  FEED_INDEX_ZERO,
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
import { DirectoryEntry, getAllNodeEntries, loadMantaray } from './utils/mantaray';
import { processDownload } from './download';
import { EventEmitter, EventEmitterBase } from './eventEmitter';
import {
  BrowserUploadOptions,
  DownloadResource,
  DownloadResult,
  DriveInfo,
  FileInfoOptions,
  FileManager,
  FileRecord,
  FileStatus,
  FolderInfo,
  ManifestHost,
  NodeUploadOptions,
  ShareItem,
  UploadFilesEntry,
  UploadFilesResult,
} from './types';
import { assertUploadableSource, processUpload } from './upload';
import {
  ADMIN_STAMP_LABEL,
  BeeVersionError,
  DriveError,
  FileInfoError,
  FILEMANAGER_STATE_TOPIC,
  FileManagerEvents,
  GranteeError,
  SendShareMessageError,
  SignerError,
  StampError,
  SubscriptionError,
} from './utils';

export class FileManagerBase implements FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private signerAddress: string;
  private publisher: PublicKey | undefined = undefined;
  private stateFeedTopic: Topic | undefined = undefined;
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private _adminStamp: PostageBatch | undefined = undefined;
  private nodeManifestCache: Map<string, MantarayNode> = new Map();
  private nodeFeedIndexCache: Map<string, bigint> = new Map();
  private adminManifestRef: ReferenceWithHistory | undefined = undefined;
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

      // File records are loaded lazily via listFolder / download / move as the user navigates — no eager full-drive load at init.
      const success = await this.tryToFetchAdminState();
      if (success) {
        await this.initDriveList();
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

    const { payload, feedIndex } = await getFeedData(this.bee, FILEMANAGER_STATE_TOPIC, this.signerAddress);

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

  private async createAdminManifest(
    batchId: string,
    resetState?: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    // Re-fetch feed data every time — the admin stamp may expire while state is cached.
    // Deliberately write to the fetched feedIndexNext so a stale cache can't clobber a slot;
    // ideally this is index 0 on a fresh account.
    const { feedIndexNext } = await getFeedData(this.bee, FILEMANAGER_STATE_TOPIC, this.signerAddress);
    const isStateExisting = !feedIndexNext.equals(FEED_INDEX_ZERO);
    // TODO: verify that this.adminManifestRef is undefined unless resetState:
    // if (this.adminManifestRef && !resetState) {
    //   throw new DriveError('Admin manifest already set');
    // }
    if (!resetState && isStateExisting) {
      throw new DriveError('Admin state already exists. Pass resetState=true to overwrite.');
    }

    const randomTopic = generateRandomBytes(Topic.LENGTH);
    const newStateFeedTopic = new Topic(randomTopic);
    // TODO: shouldn't the act history address be reused ? -> use the same root admin ACT
    const topicUploadRes = await this.bee.uploadData(
      batchId,
      newStateFeedTopic.toUint8Array(),
      { act: true },
      requestOptions,
    );
    const topicState: StateTopicInfo = {
      topicReference: topicUploadRes.reference.toString(),
      historyAddress: topicUploadRes.historyAddress.getOrThrow().toString(),
    };
    const statefw = this.bee.makeFeedWriter(FILEMANAGER_STATE_TOPIC.toUint8Array(), this.signer);
    await statefw.uploadPayload(batchId, JSON.stringify(topicState), { index: feedIndexNext });

    this.stateFeedTopic = newStateFeedTopic;

    const emptyAdminMantaray = new MantarayNode();
    const saveResult = await emptyAdminMantaray.saveRecursively(this.bee, batchId, { act: false }, requestOptions);
    const manifestUpload = await this.bee.uploadData(
      batchId,
      saveResult.reference.toUint8Array(),
      { act: true },
      requestOptions,
    );
    const adminManifestRef: ReferenceWithHistory = {
      reference: manifestUpload.reference.toString(),
      historyRef: manifestUpload.historyAddress.getOrThrow().toString(),
    };
    this.adminManifestRef = adminManifestRef;

    const adminfw = this.bee.makeFeedWriter(this.stateFeedTopic.toUint8Array(), this.signer);
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

    const { payload, feedIndex, feedIndexNext } = await getFeedData(this.bee, this.stateFeedTopic, this.signerAddress);

    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      console.debug('Admin manifest feed empty — no drives to load');
      return;
    }

    this.nodeFeedIndexCache.set(this.stateFeedTopic.toString(), feedIndexNext.toBigInt());

    const adminManifestRef: ReferenceWithHistory = payload.toJSON() as ReferenceWithHistory;
    this.adminManifestRef = adminManifestRef;

    const adminManifestRaw = await this.bee.downloadData(adminManifestRef.reference, {
      actHistoryAddress: adminManifestRef.historyRef,
      actPublisher: this.publisher,
    });
    const adminMantaray = await loadMantaray(
      this.bee,
      new Reference(adminManifestRaw.toUint8Array()).toString(),
      undefined,
      requestOptions,
    );
    this.nodeManifestCache.set(this.stateFeedTopic.toString(), adminMantaray);

    const entries = getAllNodeEntries(adminMantaray).filter((e) => e.type === NodeType.Drive);

    await settlePromises(
      entries.map(async (entry) => {
        const driveInfo = driveInfoFromMetadata(entry.rawMetadata);

        const {
          payload: drivePayload,
          feedIndex: driveFeedIndex,
          feedIndexNext: driveFeedIndexNext,
        } = await getFeedData(this.bee, new Topic(driveInfo.driveFeedTopic.toString()), this.signerAddress);

        if (driveFeedIndex.equals(FeedIndex.MINUS_ONE)) {
          console.warn(
            `initDriveList: drive ${driveInfo.name} (${driveInfo.id}) has no manifest feed — skipping corrupt/incomplete drive`,
          );
          return;
        }
        // TODO: should this be called after driveInfo.isAdmin check ?
        driveInfo.manifestRef = drivePayload.toJSON() as ReferenceWithHistory;
        this.nodeFeedIndexCache.set(driveInfo.driveFeedTopic.toString(), driveFeedIndexNext.toBigInt());

        if (driveInfo.isAdmin) {
          await this.fetchAndSetAdminStamp(driveInfo.batchId, requestOptions);

          try {
            verifyStampUsability(this._adminStamp, driveInfo.batchId.toString());
          } catch (error) {
            this.emitter.emit(FileManagerEvents.STATE_INVALID, true);
            throw error;
          }
          // TODO: this.adminManifestRef setting vs driveInfo.manifestRef ?
          this.adminRedundancyLevel = driveInfo.redundancyLevel;
        }

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

  private async pruneDriveMetadata(driveInfo: DriveInfo, requestOptions?: BeeRequestOptions): Promise<void> {
    if (!this.adminManifestRef) {
      throw new DriveError('Admin manifest not set');
    }

    const driveIx = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
    const stateTopic = this.stateFeedTopic;

    if (driveIx === -1) {
      throw new DriveError(`Drive ${driveInfo.name} not found`);
    }
    if (!stateTopic) {
      throw new DriveError('Admin state not initialized');
    }
    if (!this._adminStamp) {
      throw new DriveError('Admin stamp not found');
    }

    const adminHost: ManifestHost = {
      topic: stateTopic.toString(),
      manifestRef: this.adminManifestRef,
      batchId: this._adminStamp.batchID,
      redundancyLevel: this.adminRedundancyLevel,
    };

    const adminMantaray = this.nodeManifestCache.get(stateTopic.toString());
    if (!adminMantaray) {
      throw new DriveError('Admin manifest not loaded — initialize first.');
    }

    adminMantaray.removeFork(`${DRIVE_FORK_PREFIX}-${driveInfo.id.toString()}`);
    const newAdminManifestRef = await this.saveNodeManifest(adminMantaray, adminHost, requestOptions);
    this.adminManifestRef = newAdminManifestRef;

    this.driveList.splice(driveIx, 1);
    this.nodeFeedIndexCache.delete(driveInfo.driveFeedTopic.toString());
    this.nodeManifestCache.delete(driveInfo.driveFeedTopic.toString());

    for (let i = this.fileInfoList.length - 1; i >= 0; --i) {
      if (this.fileInfoList[i].driveId === driveInfo.id.toString()) {
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
  ): Promise<void> {
    requestOptions?.signal?.throwIfAborted();

    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized.');
    }

    let driveName = name;
    if (isAdmin) {
      console.debug('Creating admin drive with name: ', ADMIN_STAMP_LABEL);
      driveName = ADMIN_STAMP_LABEL;

      await this.fetchAndSetAdminStamp(batchId.toString(), requestOptions);
      verifyStampUsability(this._adminStamp, batchId.toString()).batchID.toString();
      await this.createAdminManifest(batchId.toString(), resetState, requestOptions);
    } else {
      const fetchedStamp = await fetchStamp(this.bee, batchId);
      verifyStampUsability(fetchedStamp, batchId.toString()).batchID.toString();
    }

    if (!this._adminStamp) {
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
        if (isAdmin && (d.isAdmin || this.adminStamp)) {
          throw new DriveError('Admin drive already exists');
        }

        if (d.name === driveName || d.batchId.toString() === batchId.toString()) {
          throw new DriveError(`Drive with name "${driveName}" or batchId "${batchId}" already exists`);
        }
      });
    }

    const randomId = generateRandomBytes(Identifier.LENGTH);
    const driveInfo: DriveInfo = {
      id: new Identifier(randomId).toString(),
      name: driveName,
      batchId: batchId.toString(),
      owner: this.signerAddress,
      redundancyLevel: redundancyLevel ?? RedundancyLevel.OFF,
      driveFeedTopic: new Topic(generateRandomBytes(Topic.LENGTH)).toString(),
      isAdmin,
    };
    this.driveList.push(driveInfo);
    // TODO: shouldn't the act history address be reused ? -> use the same root drive ACT
    // TODO: empty mantaray save makes no sense ? drivename at least? -> always creates the same hash ?
    const emptyMantaray = new MantarayNode();
    const saveResult = await emptyMantaray.saveRecursively(this.bee, driveInfo.batchId, { act: false }, requestOptions);
    const manifestUpload = await this.bee.uploadData(
      driveInfo.batchId,
      saveResult.reference.toUint8Array(),
      { act: true, redundancyLevel: driveInfo.redundancyLevel },
      requestOptions,
    );

    driveInfo.manifestRef = {
      reference: manifestUpload.reference.toString(),
      historyRef: manifestUpload.historyAddress.getOrThrow().toString(),
    };
    const fw = this.bee.makeFeedWriter(new Topic(driveInfo.driveFeedTopic).toUint8Array(), this.signer);
    await fw.uploadPayload(driveInfo.batchId, JSON.stringify(driveInfo.manifestRef), { index: FEED_INDEX_ZERO });

    this.nodeManifestCache.set(driveInfo.driveFeedTopic.toString(), emptyMantaray);
    this.nodeFeedIndexCache.set(driveInfo.driveFeedTopic.toString(), 1n);

    if (!this.adminManifestRef) {
      throw new DriveError('Admin manifest not set');
    }

    const stateTopic = this.stateFeedTopic;
    if (!stateTopic) {
      throw new DriveError('Admin state not initialized');
    }

    const adminHost: ManifestHost = {
      topic: stateTopic.toString(),
      manifestRef: this.adminManifestRef,
      batchId: this._adminStamp.batchID.toString(),
      redundancyLevel: this.adminRedundancyLevel,
    };

    const adminMantaray = this.nodeManifestCache.get(stateTopic.toString());
    if (!adminMantaray) {
      throw new DriveError('Admin manifest not loaded — initialize first.');
    }

    adminMantaray.addFork(
      `${DRIVE_FORK_PREFIX}-${driveInfo.id.toString()}`,
      new Reference(driveInfo.driveFeedTopic.toString()),
      {
        [MANIFEST_METADATA_NODE_TOPIC]: driveInfo.driveFeedTopic.toString(),
        [MANIFEST_METADATA_NODE_TYPE]: NodeType.Drive,
        [MANIFEST_METADATA_DRIVE_ID]: driveInfo.id.toString(),
        [MANIFEST_METADATA_DRIVE_NAME]: driveInfo.name,
        [MANIFEST_METADATA_DRIVE_OWNER]: driveInfo.owner.toString(),
        [MANIFEST_METADATA_DRIVE_IS_ADMIN]: driveInfo.isAdmin.toString(),
        [MANIFEST_METADATA_DRIVE_BATCH_ID]: driveInfo.batchId.toString(),
        [MANIFEST_METADATA_REDUNDANCY_LEVEL]: driveInfo.redundancyLevel.toString(),
      },
    );
    const newAdminManifestRef = await this.saveNodeManifest(adminMantaray, adminHost, requestOptions);
    this.adminManifestRef = newAdminManifestRef;

    this.emitter.emit(FileManagerEvents.DRIVE_CREATED, { driveInfo });
  }

  async listFolder(
    driveInfo: DriveInfo,
    path: string,
    depth: ListDepth = ListDepth.Shallow,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<DirectoryEntry[]> {
    requestOptions?.signal?.throwIfAborted();

    const startFolder = await this.resolveFolder(driveInfo, path, requestOptions);
    const startHost: ManifestHost = startFolder ?? {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };
    const startBasePath = path.split('/').filter(Boolean).join('/');

    // TODO: MAX_SAFE_INTEGER seems wrong here
    const results: DirectoryEntry[] = [];
    // TODO: typed frontier
    let frontier: { host: ManifestHost; basePath: string }[] = [{ host: startHost, basePath: startBasePath }];
    let level = 0;
    const depthLimit = depth === ListDepth.Deep ? (maxDepth ?? Number.MAX_SAFE_INTEGER) : 1;
    // Per BFS level: (1) expand current frontier manifests, (2) load file feeds found, (3) resolve folder feeds into next frontier. Each phase is concurrency-bounded.
    while (frontier.length > 0 && level < depthLimit) {
      requestOptions?.signal?.throwIfAborted();

      const levelEntries: DirectoryEntry[] = [];

      await awaitAllPromisesBounded(
        frontier.map((item) => async (): Promise<DirectoryEntry[]> => {
          const mantaray = await this.getNodeManifest(item.host, requestOptions);

          return getAllNodeEntries(mantaray).map((e) => ({ ...e, path: joinPath(item.basePath, e.path) }));
        }),
        MAX_CONCURRENT_FEED_FETCHES,
        (entries) => levelEntries.push(...entries),
        (reason) => {
          if (requestOptions?.signal?.aborted) return;
          console.error(`listFolder: failed to expand manifest: ${reason}`);
        },
      );

      results.push(...levelEntries);
      // TODO: throw if publisher is not present
      const publisher = this.publisher;
      if (publisher) {
        const newFileEntries = levelEntries.filter(
          (e) => e.type === NodeType.File && !this.fileInfoList.some((f) => f.topic.toString() === e.topic),
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

            const fi = await this.fetchFileInfo(e.topic, publisher.toCompressedHex(), feedData, requestOptions);

            // In-memory copy is stamped with the path composed while walking — mirrors the
            // existing version stamp in fetchFileInfo.
            fi.path = e.path;

            return fi;
          }),
          MAX_CONCURRENT_FEED_FETCHES,
          (fi) => this.fileInfoList.push(fi),
          (reason, ix) => {
            if (requestOptions?.signal?.aborted) return;

            console.error(`listFolder: failed to load file ${newFileEntries[ix].topic}: ${reason}`);
          },
        );
      }

      if (depth === ListDepth.Shallow) break;

      const folderEntries = levelEntries.filter((e) => e.type === NodeType.Folder);
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

          const manifestRef: ReferenceWithHistory = payload.toJSON() as ReferenceWithHistory;
          this.nodeFeedIndexCache.set(e.topic, feedIndexNext.toBigInt());

          return {
            host: {
              topic: e.topic,
              manifestRef,
              batchId: driveInfo.batchId,
              redundancyLevel: driveInfo.redundancyLevel,
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

      frontier = nextFrontier;
      level++;
    }

    requestOptions?.signal?.throwIfAborted();

    return results;
  }

  // Download an entire folder subtree of a drive: resolves the subtree's records fresh (hydrating
  // via listFolder), then fetches them. path '' (default) = the whole drive.
  async downloadFolder(
    driveInfo: DriveInfo,
    path: string = '',
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult[]> {
    requestOptions?.signal?.throwIfAborted();

    await this.listFolder(driveInfo, path, ListDepth.Deep, undefined, requestOptions);

    const normalized = path.split('/').filter(Boolean).join('/');
    const prefix = normalized ? normalized + '/' : '';
    const files = this.fileInfoList.filter((f) => f.driveId === driveInfo.id.toString() && f.path.startsWith(prefix));

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

    if (fileRecords.length === 0) return [];

    const resources: DownloadResource[] = fileRecords.map((fi) => ({
      path: fi.path,
      reference: fi.fileRefAndHistory.reference.toString(),
      actHistoryAddress: fi.fileRefAndHistory.historyRef.toString(),
      actPublisher: new PublicKey(fi.actPublisher).toCompressedHex(),
    }));

    return await processDownload(this.bee, resources, options, requestOptions);
  }

  // Shared entry-guard triple used by the mutating public methods. `driveInfo` optionally adds the
  // drive-in-list check; `requirePublisher` allows methods that don't currently gate on a publisher
  // to opt out (behaviour-preserving during the incremental refactor).
  private assertReady(
    driveInfo?: DriveInfo,
    requestOptions?: BeeRequestOptions,
    requirePublisher: boolean = true,
  ): void {
    requestOptions?.signal?.throwIfAborted();
    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized');
    }
    if (requirePublisher && !this.publisher) {
      throw new SignerError('Publisher not found');
    }
    if (driveInfo) {
      const exists = this.driveList.some((d) => d.id.toString() === driveInfo.id.toString());
      if (!exists) {
        throw new FileInfoError(`Drive ${driveInfo.name} with id ${driveInfo.id.toString()} not found`);
      }
    }
  }

  // Upload a single file's bytes and ACT-wrap them, returning the content reference + history.
  // The two-step raw-upload → ACT-wrap sequence lives inside processUpload's platform impls
  // (upload.browser.ts / upload.node.ts); this helper only encapsulates the processUpload call
  // so uploadFile() and uploadFiles()'s Phase 3 share one invocation shape.
  private async uploadFileContent(
    driveInfo: DriveInfo,
    fileOptions: FileInfoOptions,
    redundancyLevel: RedundancyLevel,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    return await processUpload(this.bee, driveInfo, fileOptions, uploadOptions, redundancyLevel, requestOptions);
  }

  // In-memory only: add a file fork to a mantaray with the standard file metadata keys.
  // Does NOT save the manifest — save orchestration stays with each caller (inline for upload,
  // batched in uploadFiles Phase 4).
  private addFileToManifest(mantaray: MantarayNode, filename: string, fileTopic: string): void {
    mantaray.addFork(filename, new Reference(fileTopic), {
      [MANIFEST_METADATA_FILE_TOPIC]: fileTopic,
      [MANIFEST_METADATA_NODE_TOPIC]: fileTopic,
      [MANIFEST_METADATA_NODE_TYPE]: NodeType.File,
    });
  }

  // TODO: maybe use FileUploadOptions contenttype and size or drop it
  // TODO: now rLevel is derived from tha parent folder/ drive -> default to it and potentially overwrite it
  // uploadFile() is strictly for NEW files: it mints a fresh feed topic and adds a new fork to the drive
  // manifest. To re-version (new bytes) or change metadata of an EXISTING file, use updateFile() — it
  // reuses the file's topic, writes a new feed slot, and never touches the manifest.
  //
  // Entry-check-only abort: assertReady() is the single abort checkpoint; once the upload/save
  // sequence starts it runs to completion (a completed file is a valid standalone node).
  async uploadFile(
    driveInfo: DriveInfo,
    fileOptions: FileInfoOptions,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    this.assertReady(driveInfo, requestOptions);

    // stateFeedTopic / publisher kept inline for type-narrowing (assertReady checks them but does
    // not assert on `this`).
    if (!this.stateFeedTopic) {
      throw new DriveError('FileManager is not initialized.');
    }
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    await assertUploadableSource(fileOptions);

    // Resolve the parent folder up front so the new fork inherits the parent's redundancy level.
    const lastSlash = fileOptions.path.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? fileOptions.path.substring(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? fileOptions.path.substring(lastSlash + 1) : fileOptions.path;

    const parentFolder = await this.resolveFolder(driveInfo, parentPath, requestOptions);
    const targetHost: ManifestHost = parentFolder ?? {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };

    const owner = this.signerAddress;
    // No topic arg → fresh topic + version 0.
    const { topic, version } = await this.getTopicAndVersion(owner);

    const fileWrapper = await this.uploadFileContent(
      driveInfo,
      fileOptions,
      targetHost.redundancyLevel,
      uploadOptions,
      requestOptions,
    );
    const fileInfo: FileRecord = {
      batchId: driveInfo.batchId.toString(),
      owner,
      topic,
      // Persisted value is the relative filename — see FileRecord.path doc comment.
      path: filename,
      actPublisher: this.publisher.toCompressedHex(),
      fileRefAndHistory: fileWrapper,
      driveId: driveInfo.id.toString(),
      timestamp: new Date().getTime(),
      shared: false,
      version,
      customMetadata: fileOptions.customMetadata,
      redundancyLevel: targetHost.redundancyLevel,
      status: FileStatus.Active,
    };

    await this.saveFileInfoFeed(fileInfo, requestOptions);
    // In-memory copy is stamped with the caller-known absolute path — no walk needed here.
    fileInfo.path = fileOptions.path;

    const mantaray = await this.getNodeManifest(targetHost, requestOptions);

    this.addFileToManifest(mantaray, filename, topic);

    const newManifestRef = await this.saveNodeManifest(mantaray, targetHost, requestOptions);

    if (!parentFolder) {
      const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());

      if (driveIndex !== -1) {
        this.driveList[driveIndex].manifestRef = newManifestRef;
      }
    }

    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { fileInfo });
  }

  // updateFile() re-versions or changes metadata of an EXISTING file the caller already holds as a
  // FileRecord. Everything derives from `record` (topic, actPublisher, redundancyLevel, current
  // version, and — the single source of truth for ACT-history continuation — fileRefAndHistory).
  //
  // `changes.source` present = new bytes (a browser File, or a node filesystem path — mirroring
  // UploadFilesEntry.source); absent = metadata-only (reuse the existing content ref verbatim).
  // updateFile() never renames and never touches the manifest — the fork stays at record.path. Renames
  // go through move().
  //
  // Entry-check-only abort, same as uploadFile().
  async updateFile(
    driveInfo: DriveInfo,
    record: FileRecord,
    changes: { source?: File | string; customMetadata?: Record<string, string> },
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    this.assertReady(driveInfo, requestOptions);

    if (!this.stateFeedTopic) {
      throw new DriveError('FileManager is not initialized.');
    }
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const owner = this.signerAddress;
    // Topic arg + no version → bump to the next feed slot (same increment path upload's re-version
    // branch used).
    const { topic, version } = await this.getTopicAndVersion(owner, record.topic);

    const mergedMetadata = changes.customMetadata
      ? { ...record.customMetadata, ...changes.customMetadata }
      : record.customMetadata;

    let fileWrapper: ReferenceWithHistory;
    if (changes.source !== undefined) {
      // New bytes: continue the file's ACT history from record.fileRefAndHistory.historyRef (the
      // single source of truth). Build a new-content fileOptions (no topic/fileRefAndHistory, so
      // uploadFileContent actually uploads instead of short-circuiting on the reuse shortcut).
      const contentUploadOptions = {
        ...uploadOptions,
        actHistoryAddress: record.fileRefAndHistory.historyRef.toString(),
      };
      const fileOptions: FileInfoOptions =
        typeof changes.source === 'string'
          ? ({ path: changes.source } as NodeUploadOptions as FileInfoOptions)
          : ({ path: record.path, file: changes.source } as BrowserUploadOptions as FileInfoOptions);

      fileWrapper = await this.uploadFileContent(
        driveInfo,
        fileOptions,
        record.redundancyLevel ?? driveInfo.redundancyLevel,
        contentUploadOptions,
        requestOptions,
      );
    } else {
      // Metadata-only: reuse the existing content ref verbatim, no bytes uploaded.
      fileWrapper = record.fileRefAndHistory;
    }

    const fileInfo: FileRecord = {
      batchId: record.batchId.toString(),
      owner,
      topic,
      // Copied verbatim — update never renames; the manifest fork key stays authoritative and the
      // walkers re-derive path from it on hydration, so no split/reassembly here.
      path: record.path,
      actPublisher: new PublicKey(record.actPublisher).toCompressedHex(),
      fileRefAndHistory: fileWrapper,
      driveId: record.driveId,
      timestamp: new Date().getTime(),
      shared: record.shared ?? false,
      version,
      customMetadata: mergedMetadata,
      redundancyLevel: record.redundancyLevel,
      status: record.status ?? FileStatus.Active,
    };

    await this.saveFileInfoFeed(fileInfo, requestOptions);
    // Location is unchanged — restamp the caller-known absolute path (saveFileInfoFeed already
    // upserted the in-memory fileInfoList entry via uploadFileInfo).
    fileInfo.path = record.path;

    this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { fileInfo });
  }

  async uploadFiles(
    driveInfo: DriveInfo,
    entries: UploadFilesEntry[],
    destinationPath: string = '',
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<UploadFilesResult> {
    // Phase 0 — guards. Reject immediately if already aborted before any work starts.
    requestOptions?.signal?.throwIfAborted();

    if (!this.stateFeedTopic || !this.isInitialized) {
      throw new DriveError('FileManager is not initialized.');
    }
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
    if (driveIndex === -1) {
      throw new FileInfoError(`Drive ${driveInfo.name} with id ${driveInfo.id.toString()} not found`);
    }

    if (!entries.length) {
      throw new FileInfoError('uploadFiles requires at least one entry');
    }

    for (const entry of entries) {
      const rp = entry.relativePath;
      if (!rp || rp.startsWith('/') || rp.includes('..') || rp.endsWith('/')) {
        throw new FileInfoError(`Invalid relativePath: "${rp}"`);
      }
    }

    // Phase 1 — plan (no writes). Resolve the destination once (throws if invalid — correct
    // fail-fast), then walk the new hierarchy top-down classifying each needed folder path as
    // existing / missing / conflict before any write happens.
    const segmentsOf = (p: string): string[] => p.split('/').filter(Boolean);

    const destSegments = segmentsOf(destinationPath);
    const destKey = destSegments.join('/');
    const destFolder = await this.resolveFolder(driveInfo, destinationPath, requestOptions);
    const destHost: ManifestHost = destFolder ?? {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };

    interface PlannedFile {
      entry: UploadFilesEntry;
      fullPath: string;
      filename: string;
      parentPath: string;
    }

    const plannedFiles: PlannedFile[] = [];
    const neededFolderPaths = new Set<string>();

    for (const entry of entries) {
      const relSegments = segmentsOf(entry.relativePath);
      const filename = relSegments[relSegments.length - 1];
      const folderSegments = relSegments.slice(0, -1);
      const fullPath = [...destSegments, ...relSegments].join('/');
      const parentPath = [...destSegments, ...folderSegments].join('/');

      plannedFiles.push({ entry, fullPath, filename, parentPath });

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

      const parentMantaray = await this.getNodeManifest(parentHost, requestOptions);
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

      hostMap.set(path, {
        topic: folderTopic,
        manifestRef: payload.toJSON() as ReferenceWithHistory,
        batchId: driveInfo.batchId,
        redundancyLevel: meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]
          ? (parseInt(meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]) as RedundancyLevel)
          : driveInfo.redundancyLevel,
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
        driveInfo,
        parentHost,
        parentPath,
        folderName,
        undefined,
        requestOptions,
      );

      hostMap.set(path, {
        topic: folderInfo.topic,
        manifestRef: folderInfo.manifestRef,
        batchId: folderInfo.batchId,
        redundancyLevel: folderInfo.redundancyLevel,
      });
      dirtyHosts.set(parentHost.topic, parentHost);

      this.emitter.emit(FileManagerEvents.FOLDER_CREATED, { folderInfo });
    }

    // Phase 3 — upload files, bounded concurrency.
    const succeeded: FileRecord[] = [];
    const failed: { path: string; error: string }[] = [];
    const owner = this.signerAddress;
    const publisher = this.publisher;

    await awaitAllPromisesBounded(
      plannedFiles.map((planned) => async (): Promise<FileRecord> => {
        // Between-files abort is benign — completed files are valid standalone nodes.
        requestOptions?.signal?.throwIfAborted();

        const parentHost = hostMap.get(planned.parentPath);
        if (!parentHost) {
          throw new FileInfoError(`Internal error: parent folder not resolved for path: ${planned.fullPath}`);
        }

        const { topic, version } = await this.getTopicAndVersion(owner);

        const fileOptions: FileInfoOptions =
          typeof planned.entry.source === 'string'
            ? ({ path: planned.entry.source } as NodeUploadOptions as FileInfoOptions)
            : ({ path: planned.fullPath, file: planned.entry.source } as BrowserUploadOptions as FileInfoOptions);

        const fileWrapper = await this.uploadFileContent(
          driveInfo,
          fileOptions,
          parentHost.redundancyLevel,
          uploadOptions,
          requestOptions,
        );

        const fileInfo: FileRecord = {
          batchId: driveInfo.batchId.toString(),
          owner,
          topic,
          // Persisted value is the relative filename — see FileRecord.path doc comment.
          path: planned.filename,
          actPublisher: publisher.toCompressedHex(),
          fileRefAndHistory: fileWrapper,
          driveId: driveInfo.id.toString(),
          timestamp: new Date().getTime(),
          shared: false,
          version,
          redundancyLevel: parentHost.redundancyLevel,
          status: FileStatus.Active,
        };

        await this.saveFileInfoFeed(fileInfo, requestOptions);
        // In-memory copy is stamped with the already-planned absolute path — no walk needed here.
        fileInfo.path = planned.fullPath;

        const parentMantaray = await this.getNodeManifest(parentHost, requestOptions);
        this.addFileToManifest(parentMantaray, planned.filename, topic);
        dirtyHosts.set(parentHost.topic, parentHost);

        this.emitter.emit(FileManagerEvents.FILE_UPLOADED, { fileInfo });

        return fileInfo;
      }),
      MAX_CONCURRENT_UPLOADS,
      (fileInfo) => succeeded.push(fileInfo),
      (reason, ix) => {
        if (requestOptions?.signal?.aborted) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        failed.push({ path: plannedFiles[ix].fullPath, error: (reason as any)?.message || String(reason) });
      },
    );

    // Phase 4 — batched saves, run-to-completion. Abort is honored only up to here: the saves
    // below are non-atomic (append-only feeds, no rollback) and run to completion once started —
    // interrupting them mid-flight would tear state.
    requestOptions?.signal?.throwIfAborted();

    for (const host of dirtyHosts.values()) {
      const mantaray = await this.getNodeManifest(host, requestOptions);
      const updatedRef = await this.saveNodeManifest(mantaray, host, requestOptions);

      if (host.topic === driveInfo.driveFeedTopic.toString()) {
        const idx = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
        if (idx !== -1) {
          this.driveList[idx].manifestRef = updatedRef;
        }
      }
    }

    const result: UploadFilesResult = { succeeded, failed };
    this.emitter.emit(FileManagerEvents.FILES_UPLOADED, result);

    return result;
  }

  private async getTopicAndVersion(
    address: string | EthAddress,
    currentTopic?: string | Topic,
    currentVersion?: string,
  ): Promise<{ topic: string; version: string }> {
    let version: string | undefined;
    let topic: string;

    if (!currentTopic) {
      const randomTopic = generateRandomBytes(Topic.LENGTH);
      version = FEED_INDEX_ZERO.toString();
      topic = new Topic(randomTopic).toString();
    } else {
      version = currentVersion;
      topic = currentTopic.toString();
    }

    if (!version) {
      const cached = this.fileInfoList.find((f) => f.topic.toString() === topic);

      if (cached?.version !== undefined) {
        version = new FeedIndex(cached.version).next().toString();
      } else {
        const { feedIndex, feedIndexNext } = await getFeedData(this.bee, new Topic(topic), address);

        if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
          return { topic, version: FEED_INDEX_ZERO.toString() };
        }
        version = feedIndexNext.toString();
      }
    }

    return { topic, version: version ? version : FEED_INDEX_ZERO.toString() };
  }

  async getFileVersion(fi: FileRecord, version?: string | FeedIndex): Promise<FileRecord> {
    const localHead = this.fileInfoList.find((f) => f.topic.toString() === fi.topic.toString());

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
    if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileInfoError(`File feed not found for topic: ${fi.topic.toString()}`);
    }

    return this.fetchFileInfo(topic.toString(), new PublicKey(fi.actPublisher).toCompressedHex(), feedData);
  }

  async restoreFileVersion(versionToRestore: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
    const { feedIndex, feedIndexNext } = await getFeedData(
      this.bee,
      new Topic(versionToRestore.topic),
      versionToRestore.owner.toString(),
    );
    if (feedIndex.equals(FeedIndex.MINUS_ONE.toString())) {
      throw new FileInfoError('FileInfo feed not found');
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
    const cached = this.fileInfoList.find((f) => f.topic.toString() === versionToRestore.topic.toString());

    const restored: FileRecord = {
      ...versionToRestore,
      path: cached?.path ?? versionToRestore.path,
      version: feedIndexNext.toString(),
      fileRefAndHistory: {
        reference: versionToRestore.fileRefAndHistory.reference,
        historyRef: versionToRestore.fileRefAndHistory.historyRef,
      },
      timestamp: Date.now(),
    };

    await this.saveFileInfoFeed(restored, requestOptions);

    this.emitter.emit(FileManagerEvents.FILE_VERSION_RESTORED, {
      restored,
    });
  }

  private async uploadFileInfo(
    fileInfo: FileRecord,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
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

  private async getNodeManifest(host: ManifestHost, requestOptions?: BeeRequestOptions): Promise<MantarayNode> {
    const cached = this.nodeManifestCache.get(host.topic);
    if (cached) return cached;

    if (!host.manifestRef) {
      throw new DriveError(`Node ${host.topic} has no manifestRef — cannot load manifest`);
    }
    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const raw = await this.bee.downloadData(
      host.manifestRef.reference,
      { actHistoryAddress: host.manifestRef.historyRef, actPublisher: this.publisher },
      requestOptions,
    );
    const mantaray = await loadMantaray(
      this.bee,
      new Reference(raw.toUint8Array()).toString(),
      undefined,
      requestOptions,
    );

    this.nodeManifestCache.set(host.topic, mantaray);

    return mantaray;
  }
  // TODO: as mantaray util
  private async saveNodeManifest(
    mantaray: MantarayNode,
    host: ManifestHost,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    const saveResult = await mantaray.saveRecursively(this.bee, host.batchId, { act: false }, requestOptions);
    // TODO: actHistoryAddress is not used --> where is it stored and how to pass it on?
    const manifestUpload = await this.bee.uploadData(
      host.batchId,
      saveResult.reference.toUint8Array(),
      { act: true, redundancyLevel: host.redundancyLevel },
      requestOptions,
    );
    const newManifestRef: ReferenceWithHistory = {
      reference: manifestUpload.reference.toString(),
      historyRef: manifestUpload.historyAddress.getOrThrow().toString(),
    };

    const writeIndex = await this.getNextFeedIndex(host.topic);
    const fw = this.bee.makeFeedWriter(new Topic(host.topic).toUint8Array(), this.signer);
    await fw.uploadPayload(host.batchId, JSON.stringify(newManifestRef), { index: FeedIndex.fromBigInt(writeIndex) });
    this.nodeFeedIndexCache.set(host.topic, writeIndex + 1n);

    return newManifestRef;
  }

  private async getNextFeedIndex(topic: string): Promise<bigint> {
    const cached = this.nodeFeedIndexCache.get(topic);
    if (cached !== undefined) return cached;

    const { feedIndexNext } = await getFeedData(this.bee, new Topic(topic), this.signerAddress);
    const next = feedIndexNext.toBigInt();
    this.nodeFeedIndexCache.set(topic, next);

    return next;
  }

  private async saveFileInfoFeed(fi: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      throw new FileInfoError(`Failed to save wrapped fileInfo feed: ${error.message || error}`);
    }
  }

  private async fetchFileInfo(
    topic: string,
    actPublisher: string,
    feeData: FeedResultWithIndex,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    if (feeData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileInfoError(`File info not found for topic: ${topic}`);
    }

    const data = feeData.payload.toJSON() as ReferenceWithHistory;

    const fileBytes = await this.bee.downloadData(
      data.reference.toString(),
      {
        actHistoryAddress: data.historyRef.toString(),
        actPublisher,
      },
      requestOptions,
    );

    const fileInfo = fileBytes.toJSON() as FileRecord;
    assertFileRecord(fileInfo);
    // make sure that version tracks the actual feed index
    fileInfo.version = feeData.feedIndex.toString();

    return fileInfo;
  }

  private async setFileStatus(
    fileInfo: FileRecord,
    expectedStatus: FileStatus | undefined,
    newStatus: FileStatus,
    invalidStateMessage: string,
  ): Promise<FileRecord> {
    const fi = this.fileInfoList.find((f) => f.topic.toString() === fileInfo.topic.toString());

    if (!fi) {
      throw new FileInfoError(`Corresponding File Info does not exist: ${fileInfo.path}`);
    }

    if (expectedStatus !== undefined && fi.status !== expectedStatus) {
      throw new FileInfoError(`${invalidStateMessage}: ${fileInfo.path}`);
    }

    if (expectedStatus === undefined && fi.status === newStatus) {
      throw new FileInfoError(`${invalidStateMessage}: ${fileInfo.path}`);
    }

    if (fi.version === undefined) {
      throw new FileInfoError(`File version is undefined: ${fileInfo.path}`);
    }

    fi.version = new FeedIndex(fi.version).next().toString();
    fi.status = newStatus;
    fi.timestamp = new Date().getTime();
    fi.customMetadata = { ...(fi.customMetadata ?? {}), ...(fileInfo.customMetadata ?? {}) };

    await this.saveFileInfoFeed(fi);

    return fi;
  }
  // TODO: rename to trash
  async trashFile(fileInfo: FileRecord): Promise<void> {
    const fi = await this.setFileStatus(fileInfo, undefined, FileStatus.Trashed, 'File already Trashed');
    this.emitter.emit(FileManagerEvents.FILE_TRASHED, { fileInfo: fi });
  }

  // TODO: rename to recover
  async recoverFile(fileInfo: FileRecord): Promise<void> {
    const fi = await this.setFileStatus(
      fileInfo,
      FileStatus.Trashed,
      FileStatus.Active,
      'Non-Trashed files cannot be restored',
    );
    this.emitter.emit(FileManagerEvents.FILE_RECOVERED, { fileInfo: fi });
  }

  // TODO: forget vs forgetDrive -> naming or there is also common logic?
  async forget(driveInfo: DriveInfo, path: string, requestOptions?: BeeRequestOptions): Promise<void> {
    requestOptions?.signal?.throwIfAborted();

    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized.');
    }
    if (!path || path === ROOT_PATH) {
      throw new DriveError('Cannot forget drive root');
    }

    const lastSlash = path.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? path.substring(0, lastSlash) : '';
    const name = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

    const parentFolder = await this.resolveFolder(driveInfo, parentPath, requestOptions);
    const parentHost: ManifestHost = parentFolder ?? {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };
    const parentMantaray = await this.getNodeManifest(parentHost, requestOptions);

    const fork = parentMantaray.find(name);
    if (!fork) {
      throw new FileInfoError(`Path not found: ${path}`);
    }

    const meta = fork.metadata ?? {};
    const nodeType = meta[MANIFEST_METADATA_NODE_TYPE] as NodeType | undefined;
    const nodeTopic = meta[MANIFEST_METADATA_NODE_TOPIC];

    parentMantaray.removeFork(name);
    const newManifestRef = await this.saveNodeManifest(parentMantaray, parentHost, requestOptions);

    if (!parentFolder) {
      const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());

      if (driveIndex !== -1) this.driveList[driveIndex].manifestRef = newManifestRef;
    }

    if (nodeType === NodeType.Folder) {
      // TODO: folder status change (trash/recover for folders) — fork-metadata-based, not yet implemented
      if (nodeTopic) this.nodeManifestCache.delete(nodeTopic);
      const prefix = path.endsWith('/') ? path : path + '/';
      for (let i = this.fileInfoList.length - 1; i >= 0; --i) {
        const f = this.fileInfoList[i];
        if (f.driveId === driveInfo.id.toString() && f.path.startsWith(prefix)) {
          this.fileInfoList.splice(i, 1);
        }
      }
      this.emitter.emit(FileManagerEvents.FOLDER_FORGOTTEN, { driveInfo, path });
    } else {
      const fiIndex = this.fileInfoList.findIndex((f) => f.driveId === driveInfo.id.toString() && f.path === path);
      const forgotten = fiIndex !== -1 ? this.fileInfoList[fiIndex] : undefined;
      if (fiIndex !== -1) this.fileInfoList.splice(fiIndex, 1);
      this.emitter.emit(FileManagerEvents.FILE_FORGOTTEN, { fileInfo: forgotten, path });
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
  async getGrantees(fileInfo: FileRecord): Promise<GetGranteesResult> {
    const driveIx = this.driveList.findIndex((d) => d.id.toString() === fileInfo.driveId);
    if (driveIx === -1) {
      throw new GranteeError(`Drive not found for file: ${fileInfo.path}`);
    }

    throw new GranteeError('getGrantees: not yet migrated to mantaray model');
  }

  // eslint-disable-next-line require-await
  async subscribeToSharedInbox(_topic: string, _callback?: (_data: ShareItem) => void): Promise<void> {
    throw new SubscriptionError('subscribeToSharedInbox: not yet implemented in the node-based model');
  }

  unsubscribeFromSharedInbox(): void {
    throw new SubscriptionError('unsubscribeFromSharedInbox: not yet implemented in the node-based model');
  }

  // eslint-disable-next-line require-await
  async share(
    _fileInfo: FileRecord,
    _targetOverlays: string[],
    _recipients: string[],
    _message?: string,
  ): Promise<void> {
    throw new SendShareMessageError('share: not yet implemented in the node-based model');
  }

  async move(
    fromPath: string,
    toPath: string,
    sourceDriveInfo: DriveInfo,
    targetDriveInfo?: DriveInfo,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    // Behaviour-preserving: move never gated on a publisher at the top today (only inside its
    // lazy-fetch path), so keep requirePublisher = false here.
    this.assertReady(undefined, requestOptions, false);

    if (!fromPath || fromPath === ROOT_PATH) {
      throw new DriveError('Cannot move root folder');
    }
    if (!toPath || toPath === ROOT_PATH) {
      throw new DriveError('Invalid destination path');
    }

    const isCrossDrive = !!targetDriveInfo && targetDriveInfo.id.toString() !== sourceDriveInfo.id.toString();
    const effectiveTarget = targetDriveInfo ?? sourceDriveInfo;

    if (!isCrossDrive && fromPath === toPath) {
      throw new DriveError('Source and destination paths are identical');
    }

    const srcLastSlash = fromPath.lastIndexOf('/');
    const srcParentPath = srcLastSlash > 0 ? fromPath.substring(0, srcLastSlash) : '';
    const srcName = srcLastSlash >= 0 ? fromPath.substring(srcLastSlash + 1) : fromPath;

    const tgtLastSlash = toPath.lastIndexOf('/');
    const tgtParentPath = tgtLastSlash > 0 ? toPath.substring(0, tgtLastSlash) : '';
    const tgtName = tgtLastSlash >= 0 ? toPath.substring(tgtLastSlash + 1) : toPath;

    const srcParentFolder = await this.resolveFolder(sourceDriveInfo, srcParentPath, requestOptions);
    const srcParentHost: ManifestHost = srcParentFolder ?? {
      topic: sourceDriveInfo.driveFeedTopic.toString(),
      manifestRef: sourceDriveInfo.manifestRef,
      batchId: sourceDriveInfo.batchId,
      redundancyLevel: sourceDriveInfo.redundancyLevel,
    };
    const sourceMantaray = await this.getNodeManifest(srcParentHost, requestOptions);

    const sourceFork = sourceMantaray.find(srcName);
    if (!sourceFork) {
      throw new DriveError(`Path not found: ${fromPath}`);
    }

    const forkMetadata = sourceFork.metadata ?? {};
    const isFile = !!forkMetadata[MANIFEST_METADATA_FILE_TOPIC];

    const tgtParentFolder = await this.resolveFolder(effectiveTarget, tgtParentPath, requestOptions);
    const tgtParentHost: ManifestHost = tgtParentFolder ?? {
      topic: effectiveTarget.driveFeedTopic.toString(),
      manifestRef: effectiveTarget.manifestRef,
      batchId: effectiveTarget.batchId,
      redundancyLevel: effectiveTarget.redundancyLevel,
    };
    const sameParent = srcParentHost.topic === tgtParentHost.topic;
    const targetMantaray = sameParent ? sourceMantaray : await this.getNodeManifest(tgtParentHost, requestOptions);

    if (isFile) {
      const fileTopic = forkMetadata[MANIFEST_METADATA_FILE_TOPIC];
      if (!fileTopic) {
        throw new FileInfoError(`Fork at ${fromPath} has no file topic — cannot move`);
      }

      let fi = this.fileInfoList.find((f) => f.topic.toString() === fileTopic);
      // Lazy init - fetch it on demand.
      if (!fi) {
        const publisher = this.publisher;
        if (!publisher) {
          throw new SignerError('Publisher not found');
        }

        // TODO: why feedindex / version is not tracked -> expensive lookup
        const feedData = await getFeedData(this.bee, new Topic(fileTopic), this.signerAddress);

        if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
          throw new FileInfoError(`File feed not found for topic: ${fileTopic}`);
        }

        this.nodeFeedIndexCache.set(fileTopic, feedData.feedIndexNext.toBigInt());

        fi = await this.fetchFileInfo(fileTopic, publisher.toCompressedHex(), feedData);

        this.fileInfoList.push(fi);
      }

      // Persisted value is the relative filename — see FileRecord.path doc comment.
      fi.path = tgtName;
      if (isCrossDrive) {
        fi.driveId = effectiveTarget.id.toString();
      }

      const newVersion = fi.version !== undefined ? new FeedIndex(fi.version) : FEED_INDEX_ZERO;
      fi.version = newVersion.next().toString();

      await this.saveFileInfoFeed(fi, requestOptions);
      // In-memory copy is stamped with the caller-known absolute destination — no walk needed here.
      fi.path = toPath;
    }

    const updatedMetadata: Record<string, string> = { ...forkMetadata };

    sourceMantaray.removeFork(srcName);
    if (sameParent) {
      sourceMantaray.addFork(tgtName, sourceFork.targetAddress, updatedMetadata);
    } else {
      targetMantaray.addFork(tgtName, sourceFork.targetAddress, updatedMetadata);
    }

    const newSrcManifestRef = await this.saveNodeManifest(sourceMantaray, srcParentHost, requestOptions);
    if (!srcParentFolder) {
      const driveIndex = this.driveList.findIndex((d) => d.id.toString() === sourceDriveInfo.id.toString());
      if (driveIndex !== -1) this.driveList[driveIndex].manifestRef = newSrcManifestRef;
    }

    if (!sameParent) {
      const newTgtManifestRef = await this.saveNodeManifest(targetMantaray, tgtParentHost, requestOptions);
      if (!tgtParentFolder) {
        const driveIndex = this.driveList.findIndex((d) => d.id.toString() === effectiveTarget.id.toString());
        if (driveIndex !== -1) this.driveList[driveIndex].manifestRef = newTgtManifestRef;
      }
    }

    if (!isFile) {
      // Folder move only relocates the folder's own fork — nothing on Swarm claims an absolute
      // position anymore, so descendants need no re-upload. Just re-stamp the in-memory cache
      // (nodeManifestCache/nodeFeedIndexCache are keyed by topic, not path — untouched).
      const fromPrefix = fromPath + '/';
      const toPrefix = toPath + '/';
      for (const f of this.fileInfoList) {
        if (f.driveId === sourceDriveInfo.id.toString() && f.path.startsWith(fromPrefix)) {
          f.path = toPrefix + f.path.substring(fromPrefix.length);
          if (isCrossDrive) {
            f.driveId = effectiveTarget.id.toString();
          }
        }
      }
    }

    this.emitter.emit(FileManagerEvents.FILE_MOVED, { fromPath, toPath });
  }

  private async resolveFolder(
    driveInfo: DriveInfo,
    path: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo | null> {
    if (!path || path === ROOT_PATH) return null;

    const segments = path.split('/').filter(Boolean);
    const driveHost: ManifestHost = {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };

    let currentMantaray = await this.getNodeManifest(driveHost, requestOptions);
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
      const folderManifestRef: ReferenceWithHistory = folderPayload.toJSON() as ReferenceWithHistory;
      this.nodeFeedIndexCache.set(folderTopic, folderFeedIndexNext.toBigInt());

      currentFolderInfo = {
        topic: folderTopic,
        manifestRef: folderManifestRef,
        batchId: driveInfo.batchId,
        redundancyLevel: meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]
          ? (parseInt(meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]) as RedundancyLevel)
          : driveInfo.redundancyLevel,
        path: currentPath,
        driveId: driveInfo.id.toString(),
      };

      currentMantaray = await this.getNodeManifest(currentFolderInfo, requestOptions);
    }

    return currentFolderInfo;
  }

  // Per-folder part only: creates the folder's own node (topic, empty manifest published at feed
  // slot 0) and adds its fork to the PARENT's in-memory mantaray — but does not save the parent's
  // manifest or update the drive list. Callers that need the parent persisted immediately
  // (createFolder) do that themselves right after; callers batching many changes onto one parent
  // (uploadFiles) defer it and save once at the end.
  private async createFolderNode(
    driveInfo: DriveInfo,
    parentHost: ManifestHost,
    parentPath: string,
    folderName: string,
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
    const newFolderManifestRef: ReferenceWithHistory = {
      reference: manifestUpload.reference.toString(),
      historyRef: manifestUpload.historyAddress.getOrThrow().toString(),
    };

    const fw = this.bee.makeFeedWriter(new Topic(newFolderTopic).toUint8Array(), this.signer);
    await fw.uploadPayload(driveInfo.batchId, JSON.stringify(newFolderManifestRef), { index: FEED_INDEX_ZERO });

    const folderInfo: FolderInfo = {
      topic: newFolderTopic,
      manifestRef: newFolderManifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: effectiveRedundancy,
      path: (parentPath === ROOT_PATH || !parentPath ? '' : parentPath) + '/' + folderName,
      driveId: driveInfo.id.toString(),
    };

    this.nodeManifestCache.set(newFolderTopic, emptyMantaray);
    this.nodeFeedIndexCache.set(newFolderTopic, 1n);

    const parentMantaray = await this.getNodeManifest(parentHost, requestOptions);

    parentMantaray.addFork(folderName, new Reference(newFolderTopic), {
      [MANIFEST_METADATA_NODE_TOPIC]: newFolderTopic,
      [MANIFEST_METADATA_NODE_TYPE]: NodeType.Folder,
      [MANIFEST_METADATA_REDUNDANCY_LEVEL]: effectiveRedundancy.toString(),
    });

    return folderInfo;
  }

  async createFolder(
    driveInfo: DriveInfo,
    parentPath: string,
    folderName: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo> {
    // Behaviour-preserving: createFolder does not gate on a publisher today.
    this.assertReady(undefined, requestOptions, false);

    if (!folderName || folderName.includes('/')) {
      throw new DriveError('Invalid folder name');
    }

    const parentFolder = await this.resolveFolder(driveInfo, parentPath, requestOptions);
    const parentHost: ManifestHost = parentFolder ?? {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };

    const folderInfo = await this.createFolderNode(
      driveInfo,
      parentHost,
      parentPath,
      folderName,
      redundancyLevel,
      requestOptions,
    );

    const parentMantaray = await this.getNodeManifest(parentHost, requestOptions);
    const updatedParentManifestRef = await this.saveNodeManifest(parentMantaray, parentHost, requestOptions);

    if (!parentFolder) {
      const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
      if (driveIndex !== -1) this.driveList[driveIndex].manifestRef = updatedParentManifestRef;
    }

    return folderInfo;
  }
}
