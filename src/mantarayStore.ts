import {
  Bee,
  BeeRequestOptions,
  FeedIndex,
  MantarayNode,
  PrivateKey,
  RedundancyLevel,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { DriveInfo, FolderInfo, ManifestHost, NodeType } from './types/info';
import { ActReferences } from './types/utils';
import { assertActReferences } from './utils/asserts';
import { getFeedData } from './utils/bee';
import {
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  ROOT_PATH,
} from './utils/constants';
import { DriveError, FileInfoError } from './utils/errors';
import { loadMantaray, saveNodeManifest } from './utils/mantaray';

/**
 * Owns the two per-node caches and the resolve/load/save layer that reads and saves them.
 * FileManager delegates all path resolution and manifest feed I/O here,
 */
export class MantarayStore {
  private readonly signerAddress: string;
  private readonly nodeManifestCache: Map<string, MantarayNode> = new Map();
  private readonly nodeFeedIndexCache: Map<string, bigint> = new Map();
  private readonly nodeManifestRefCache: Map<string, ActReferences> = new Map();

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
    const cached = this.nodeManifestCache.get(topic);
    if (cached) return cached;

    if (!manifestRef) {
      throw new DriveError(`Node ${topic} has no manifestRef — cannot load manifest`);
    }

    const raw = await this.bee.downloadData(
      manifestRef.reference,
      { actHistoryAddress: manifestRef.historyRef, actPublisher: publisher },
      requestOptions,
    );
    const node = await loadMantaray(this.bee, new Reference(raw), undefined, requestOptions);

    this.nodeManifestCache.set(topic, node);
    this.nodeManifestRefCache.set(topic, manifestRef);

    return node;
  }

  async saveMantarayNode(
    node: MantarayNode,
    host: ManifestHost,
    requestOptions?: BeeRequestOptions,
  ): Promise<ActReferences> {
    const cachedWriteIx = this.nodeFeedIndexCache.get(host.topic);
    const prevManifestRef = this.nodeManifestRefCache.get(host.topic) ?? host.manifestRef;

    const { contentRefs, newIndex } = await saveNodeManifest(
      this.bee,
      this.signer,
      node,
      { ...host, manifestRef: prevManifestRef },
      cachedWriteIx,
      requestOptions,
    );
    this.nodeFeedIndexCache.set(host.topic, newIndex);
    this.nodeManifestRefCache.set(host.topic, contentRefs);

    return contentRefs;
  }

  getManifestRef(topic: string): ActReferences | undefined {
    return this.nodeManifestRefCache.get(topic);
  }

  // --- Helpers  ---

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

    const segments = path.split('/').filter(Boolean);
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
        throw new FileInfoError(`Folder fork missing topic: ${currentPath}`);
      }
      // Probe the feed head. A folder is a container and carries no stored version
      const {
        payload: folderPayload,
        feedIndex: folderFeedIndex,
        feedIndexNext: folderFeedIndexNext,
      } = await getFeedData(this.bee, new Topic(nodeTopic), this.signerAddress, undefined, requestOptions);
      if (folderFeedIndex.equals(FeedIndex.MINUS_ONE)) {
        throw new DriveError(`Folder feed not found for path: ${currentPath}`);
      }
      const folderManifestRef: ActReferences = folderPayload.toJSON() as ActReferences;
      assertActReferences(folderManifestRef);

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

      this.setNodeFeedIndex(nodeTopic, folderFeedIndexNext.toBigInt());
    }

    return currentFolderInfo;
  }

  // --- Cache management  ---

  /** Cache a freshly loaded manifest under `topic` without touching its feed index. */
  setManifestCache(topic: string, node: MantarayNode): void {
    this.nodeManifestCache.set(topic, node);
  }

  /** The cached manifest for `topic`, or undefined if it was never loaded/seeded. */
  getManifestCache(topic: string): MantarayNode | undefined {
    return this.nodeManifestCache.get(topic);
  }

  /** Prime the next feed-write index for `topic` (typically a probed `feedIndexNext`). */
  setNodeFeedIndex(topic: string, nextIndex: bigint): void {
    this.nodeFeedIndexCache.set(topic, nextIndex);
  }

  /** Clear all cached state */
  evict(topic: string): void {
    this.nodeManifestCache.delete(topic);
    this.nodeFeedIndexCache.delete(topic);
    this.nodeManifestRefCache.delete(topic);
  }

  /** Drop all cached state */
  clear(): void {
    this.nodeManifestCache.clear();
    this.nodeFeedIndexCache.clear();
    this.nodeManifestRefCache.clear();
  }
}
