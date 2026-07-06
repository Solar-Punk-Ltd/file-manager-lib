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
import { awaitAllPromisesBounded, settlePromises, verifyStampUsability } from './utils/common';
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
  MANIFEST_METADATA_PATH,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  MAX_CONCURRENT_FEED_FETCHES,
  ROOT_PATH,
} from './utils/constants';
import { generateRandomBytes } from './utils/crypto';
import { DirectoryEntry, getAllNodeEntries, loadMantaray } from './utils/mantaray';
import { processDownload } from './download';
import { EventEmitter, EventEmitterBase } from './eventEmitter';
import {
  DownloadResource,
  DownloadResult,
  DriveInfo,
  FileInfoOptions,
  FileManager,
  FileRecord,
  FileStatus,
  FolderInfo,
  ManifestHost,
  ShareItem,
} from './types';
import { processUpload } from './upload';
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

// TODO: reconsider the architecture of using mantarays: mantaray is a prefix try -> what is the point of storing topics as forks -> inefficient
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
          this.adminRedundancyLevel = driveInfo.redundancyLevel;
        }

        return driveInfo;
      }),
      (driveInfo) => {
        if (driveInfo) this.driveList.push(driveInfo);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (reason) => console.error(`initDriveList: failed to load drive from fork: ${(reason as any)?.message || reason}`),
    );
  }

  private async pruneDriveMetadata(driveInfo: DriveInfo, requestOptions?: BeeRequestOptions): Promise<void> {
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
    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized.');
    }

    let driveName = name;
    if (isAdmin) {
      console.debug('Creating admin drive with name: ', ADMIN_STAMP_LABEL);
      driveName = ADMIN_STAMP_LABEL;

      await this.fetchAndSetAdminStamp(batchId.toString(), requestOptions);
      verifyStampUsability(this._adminStamp, batchId.toString());
      await this.createAdminManifest(batchId.toString(), resetState, requestOptions);
    } else {
      if (!this._adminStamp) {
        throw new DriveError('Admin stamp not found');
      }

      const stamp = await fetchStamp(this.bee, batchId);
      verifyStampUsability(stamp, batchId.toString());
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

    const stateTopic = this.stateFeedTopic;
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

    adminMantaray.addFork(
      `${DRIVE_FORK_PREFIX}-${driveInfo.id.toString()}`,
      new Reference(driveInfo.driveFeedTopic.toString()),
      {
        [MANIFEST_METADATA_PATH]: `${DRIVE_FORK_PREFIX}-${driveInfo.id.toString()}`,
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
    folderPath: string,
    depth: ListDepth = ListDepth.Shallow,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<DirectoryEntry[]> {
    const startFolder = await this.resolveFolder(driveInfo, folderPath, requestOptions);
    const startHost: ManifestHost = startFolder ?? {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };

    // TODO: MAX_SAFE_INTEGER seems wrong here
    const results: DirectoryEntry[] = [];
    let frontier: ManifestHost[] = [startHost];
    let level = 0;
    const depthLimit = depth === ListDepth.Deep ? (maxDepth ?? Number.MAX_SAFE_INTEGER) : 1;
    // Per BFS level: (1) expand current frontier manifests, (2) load file feeds found, (3) resolve folder feeds into next frontier. Each phase is concurrency-bounded.
    while (frontier.length > 0 && level < depthLimit) {
      const levelEntries: DirectoryEntry[] = [];

      await awaitAllPromisesBounded(
        frontier.map(
          (host) => (): Promise<DirectoryEntry[]> => this.getNodeManifest(host, requestOptions).then(getAllNodeEntries),
        ),
        MAX_CONCURRENT_FEED_FETCHES,
        (entries) => levelEntries.push(...entries),
        (reason) => console.error(`listFolder: failed to expand manifest: ${reason}`),
      );
      results.push(...levelEntries);

      const publisher = this.publisher;
      if (publisher) {
        const newFileEntries = levelEntries.filter(
          (e) => e.type === NodeType.File && !this.fileInfoList.some((f) => f.topic.toString() === e.topic),
        );

        await awaitAllPromisesBounded(
          newFileEntries.map((e) => async (): Promise<FileRecord> => {
            const feedData = await getFeedData(this.bee, new Topic(e.topic), this.signerAddress);

            return this.fetchFileInfo(e.topic, publisher.toCompressedHex(), feedData);
          }),
          MAX_CONCURRENT_FEED_FETCHES,
          (fi) => this.fileInfoList.push(fi),
          (reason, ix) => console.error(`listFolder: failed to load file ${newFileEntries[ix].topic}: ${reason}`),
        );
      }

      if (depth === ListDepth.Shallow) break;

      const folderEntries = levelEntries.filter((e) => e.type === NodeType.Folder);
      const nextFrontier: ManifestHost[] = [];

      await awaitAllPromisesBounded(
        folderEntries.map((e) => async (): Promise<ManifestHost | null> => {
          const { payload, feedIndex, feedIndexNext } = await getFeedData(
            this.bee,
            new Topic(e.topic),
            this.signerAddress,
          );
          if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
            console.warn(`listFolder: folder feed not found for ${e.path} — skipping`);
            return null;
          }

          const manifestRef: ReferenceWithHistory = payload.toJSON() as ReferenceWithHistory;
          this.nodeFeedIndexCache.set(e.topic, feedIndexNext.toBigInt());

          return {
            topic: e.topic,
            manifestRef,
            batchId: driveInfo.batchId,
            redundancyLevel: driveInfo.redundancyLevel,
          } as ManifestHost;
        }),
        MAX_CONCURRENT_FEED_FETCHES,
        (host) => {
          if (host) {
            nextFrontier.push(host);
          }
        },
        (reason, ix) => console.error(`listFolder: failed to resolve folder ${folderEntries[ix].path}: ${reason}`),
      );

      frontier = nextFrontier;
      level++;
    }

    return results;
  }

  private async loadFolderFiles(
    driveInfo: DriveInfo,
    folderPath: string,
    onlyPaths?: Set<string>,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    const publisher = this.publisher;
    if (!publisher) {
      return;
    }

    const folder = await this.resolveFolder(driveInfo, folderPath, requestOptions);
    const host: ManifestHost = folder ?? {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };

    const mantaray = await this.getNodeManifest(host, requestOptions);
    const fileEntries = getAllNodeEntries(mantaray).filter(
      (e) =>
        e.type === NodeType.File &&
        (!onlyPaths || onlyPaths.has(e.path)) &&
        !this.fileInfoList.some((f) => f.topic.toString() === e.topic),
    );

    await awaitAllPromisesBounded(
      fileEntries.map((entry) => async (): Promise<FileRecord | null> => {
        const feedData = await getFeedData(this.bee, new Topic(entry.topic), this.signerAddress);

        if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
          console.warn(`loadFolderFiles: file feed not found for ${entry.path} — skipping`);
          return null;
        }

        this.nodeFeedIndexCache.set(entry.topic, feedData.feedIndexNext.toBigInt());

        return await this.fetchFileInfo(entry.topic, publisher.toCompressedHex(), feedData);
      }),
      MAX_CONCURRENT_FEED_FETCHES,
      (fi) => {
        if (fi) this.fileInfoList.push(fi);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (reason) => console.error(`loadFolderFiles: ${(reason as any)?.message || reason}`),
    );
  }

  async download(
    driveInfo: DriveInfo,
    paths?: string[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult[]> {
    if (paths && paths.length > 0) {
      const parents = new Map<string, Set<string>>();

      for (const p of paths) {
        const lastSlash = p.lastIndexOf('/');
        const parent = lastSlash > 0 ? p.substring(0, lastSlash) : '';

        if (!parents.has(parent)) parents.set(parent, new Set());

        const pathSet = parents.get(parent) as Set<string>;
        pathSet.add(p);
      }

      await Promise.all(
        Array.from(parents.entries()).map(([parent, pathSet]) =>
          this.loadFolderFiles(driveInfo, parent, pathSet, requestOptions),
        ),
      );
    } else {
      await this.listFolder(driveInfo, '', ListDepth.Deep, undefined, requestOptions);
    }

    const driveFiles = this.fileInfoList.filter((f) => f.driveId === driveInfo.id.toString());
    const files = paths && paths.length > 0 ? driveFiles.filter((f) => paths.includes(f.path)) : driveFiles;
    const resources: DownloadResource[] = files.map((fi) => ({
      path: fi.path,
      reference: fi.file.reference.toString(),
      actHistoryAddress: fi.file.historyRef.toString(),
      actPublisher: new PublicKey(fi.actPublisher).toCompressedHex(),
    }));
    return processDownload(this.bee, resources, options, requestOptions);
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

    const fileOptionTopic = fileOptions.topic;

    if (
      (fileOptionTopic && !uploadOptions?.actHistoryAddress) ||
      (!fileOptionTopic && uploadOptions?.actHistoryAddress)
    ) {
      throw new FileInfoError('Options topic and historyRef have to be provided at the same time.');
    }

    if (fileOptionTopic) {
      const existing = this.fileInfoList.find((f) => f.topic.toString() === fileOptionTopic.toString());

      if (existing && existing.path !== fileOptions.path) {
        throw new FileInfoError(
          `Cannot change path during re-upload (existing: ${existing.path}, requested: ${fileOptions.path}). Use move() to relocate a file.`,
        );
      }
    }

    if (!this.publisher) {
      throw new SignerError('Publisher not found');
    }

    const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
    if (driveIndex === -1) {
      throw new FileInfoError(`Drive ${driveInfo.name} with id ${driveInfo.id.toString()} not found`);
    }

    const owner = this.signerAddress;
    const { topic, version } = await this.getTopicAndVersion(owner, fileOptionTopic, fileOptions.version?.toString());

    const file = await processUpload(this.bee, driveInfo, fileOptions, uploadOptions, requestOptions);
    const fileInfo: FileRecord = {
      batchId: driveInfo.batchId.toString(),
      owner,
      topic,
      path: fileOptions.path,
      actPublisher: this.publisher.toCompressedHex(),
      file,
      driveId: driveInfo.id.toString(),
      timestamp: new Date().getTime(),
      shared: false,
      version,
      customMetadata: fileOptions.customMetadata,
      redundancyLevel: driveInfo.redundancyLevel,
      status: FileStatus.Active,
    };

    await this.saveFileInfoFeed(fileInfo, requestOptions);

    // no need to save the drive list again if the file info feed is already saved in state
    if (!fileOptionTopic) {
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
      const mantaray = await this.getNodeManifest(targetHost, requestOptions);

      const fileTopicRef = new Reference(topic);
      mantaray.addFork(filename, fileTopicRef, {
        [MANIFEST_METADATA_PATH]: fileOptions.path,
        [MANIFEST_METADATA_FILE_TOPIC]: topic,
        [MANIFEST_METADATA_NODE_TOPIC]: topic,
        [MANIFEST_METADATA_NODE_TYPE]: NodeType.File,
      });

      const newManifestRef = await this.saveNodeManifest(mantaray, targetHost, requestOptions);

      if (!parentFolder) {
        const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());

        if (driveIndex !== -1) {
          this.driveList[driveIndex].manifestRef = newManifestRef;
        }
      }
    }

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

  async getVersion(fi: FileRecord, version?: string | FeedIndex): Promise<FileRecord> {
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

  async restoreVersion(versionToRestore: FileRecord, requestOptions?: BeeRequestOptions): Promise<void> {
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
      console.debug(`Head Slot cannot be restored. Please select a version lesser than: ${versionToRestore.version}`);
      return;
    }

    const restored: FileRecord = {
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

  private async saveNodeManifest(
    mantaray: MantarayNode,
    host: ManifestHost,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    const saveResult = await mantaray.saveRecursively(this.bee, host.batchId, { act: false }, requestOptions);
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

  private async fetchFileInfo(topic: string, actPublisher: string, feeData: FeedResultWithIndex): Promise<FileRecord> {
    if (feeData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileInfoError(`File info not found for topic: ${topic}`);
    }

    const data = feeData.payload.toJSON() as ReferenceWithHistory;

    const fileBytes = await this.bee.downloadData(data.reference.toString(), {
      actHistoryAddress: data.historyRef.toString(),
      actPublisher,
    });

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

  async trashFile(fileInfo: FileRecord): Promise<void> {
    const fi = await this.setFileStatus(fileInfo, undefined, FileStatus.Trashed, 'File already Trashed');
    this.emitter.emit(FileManagerEvents.FILE_TRASHED, { fileInfo: fi });
  }

  async recoverFile(fileInfo: FileRecord): Promise<void> {
    const fi = await this.setFileStatus(
      fileInfo,
      FileStatus.Trashed,
      FileStatus.Active,
      'Non-Trashed files cannot be restored',
    );
    this.emitter.emit(FileManagerEvents.FILE_RECOVERED, { fileInfo: fi });
  }

  async forget(driveInfo: DriveInfo, path: string, requestOptions?: BeeRequestOptions): Promise<void> {
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
      this.emitter.emit(FileManagerEvents.FOLDER_FORGOTTEN, { driveInfo, folderPath: path });
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
    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized');
    }
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

        const feedData = await getFeedData(this.bee, new Topic(fileTopic), this.signerAddress);

        if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
          throw new FileInfoError(`File feed not found for topic: ${fileTopic}`);
        }

        this.nodeFeedIndexCache.set(fileTopic, feedData.feedIndexNext.toBigInt());

        fi = await this.fetchFileInfo(fileTopic, publisher.toCompressedHex(), feedData);

        this.fileInfoList.push(fi);
      }

      fi.path = toPath;
      if (isCrossDrive) {
        fi.driveId = effectiveTarget.id.toString();
      }

      const newVersion = fi.version !== undefined ? new FeedIndex(fi.version) : FEED_INDEX_ZERO;
      fi.version = newVersion.next().toString();

      await this.saveFileInfoFeed(fi, requestOptions);
    }

    const updatedMetadata: Record<string, string> = {
      ...forkMetadata,
      [MANIFEST_METADATA_PATH]: toPath,
    };

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

      const {
        payload: folderPayload,
        feedIndex: folderFeedIndex,
        feedIndexNext: folderFeedIndexNext,
      } = await getFeedData(this.bee, new Topic(folderTopic), this.signerAddress);
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

  async createFolder(
    driveInfo: DriveInfo,
    parentPath: string,
    folderName: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo> {
    if (!this.isInitialized) {
      throw new DriveError('FileManager is not initialized');
    }
    if (!folderName || folderName.includes('/')) {
      throw new DriveError('Invalid folder name');
    }

    const parentFolder = await this.resolveFolder(driveInfo, parentPath, requestOptions);
    const effectiveRedundancy = redundancyLevel ?? parentFolder?.redundancyLevel ?? driveInfo.redundancyLevel;

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

    const newFolderInfo: FolderInfo = {
      topic: newFolderTopic,
      manifestRef: newFolderManifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: effectiveRedundancy,
      path: (parentPath === ROOT_PATH || !parentPath ? '' : parentPath) + '/' + folderName,
      driveId: driveInfo.id.toString(),
    };

    this.nodeManifestCache.set(newFolderTopic, emptyMantaray);
    this.nodeFeedIndexCache.set(newFolderTopic, 1n);

    const parentHost: ManifestHost = parentFolder ?? {
      topic: driveInfo.driveFeedTopic.toString(),
      manifestRef: driveInfo.manifestRef,
      batchId: driveInfo.batchId,
      redundancyLevel: driveInfo.redundancyLevel,
    };
    const parentMantaray = await this.getNodeManifest(parentHost, requestOptions);

    parentMantaray.addFork(folderName, new Reference(newFolderTopic), {
      [MANIFEST_METADATA_PATH]: newFolderInfo.path,
      [MANIFEST_METADATA_NODE_TOPIC]: newFolderTopic,
      [MANIFEST_METADATA_NODE_TYPE]: NodeType.Folder,
      [MANIFEST_METADATA_REDUNDANCY_LEVEL]: effectiveRedundancy.toString(),
    });

    const updatedParentManifestRef = await this.saveNodeManifest(parentMantaray, parentHost, requestOptions);

    if (!parentFolder) {
      const driveIndex = this.driveList.findIndex((d) => d.id.toString() === driveInfo.id.toString());
      if (driveIndex !== -1) this.driveList[driveIndex].manifestRef = updatedParentManifestRef;
    }

    return newFolderInfo;
  }
}
