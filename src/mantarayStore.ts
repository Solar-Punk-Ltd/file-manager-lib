import type { BeeRequestOptions, RedundancyLevel } from '@ethersphere/bee-js';
import { Bytes, FeedIndex, type MantarayNode, Topic } from '@ethersphere/core-sdk';

import type { NodeKeys } from './types/crypto';
import type { Identity } from './types/identity';
import {
  type ControlDocument,
  type ControlNode,
  type DriveInfo,
  type FileRecord,
  type FolderInfo,
  type ManifestHost,
  NodeType,
} from './types/info';
import type { ShareFeedHead } from './types/share';
import { type SwarmClient } from './types/swarmClient';
import { type ContentRef, type FeedResultWithIndex, type FeedTarget, type FeedWriteResult } from './types/utils';
import { assertFileRecord } from './utils/asserts';
import { getFeedData, openFeedRef, writeEncryptedFeed } from './utils/bee';
import {
  FEED_INDEX_NONE,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  ROOT_PATH,
} from './utils/constants';
import { DriveError, FileRecordError, IdentityError } from './utils/errors';
import { loadMantaray, saveNodeManifest, wrappedKeysFromMetadata, wrappedKeysMetadata } from './utils/mantaray';
import { pathSegments } from './utils/path';
import { Keyring } from './keyring';

/**
 * Owns the per-node caches, the key chain, and the resolve/load/save layer that reads and saves
 * them. FileManager delegates all path resolution and manifest feed I/O here,
 */
export class MantarayStore {
  private readonly swarmClient: SwarmClient;
  private _identity: Identity | undefined = undefined;
  private _keyring: Keyring | undefined = undefined;
  private readonly nodeManifestCache: Map<string, MantarayNode> = new Map();
  private readonly nodeManifestLoading: Map<string, Promise<MantarayNode>> = new Map();
  private readonly nodeNextIndexCache: Map<string, bigint> = new Map();
  private readonly nodeRefCache: Map<string, ContentRef> = new Map();

  // --- Initialization ---

  constructor(swarmClient: SwarmClient) {
    this.swarmClient = swarmClient;
  }

  /**
   * Bind the store to the identity that owns and signs every feed it touches, and open a fresh key
   * chain rooted in its FMK. Set after construction, since resolving the identity needs the client.
   *
   * Not folded into `clear()`, which is called mid-flight by `createAdminDrive(reset)`.
   */
  setIdentity(identity: Identity | undefined): void {
    this._identity = identity;
    this._keyring = identity ? new Keyring(identity) : undefined;
  }

  get identity(): Identity | undefined {
    return this._identity;
  }

  /** The key chain for the current identity. */
  get keyring(): Keyring {
    if (!this._keyring) {
      throw new IdentityError('No keyring found — FileManager is not initialized');
    }

    return this._keyring;
  }

  // --- Swarm operations  ---

  /**
   * Resolve a path within a drive to the manifest host that owns it: the folder at `path`, or the
   * drive root when `path` is empty/root. `folder` is null in the drive-root case — callers use
   * that to decide whether to write back to DriveInfo.manifestRef vs a folder's own feed.
   */
  async resolveHost(
    drive: DriveInfo,
    path: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<{ host: ManifestHost; folder: FolderInfo | null }> {
    const folder = await this.resolveFolder(drive, path, requestOptions);
    return { host: folder ?? (await this.driveRootHost(drive, requestOptions)), folder };
  }

  /** {@link resolveHost} plus the loaded mantaray node for that host — the common resolve→load→mutate entry point. */
  async resolveHostMantaray(
    drive: DriveInfo,
    path: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<{ host: ManifestHost; folder: FolderInfo | null; node: MantarayNode }> {
    const { host, folder } = await this.resolveHost(drive, path, requestOptions);
    const node = await this.getMantarayNode(host.topic, host.manifestRef, requestOptions);
    return { host, folder, node };
  }

  async getMantarayNode(
    topic: string,
    manifestRef?: ContentRef,
    requestOptions?: BeeRequestOptions,
  ): Promise<MantarayNode> {
    const cached = this.getManifestCache(topic);
    if (cached) return cached;

    const inFlight = this.nodeManifestLoading.get(topic);
    if (inFlight) return inFlight;

    if (!manifestRef) {
      throw new DriveError(`Node ${topic} has no manifestRef — cannot load manifest`);
    }

    // Concurrent getMantarayNode calls for the same but not yet cached topic must share one load (and thus one MantarayNode instance) — otherwise
    // each caller mutates its own copy and all but the last are dropped before the batched save.
    const loadPromise = (async (): Promise<MantarayNode> => {
      const { meta } = await this.keyring.requireKeys(topic);
      const node = await loadMantaray(this.swarmClient, manifestRef.reference, meta, undefined, requestOptions);

      this.setManifestCache(topic, node);
      this.setNodeRef(topic, manifestRef);

      return node;
    })();

    this.nodeManifestLoading.set(topic, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.nodeManifestLoading.delete(topic);
    }
  }

  async saveMantarayNode(
    node: MantarayNode,
    host: ManifestHost,
    requestOptions?: BeeRequestOptions,
  ): Promise<ContentRef> {
    const cachedWriteIx = this.getNodeNextIndexCache(host.topic);
    const { meta } = await this.keyring.requireKeys(host.topic);

    let contentRef: ContentRef;
    let nextIndex: bigint;
    try {
      ({ contentRef, nextIndex } = await saveNodeManifest(
        this.swarmClient,
        this.requireIdentity(),
        node,
        host,
        meta,
        cachedWriteIx,
        requestOptions,
      ));
    } catch (err: unknown) {
      this.evict(host.topic);
      throw err;
    }
    this.setNodeNextIndexCache(host.topic, nextIndex);
    this.setNodeRef(host.topic, contentRef);

    return contentRef;
  }

  /** Returns the ref written plus the feed index it landed on — the record's authoritative version. */
  async saveRecord(record: FileRecord, requestOptions?: BeeRequestOptions): Promise<FeedWriteResult> {
    // Derived state: every one of these is reconstructed by the manifest walk, so persisting them
    // would only create a second copy that can disagree with the tree.
    const persistable: FileRecord = { ...record };
    delete persistable.status;
    delete persistable.driveId;
    delete (persistable as Partial<FileRecord>).path;

    const { content } = await this.keyring.requireKeys(record.topic);

    const { contentRef, index, nextIndex } = await writeEncryptedFeed(
      this.swarmClient,
      this.requireIdentity(),
      JSON.stringify(persistable),
      content,
      {
        batchId: record.batchId,
        topic: record.topic,
        redundancyLevel: record.redundancyLevel,
        index: record.version !== undefined ? new FeedIndex(record.version).toBigInt() : undefined,
      },
      requestOptions,
    );
    this.setNodeNextIndexCache(record.topic, nextIndex);
    this.setNodeRef(record.topic, contentRef);

    return { contentRef, index, nextIndex };
  }

  /**
   * Write a control node's document as its new feed head.
   *
   * Content-keyed like a file: a control node has no manifest, so nothing above it needs `K_meta`.
   */
  async saveControlDocument(
    node: ControlNode,
    document: ControlDocument,
    requestOptions?: BeeRequestOptions,
  ): Promise<FeedWriteResult> {
    const { content } = await this.keyring.requireKeys(node.topic);

    const result = await writeEncryptedFeed(
      this.swarmClient,
      this.requireIdentity(),
      JSON.stringify(document),
      content,
      {
        batchId: node.batchId,
        topic: node.topic,
        redundancyLevel: node.redundancyLevel,
        index: this.getNodeNextIndexCache(node.topic),
      },
      requestOptions,
    );
    this.setNodeNextIndexCache(node.topic, result.nextIndex);
    this.setNodeRef(node.topic, result.contentRef);

    return result;
  }

  // TODO: this seems to be doing the same feed and node cache operations as the others
  /**
   * Write a share feed head — the stable handle behind every grant.
   *
   * In the clear, unlike every other feed this library writes: the head is an ACT address, and an
   * ACT address resolves to nothing outside its grantee list.
   */
  async saveShareHead(target: FeedTarget, head: ShareFeedHead, requestOptions?: BeeRequestOptions): Promise<void> {
    const identity = this.requireIdentity();

    let index = target.index ?? this.getNodeNextIndexCache(target.topic);
    if (index === undefined) {
      const { feedIndexNext } = await getFeedData(
        this.swarmClient,
        new Topic(target.topic),
        identity.owner,
        undefined,
        requestOptions,
      );
      index = feedIndexNext.toBigInt();
    }

    await this.swarmClient.writeFeed(
      target.batchId,
      target.topic,
      JSON.stringify(head),
      index.toString(),
      { signer: identity.signer, redundancyLevel: target.redundancyLevel },
      requestOptions,
    );

    this.setNodeNextIndexCache(target.topic, index + 1n);
  }

  /** Undefined when the node's feed has no update yet — a control node provisioned but never written. */
  async loadControlDocument(topic: string, requestOptions?: BeeRequestOptions): Promise<ControlDocument | undefined> {
    const { payload, feedIndex, feedIndexNext } = await getFeedData(
      this.swarmClient,
      new Topic(topic),
      this.requireIdentity().owner,
      undefined,
      requestOptions,
    );
    if (feedIndex.equals(FEED_INDEX_NONE)) return undefined;

    const { content } = await this.keyring.requireKeys(topic);
    const contentRef = await openFeedRef(payload, content);
    const bytes = await this.swarmClient.downloadData(contentRef.reference, undefined, requestOptions);

    this.setNodeRef(topic, contentRef);
    this.setNodeNextIndexCache(topic, feedIndexNext.toBigInt());

    return new Bytes(bytes).toJSON() as ControlDocument;
  }

  async getRecord(
    topic: string,
    feedData: FeedResultWithIndex,
    options: { isHeadRead: boolean },
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    if (feedData.feedIndex.equals(FEED_INDEX_NONE)) {
      throw new FileRecordError(`File record not found for topic: ${topic.slice(0, 6)}`);
    }

    const { content } = await this.keyring.requireKeys(topic);
    const contentRef = await openFeedRef(feedData.payload, content);
    const fileBytes = await this.swarmClient.downloadData(contentRef.reference, undefined, requestOptions);

    const record = new Bytes(fileBytes).toJSON() as FileRecord;
    assertFileRecord(record);

    record.path = record.name;

    if (topic !== record.topic) {
      throw new FileRecordError(
        `Feed topic ${topic.slice(0, 6)} != record.topic ${record.topic.slice(0, 6)} for: ${record.path}`,
      );
    }

    record.version = feedData.feedIndex.toString();

    if (options.isHeadRead) {
      this.setNodeRef(topic, contentRef);
      this.setNodeNextIndexCache(topic, new FeedIndex(record.version).next().toBigInt());
    }

    return record;
  }

  /**
   * A manifest host carries no stored version, so its mantaray root comes from its feed head. Caches
   * the probed next index, which is what lets a later write to the same host skip its own probe.
   *
   * Drives and folders both land here, on first touch rather than at init: a host's identity lives
   * in its parent's fork metadata, and only its current root needs the network.
   */
  async resolveManifestRef(nodeTopic: string, label: string, requestOptions?: BeeRequestOptions): Promise<ContentRef> {
    const cachedRef = this.getNodeRef(nodeTopic);
    if (cachedRef && this.getManifestCache(nodeTopic) && this.getNodeNextIndexCache(nodeTopic) !== undefined) {
      return cachedRef;
    }

    const { payload, feedIndex, feedIndexNext } = await getFeedData(
      this.swarmClient,
      new Topic(nodeTopic),
      this.requireIdentity().owner,
      undefined,
      requestOptions,
    );
    if (feedIndex.equals(FEED_INDEX_NONE)) {
      throw new DriveError(`Manifest feed not found for ${label}`);
    }

    const manifestRef = await this.openManifestRef(nodeTopic, payload);
    this.setNodeNextIndexCache(nodeTopic, feedIndexNext.toBigInt());

    return manifestRef;
  }

  /**
   * Unseal a manifest host's feed payload into the mantaray root reference it carries.
   *
   * The one place a feed payload is opened for a folder, drive or the state node — callers hold the
   * payload, the store holds the key.
   */
  async openManifestRef(topic: string, payload: Bytes): Promise<ContentRef> {
    const { meta } = await this.keyring.requireKeys(topic);

    return await openFeedRef(payload, meta);
  }

  // --- Key chain ---

  /** Recover a child's keys from its fork metadata, sealed under `parentTopic`'s. */
  async unwrapFork(parentTopic: string, childTopic: string, meta: Record<string, string>): Promise<NodeKeys> {
    return await this.keyring.unwrapChild(parentTopic, childTopic, wrappedKeysFromMetadata(meta));
  }

  /**
   * Re-seal a fork's keys for a new parent, returning the metadata to store there.
   *
   * Required on every relocation — move, trash, recover. A fork copied verbatim into another
   * manifest carries keys wrapped under its old parent, so it lists correctly and opens for nobody.
   */
  async rewrapFork(
    fromParentTopic: string,
    toParentTopic: string,
    childTopic: string,
    meta: Record<string, string>,
  ): Promise<Record<string, string>> {
    await this.unwrapFork(fromParentTopic, childTopic, meta);

    return { ...meta, ...wrappedKeysMetadata(await this.keyring.wrapFor(toParentTopic, childTopic)) };
  }

  // --- Cache management  ---

  /** Cache a freshly loaded manifest under `topic` without touching its feed index. */
  setManifestCache(topic: string, node: MantarayNode): void {
    this.nodeManifestCache.set(topic, node);
  }

  /**
   * The reference `topic`'s feed head currently resolves to — a mantaray root for a manifest host,
   * a record blob for a file. **Opened**, which is what makes it a cache: holding it is what lets a
   * later read skip both the feed fetch and the unseal. The feed itself holds this sealed.
   */
  getNodeRef(topic: string): ContentRef | undefined {
    return this.nodeRefCache.get(topic);
  }

  /** Record what `topic`'s feed head resolves to. Used by feed writes that bypass {@link saveMantarayNode}. */
  setNodeRef(topic: string, refs: ContentRef): void {
    this.nodeRefCache.set(topic, refs);
  }

  /** The cached manifest for `topic`, or undefined if it was never loaded/seeded. */
  getManifestCache(topic: string): MantarayNode | undefined {
    return this.nodeManifestCache.get(topic);
  }

  /** Prime the next feed-write index for `topic` (typically a probed `feedIndexNext`). */
  setNodeNextIndexCache(topic: string, nextIndex: bigint): void {
    this.nodeNextIndexCache.set(topic, nextIndex);
  }

  /** The cached next feed-write index for `topic` */
  getNodeNextIndexCache(topic: string): bigint | undefined {
    return this.nodeNextIndexCache.get(topic);
  }

  /**
   * Clear all cached state for one node.
   *
   * Its keys are kept: they are not recoverable once dropped, since the only other copy is wrapped
   * in a parent manifest this store may no longer be able to reach.
   */
  evict(topic: string): void {
    this.nodeManifestCache.delete(topic);
    this.nodeManifestLoading.delete(topic);
    this.nodeNextIndexCache.delete(topic);
    this.nodeRefCache.delete(topic);
  }

  /** Drop all cached state */
  clear(): void {
    this.nodeManifestCache.clear();
    this.nodeManifestLoading.clear();
    this.nodeNextIndexCache.clear();
    this.nodeRefCache.clear();
    this._keyring?.clear();
  }

  requireIdentity(): Identity {
    if (!this._identity) {
      throw new IdentityError('No identity found — FileManager is not initialized');
    }

    return this._identity;
  }

  // --- Private helpers  ---

  private async driveRootHost(drive: DriveInfo, requestOptions?: BeeRequestOptions): Promise<ManifestHost> {
    if (!drive.manifestRef) {
      drive.manifestRef = await this.resolveManifestRef(drive.topic, `drive "${drive.name}"`, requestOptions);
    }

    return {
      owner: this.requireIdentity().owner,
      topic: drive.topic,
      manifestRef: drive.manifestRef,
      batchId: drive.batchId,
      redundancyLevel: drive.redundancyLevel,
    };
  }

  private async resolveFolder(
    driveInfo: DriveInfo,
    path: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo | null> {
    if (!path || path === ROOT_PATH) return null;

    const segments = pathSegments(path);
    const driveRootHost = await this.driveRootHost(driveInfo, requestOptions);
    let currentMantaray = await this.getMantarayNode(driveRootHost.topic, driveRootHost.manifestRef, requestOptions);
    let currentTopic = driveRootHost.topic;
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

      const nodeTopic = meta[MANIFEST_METADATA_NODE_TOPIC];
      if (!nodeTopic) {
        throw new FileRecordError(`Folder fork missing topic: ${currentPath}`);
      }

      await this.unwrapFork(currentTopic, nodeTopic, meta);
      const folderManifestRef = await this.resolveManifestRef(nodeTopic, `folder ${currentPath}`, requestOptions);

      currentFolderInfo = {
        type: NodeType.Folder,
        owner: this.requireIdentity().owner,
        topic: nodeTopic,
        manifestRef: folderManifestRef,
        batchId: driveInfo.batchId,
        redundancyLevel: meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]
          ? (parseInt(meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]) as RedundancyLevel)
          : driveInfo.redundancyLevel,
        path: currentPath,
        driveId: driveInfo.id,
      };

      currentMantaray = await this.getMantarayNode(
        currentFolderInfo.topic,
        currentFolderInfo.manifestRef,
        requestOptions,
      );
      currentTopic = nodeTopic;
    }

    return currentFolderInfo;
  }
}
