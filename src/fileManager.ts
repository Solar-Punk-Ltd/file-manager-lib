import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  FeedIndex,
  Identifier,
  MantarayNode,
  PostageBatch,
  PrivateKey,
  PublicKey,
  RedundancyLevel,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { DriveInfo, FileRecord, ManifestHost, NodeType } from './types/v2/info';
import { ActReferences } from './types/v2/utils';
import { fetchStamp, getFeedData, verifyStampUsability, verifySupportedBeeVersions } from './utils/bee';
import { settlePromises } from './utils/common';
import { ADMIN_STAMP_LABEL, FEED_INDEX_ZERO, FILEMANAGER_STATE_TOPIC } from './utils/constants';
import { generateRandomBytes } from './utils/crypto';
import { DriveError, ErrorHandler, SignerError } from './utils/errors';
import { FileManagerEvents } from './utils/events';
import { Logger } from './utils/logger';
import { assertActReferences, assertDriveInfoFromMetadata, assertReady } from './utils/v2/asserts';
import { driveForkMetadata, getAllNodeEntries, getDriveForkPath } from './utils/v2/mantaray';
import { EventEmitter, EventEmitterBase } from './eventEmitter';
import { MantarayStore } from './mantarayStore';

// TODO: restore `implements FileManager` when all methods land
export class FileManagerBase {
  private bee: Bee;
  private signer: PrivateKey;
  private signerAddress: string;
  private publisher: PublicKey | undefined = undefined;
  private stateFeedTopic: Topic | undefined = undefined;
  private _isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private _adminStamp: PostageBatch | undefined = undefined;
  private adminRedundancyLevel: RedundancyLevel = RedundancyLevel.OFF;

  private readonly store: MantarayStore;
  private readonly errorHandler = ErrorHandler.getInstance();
  private readonly logger = Logger.getInstance();

  // --- Public member getters ---

  readonly driveList: DriveInfo[] = [];
  readonly fileInfoList: FileRecord[] = [];
  readonly emitter: EventEmitter;

  get adminStamp(): PostageBatch | undefined {
    return this._adminStamp;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  // --- Initialization ---

  constructor(bee: Bee, emitter: EventEmitter = new EventEmitterBase()) {
    this.bee = bee;
    if (!this.bee.signer) {
      throw new SignerError('Signer required');
    }

    this.emitter = emitter;
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

    this.driveList.push(newDrive);
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
      this.driveList.length = 0;
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
    // TODO: possible performance improvement: store version next to stateFeedTopic
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
          this.driveList.push(driveInfo);
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
