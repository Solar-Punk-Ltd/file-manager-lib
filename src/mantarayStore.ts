import {
  type Bee,
  type BeeRequestOptions,
  FeedIndex,
  type MantarayNode,
  type PrivateKey,
  type RedundancyLevel,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { type DriveInfo, type FileRecord, type FolderInfo, type ManifestHost, NodeType } from './types/info';
import { type ActReferences, type FeedResultWithIndex } from './types/utils';
import { assertActReferences, assertFileRecord } from './utils/asserts';
import { type FeedWriteResult, getFeedData, writeActFeed } from './utils/bee';
import {
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  ROOT_PATH,
} from './utils/constants';
import { DriveError, FileRecordError } from './utils/errors';
import { loadMantaray, saveNodeManifest } from './utils/mantaray';
import { pathSegments } from './utils/path';

/**
 * Owns the two per-node caches and the resolve/load/save layer that reads and saves them.
 * FileManager delegates all path resolution and manifest feed I/O here,
 */
export class MantarayStore {
  private readonly signerAddress: string;
  private readonly nodeManifestCache: Map<string, MantarayNode> = new Map();
  private readonly nodeManifestLoading: Map<string, Promise<MantarayNode>> = new Map();
  private readonly nodeNextIndexCache: Map<string, bigint> = new Map();
  private readonly nodeRefCache: Map<string, ActReferences> = new Map();

  // --- Initialization ---

  constructor(
    private readonly bee: Bee,
    private readonly signer: PrivateKey,
  ) {
    this.signerAddress = signer.publicKey().address().toString();
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
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<{ host: ManifestHost; folder: FolderInfo | null }> {
    const folder = await this.resolveFolder(drive, path, publisher, requestOptions);
    return { host: folder ?? this.driveRootHost(drive), folder };
  }

  /** {@link resolveHost} plus the loaded mantaray node for that host — the common resolve→load→mutate entry point. */
  async resolveHostMantaray(
    drive: DriveInfo,
    path: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<{ host: ManifestHost; folder: FolderInfo | null; node: MantarayNode }> {
    const { host, folder } = await this.resolveHost(drive, path, publisher, requestOptions);
    const node = await this.getMantarayNode(host.topic, publisher, host.manifestRef, requestOptions);
    return { host, folder, node };
  }

  async getMantarayNode(
    topic: string,
    publisher: string,
    manifestRef?: ActReferences,
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
      const raw = await this.bee.data.download(
        manifestRef.reference,
        { actHistoryAddress: manifestRef.historyRef, actPublisher: publisher },
        requestOptions,
      );
      const node = await loadMantaray(this.bee, new Reference(raw), undefined, requestOptions);

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
  ): Promise<ActReferences> {
    const cachedWriteIx = this.getNodeNextIndexCache(host.topic);
    const prevManifestRef = this.getNodeRef(host.topic) ?? host.manifestRef;

    let contentRefs: ActReferences;
    let nextIndex: bigint;
    try {
      ({ contentRefs, nextIndex } = await saveNodeManifest(
        this.bee,
        this.signer,
        node,
        { ...host, manifestRef: prevManifestRef },
        cachedWriteIx,
        requestOptions,
      ));
    } catch (err: unknown) {
      this.evict(host.topic);
      throw err;
    }
    this.setNodeNextIndexCache(host.topic, nextIndex);
    this.setNodeRef(host.topic, contentRefs);

    return contentRefs;
  }

  /** Returns the refs written plus the feed index they landed on — the record's authoritative version. */
  async saveRecord(record: FileRecord, requestOptions?: BeeRequestOptions): Promise<FeedWriteResult> {
    const prevRef = this.getNodeRef(record.topic);

    // Derived state: every one of these is reconstructed by the manifest walk, so persisting them
    // would only create a second copy that can disagree with the tree.
    const persistable: FileRecord = { ...record };
    delete persistable.status;
    delete persistable.driveId;
    delete (persistable as Partial<FileRecord>).path;

    const { contentRefs, index, nextIndex } = await writeActFeed(
      this.bee,
      this.signer,
      JSON.stringify(persistable),
      {
        batchId: record.batchId,
        topic: record.topic,
        redundancyLevel: record.redundancyLevel,
        actHistoryAddress: prevRef?.historyRef,
        index: record.version !== undefined ? new FeedIndex(record.version).toBigInt() : undefined,
      },
      requestOptions,
    );
    this.setNodeNextIndexCache(record.topic, nextIndex);
    this.setNodeRef(record.topic, contentRefs);

    return { contentRefs, index, nextIndex };
  }

  async getRecord(
    topic: string,
    actPublisher: string,
    feedData: FeedResultWithIndex,
    options: { isHeadRead: boolean },
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord> {
    if (feedData.feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new FileRecordError(`File record not found for topic: ${topic.slice(0, 6)}`);
    }

    const contentRefs = feedData.payload.toJSON() as ActReferences;
    assertActReferences(contentRefs);

    const fileBytes = await this.bee.data.download(
      contentRefs.reference,
      { actHistoryAddress: contentRefs.historyRef, actPublisher },
      requestOptions,
    );

    const record = fileBytes.toJSON() as FileRecord;
    assertFileRecord(record);

    record.path = record.name;

    if (topic !== record.topic) {
      throw new FileRecordError(
        `Feed topic ${topic.slice(0, 6)} != record.topic ${record.topic.slice(0, 6)} for: ${record.path}`,
      );
    }

    record.version = feedData.feedIndex.toString();

    if (options.isHeadRead) {
      this.setNodeRef(topic, contentRefs);
      this.setNodeNextIndexCache(topic, new FeedIndex(record.version).next().toBigInt());
    }

    return record;
  }

  // --- Cache management  ---

  /** Cache a freshly loaded manifest under `topic` without touching its feed index. */
  setManifestCache(topic: string, node: MantarayNode): void {
    this.nodeManifestCache.set(topic, node);
  }

  /** The latest ACT ref written to `topic`'s feed — a manifest root or a file record. */
  getNodeRef(topic: string): ActReferences | undefined {
    return this.nodeRefCache.get(topic);
  }

  /** Record the latest ACT ref for `topic`'s feed. Used by feed writes that bypass {@link saveMantarayNode}. */
  setNodeRef(topic: string, refs: ActReferences): void {
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

  /** Clear all cached state */
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
  }

  // --- Private helpers  ---

  private driveRootHost(drive: DriveInfo): ManifestHost {
    return {
      owner: this.signerAddress,
      topic: drive.topic,
      manifestRef: drive.manifestRef,
      batchId: drive.batchId,
      redundancyLevel: drive.redundancyLevel,
      actPublisher: drive.actPublisher,
    };
  }

  private async resolveFolder(
    driveInfo: DriveInfo,
    path: string,
    publisher: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo | null> {
    if (!path || path === ROOT_PATH) return null;

    const segments = pathSegments(path);
    const driveRootHost = this.driveRootHost(driveInfo);
    let currentMantaray = await this.getMantarayNode(
      driveRootHost.topic,
      publisher,
      driveRootHost.manifestRef,
      requestOptions,
    );
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
      const folderManifestRef = await this.resolveFolderManifestRef(nodeTopic, currentPath, requestOptions);

      currentFolderInfo = {
        type: NodeType.Folder,
        owner: this.signerAddress,
        topic: nodeTopic,
        manifestRef: folderManifestRef,
        batchId: driveInfo.batchId,
        redundancyLevel: meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]
          ? (parseInt(meta[MANIFEST_METADATA_REDUNDANCY_LEVEL]) as RedundancyLevel)
          : driveInfo.redundancyLevel,
        path: currentPath,
        driveId: driveInfo.id,
        actPublisher: publisher,
      };

      currentMantaray = await this.getMantarayNode(
        currentFolderInfo.topic,
        publisher,
        currentFolderInfo.manifestRef,
        requestOptions,
      );
    }

    return currentFolderInfo;
  }

  // A folder carries no stored version, so its manifest root comes from its feed head.
  private async resolveFolderManifestRef(
    nodeTopic: string,
    currentPath: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<ActReferences> {
    const cachedRef = this.getNodeRef(nodeTopic);
    if (cachedRef && this.getManifestCache(nodeTopic) && this.getNodeNextIndexCache(nodeTopic) !== undefined) {
      return cachedRef;
    }

    const { payload, feedIndex, feedIndexNext } = await getFeedData(
      this.bee,
      new Topic(nodeTopic),
      this.signerAddress,
      undefined,
      requestOptions,
    );
    if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
      throw new DriveError(`Folder feed not found for path: ${currentPath}`);
    }

    const manifestRef: ActReferences = payload.toJSON() as ActReferences;
    assertActReferences(manifestRef);
    this.setNodeNextIndexCache(nodeTopic, feedIndexNext.toBigInt());

    return manifestRef;
  }
}
