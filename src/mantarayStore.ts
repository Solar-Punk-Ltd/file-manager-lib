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
  type ResolvedFileFork,
} from './types/info';
import type { GrantBlob, ShareFeedHead, ShareHandle } from './types/share';
import { type SwarmClient } from './types/swarmClient';
import { type ContentRef, type FeedResultWithIndex, type FeedTarget, type FeedWriteResult } from './types/utils';
import { assertFileRecord } from './utils/asserts';
import {
  feedGen,
  getFeedData,
  openFeedRef,
  openGrantBlob,
  readShareHead,
  writeEncryptedFeed,
  writePlainFeed,
} from './utils/bee';
import {
  FEED_INDEX_NONE,
  MANIFEST_METADATA_NODE_OWNER,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  MANIFEST_METADATA_SHARE_TOPIC,
  ROOT_PATH,
} from './utils/constants';
import { DriveError, FileRecordError, FolderError, IdentityError, KeyringError, ShareError } from './utils/errors';
import {
  getAllNodeEntries,
  getRlevel,
  loadMantaray,
  saveNodeManifest,
  withoutWrappedKeys,
  wrappedKeysFromMetadata,
  wrappedKeysMetadata,
} from './utils/mantaray';
import { normalizePath, pathSegments, splitPath } from './utils/path';
import { grantNodeKeys } from './utils/share';
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
  private readonly nodeGenCache: Map<string, number> = new Map();
  private readonly grantHandles: Map<string, ShareHandle> = new Map();
  private readonly renewals: Map<string, Promise<void>> = new Map();
  private rotations = 0;

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

  /** How many nodes this store has rotated. A change since it was last read means a grant may be due a re-issue. */
  get rotationCount(): number {
    return this.rotations;
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

  /**
   * {@link resolveHostMantaray} on the node's *parent*, plus the fork that names it.
   *
   * The entry point for anything that mutates a node in place — the parent's loaded manifest comes
   * back with it, since that is what has to be saved afterwards.
   */
  async resolveNodeFork(
    drive: DriveInfo,
    absolutePath: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<ResolvedFileFork> {
    const { parentPath, name: filename } = splitPath(absolutePath);

    const {
      host: parentHost,
      folder: parentFolder,
      node: parentNode,
    } = await this.resolveHostMantaray(drive, parentPath, requestOptions);
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

  /**
   * {@link resolveNodeFork} for a caller that already knows which node it expects to find.
   *
   * A path is not an identity — a node can be moved out and another moved in under the same name —
   * so a write addressed by path has to confirm the fork still belongs to the node it came for.
   */
  async resolveFileFork(
    drive: DriveInfo,
    absolutePath: string,
    expectedTopic: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<ResolvedFileFork> {
    const fork = await this.resolveNodeFork(drive, absolutePath, requestOptions);

    if (fork.metadata[MANIFEST_METADATA_NODE_TOPIC] !== expectedTopic) {
      throw new FileRecordError(
        `Fork at ${absolutePath} belongs to a different node than ${expectedTopic.slice(0, 6)} — refusing to write its version`,
      );
    }

    return fork;
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
      const gen = this.genOf(topic);
      await this.renewIfBehind(topic, gen);
      const key = await this.keyring.metaSealKey(topic, gen);
      const node = await loadMantaray(this.swarmClient, manifestRef.reference, key, undefined, requestOptions);

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
    this.assertFresh(host.topic);
    const cachedWriteIx = this.getNodeNextIndexCache(host.topic);
    const gen = this.keyring.genOf(host.topic);
    const key = await this.keyring.metaSealKey(host.topic, gen);

    let contentRef: ContentRef;
    let nextIndex: bigint;
    try {
      ({ contentRef, nextIndex } = await saveNodeManifest(
        this.swarmClient,
        this.requireIdentity(),
        node,
        host,
        key,
        gen,
        cachedWriteIx,
        requestOptions,
      ));
    } catch (err: unknown) {
      this.evict(host.topic);
      throw err;
    }
    this.setNodeNextIndexCache(host.topic, nextIndex);
    this.setNodeRef(host.topic, contentRef);
    this.nodeGenCache.set(host.topic, gen);

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

    this.assertFresh(record.topic);
    const gen = this.keyring.genOf(record.topic);
    const key = await this.keyring.contentSealKey(record.topic, gen);

    const { contentRef, index, nextIndex } = await writeEncryptedFeed(
      this.swarmClient,
      this.requireIdentity(),
      JSON.stringify(persistable),
      key,
      gen,
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
    this.nodeGenCache.set(record.topic, gen);

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
    this.assertFresh(node.topic);
    const gen = this.keyring.genOf(node.topic);
    const key = await this.keyring.contentSealKey(node.topic, gen);

    const result = await writeEncryptedFeed(
      this.swarmClient,
      this.requireIdentity(),
      JSON.stringify(document),
      key,
      gen,
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
    this.nodeGenCache.set(node.topic, gen);

    return result;
  }

  /**
   * Write a share feed head.
   *
   * In the clear, unlike every other feed this library writes: the head is an ACT address, and an
   * ACT address resolves to nothing outside its grantee list.
   */
  async savePublicHead(target: FeedTarget, head: ShareFeedHead, requestOptions?: BeeRequestOptions): Promise<void> {
    const index = target.index ?? this.getNodeNextIndexCache(target.topic);
    const { nextIndex } = await writePlainFeed(
      this.swarmClient,
      this.requireIdentity(),
      JSON.stringify(head),
      { ...target, index },
      requestOptions,
    );

    this.setNodeNextIndexCache(target.topic, nextIndex);
  }

  /**
   * The document at a control node's feed head, as parsed JSON and nothing more.
   *
   * Unvalidated on purpose: the store moves control documents, it does not know what any of them
   * mean — the node's owner is what turns this into entries. Undefined when the feed has no update
   * yet, a control node provisioned but never written.
   */
  async loadControlDocument(topic: string, requestOptions?: BeeRequestOptions): Promise<unknown> {
    const { payload, feedIndex, feedIndexNext } = await getFeedData(
      this.swarmClient,
      new Topic(topic),
      this.requireIdentity().owner,
      undefined,
      requestOptions,
    );
    if (feedIndex.equals(FEED_INDEX_NONE)) return undefined;

    const contentRef = await openFeedRef(payload, await this.contentKeyAt(topic, payload));
    const bytes = await this.swarmClient.downloadData(contentRef.reference, undefined, requestOptions);

    this.setNodeRef(topic, contentRef);
    this.setNodeNextIndexCache(topic, feedIndexNext.toBigInt());

    return new Bytes(bytes).toJSON();
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

    const contentRef = await openFeedRef(feedData.payload, await this.contentKeyAt(topic, feedData.payload));
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
   *
   * `owner` is the node's, not this identity's — inside a mount every feed belongs to the sharer.
   */
  async resolveManifestRef(
    nodeTopic: string,
    owner: string,
    label: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<ContentRef> {
    const cachedRef = this.getNodeRef(nodeTopic);
    if (cachedRef && this.getManifestCache(nodeTopic) && this.getNodeNextIndexCache(nodeTopic) !== undefined) {
      return cachedRef;
    }

    const { payload, feedIndex, feedIndexNext } = await getFeedData(
      this.swarmClient,
      new Topic(nodeTopic),
      owner,
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
    const gen = await this.noteHeadGen(topic, payload);

    return await openFeedRef(payload, await this.keyring.metaSealKey(topic, gen));
  }

  // As the node's last-read head declared, falling back to the held one for a node written but not read back.
  private genOf(topic: string): number {
    return this.nodeGenCache.get(topic) ?? this.keyring.genOf(topic);
  }

  private async contentKeyAt(topic: string, payload: Bytes): Promise<CryptoKey> {
    const gen = await this.noteHeadGen(topic, payload);

    return await this.keyring.contentSealKey(topic, gen);
  }

  private async noteHeadGen(topic: string, payload: Bytes): Promise<number> {
    const gen = feedGen(payload);
    await this.keyring.noteGen(topic, gen);
    this.nodeGenCache.set(topic, gen);
    await this.renewIfBehind(topic, gen);

    return gen;
  }

  // --- Key chain ---

  /** Recover a child's keys from its fork metadata, sealed under `parentTopic`'s. */
  async unwrapFork(parentTopic: string, childTopic: string, meta: Record<string, string>): Promise<NodeKeys> {
    const wrapped = wrappedKeysFromMetadata(meta);
    const shareTopic = meta[MANIFEST_METADATA_SHARE_TOPIC];
    const owner = meta[MANIFEST_METADATA_NODE_OWNER];
    if (shareTopic && owner) {
      this.trackGrant(childTopic, { shareTopic, owner });
    }

    await this.keyring.noteGen(parentTopic, wrapped.parentGen);
    await this.renewIfBehind(parentTopic, wrapped.parentGen);

    return await this.keyring.unwrapChild(parentTopic, childTopic, wrapped, Boolean(shareTopic));
  }

  /** Remember where a mount's grant is published, so its keys can be renewed once its sharer rotates them. */
  trackGrant(topic: string, handle: ShareHandle): void {
    this.grantHandles.set(topic, handle);
  }

  /** Stop following an unmounted grant and drop its keys. */
  releaseGrant(topic: string): void {
    this.grantHandles.delete(topic);
    this.keyring.drop(topic);
  }

  /**
   * Re-seal a fork's keys for a new parent, returning the metadata to store there.
   *
   * Required on every relocation — move, trash, recover. A fork copied verbatim into another
   * manifest carries keys wrapped under its old parent, so it lists correctly and opens for nobody.
   * The node rotates on the way: whoever reached it through its old place stops following it, as
   * after a delete.
   */
  async rewrapFork(
    fromParentTopic: string,
    toParentTopic: string,
    childTopic: string,
    meta: Record<string, string>,
  ): Promise<Record<string, string>> {
    await this.unwrapFork(fromParentTopic, childTopic, meta);
    await this.keyring.bump(childTopic);
    this.rotations++;

    const wrapped = await this.keyring.wrapFor(toParentTopic, childTopic);

    return { ...withoutWrappedKeys(meta), ...wrappedKeysMetadata(wrapped) };
  }

  /**
   * Rotate every node on the way to `path` that lags its parent's generation, top down, so each is
   * re-wrapped under a parent that already moved on. Required before writing anything at or below
   * `path`: the save guard refuses a write that skipped it.
   */
  async prepareWrite(drive: DriveInfo, path: string, requestOptions?: BeeRequestOptions): Promise<void> {
    const nodePath = normalizePath(path);
    if (!nodePath) return;

    const { parentPath, name } = splitPath(nodePath);
    const folder = await this.resolveFolder(drive, parentPath, requestOptions, true);
    const host = folder ?? (await this.driveRootHost(drive, requestOptions));
    const node = await this.getMantarayNode(host.topic, host.manifestRef, requestOptions);

    const meta = node.find(name)?.metadata;
    const topic = meta?.[MANIFEST_METADATA_NODE_TOPIC];
    if (!meta || !topic) return;

    await this.unwrapFork(host.topic, topic, meta);
    if (this.keyring.isStale(topic)) {
      await this.rotateFork(drive, host, node, name, requestOptions);
    }
  }

  /**
   * Rotate the node at `path` one generation on, or up to its floor. Only its fork in the parent is
   * re-written, not its own head.
   */
  async rotateNode(drive: DriveInfo, path: string, topic: string, requestOptions?: BeeRequestOptions): Promise<void> {
    const { parentPath, name } = splitPath(normalizePath(path));
    await this.prepareWrite(drive, parentPath, requestOptions);

    const { host, node } = await this.resolveHostMantaray(drive, parentPath, requestOptions);
    const meta = node.find(name)?.metadata;
    if (!meta || meta[MANIFEST_METADATA_NODE_TOPIC] !== topic) {
      throw new FileRecordError(`Fork at ${path} belongs to a different node than ${topic.slice(0, 6)}`);
    }

    await this.unwrapFork(host.topic, topic, meta);
    await this.rotateFork(drive, host, node, name, requestOptions);
  }

  /** Where `topic` sits in `drive`, trash included, found by walking the whole tree. */
  async locate(drive: DriveInfo, topic: string, requestOptions?: BeeRequestOptions): Promise<string | undefined> {
    let frontier: { host: ManifestHost; path: string }[] = [
      { host: await this.driveRootHost(drive, requestOptions), path: '' },
    ];

    while (frontier.length > 0) {
      const next: { host: ManifestHost; path: string }[] = [];
      for (const { host, path } of frontier) {
        const node = await this.getMantarayNode(host.topic, host.manifestRef, requestOptions);

        for (const entry of getAllNodeEntries(node)) {
          const entryPath = path ? `${path}/${entry.path}` : entry.path;
          if (entry.topic === topic) return entryPath;
          if (entry.type !== NodeType.Folder) continue;

          await this.unwrapFork(host.topic, entry.topic, entry.rawMetadata);
          const owner = entry.owner ?? drive.owner;
          next.push({
            host: {
              owner,
              topic: entry.topic,
              manifestRef: await this.resolveManifestRef(entry.topic, owner, `folder ${entryPath}`, requestOptions),
              batchId: drive.batchId,
              redundancyLevel: getRlevel(entry.rawMetadata, drive.redundancyLevel),
            },
            path: entryPath,
          });
        }
      }

      frontier = next;
    }

    return undefined;
  }

  private async rotateFork(
    drive: DriveInfo,
    host: ManifestHost,
    node: MantarayNode,
    name: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<void> {
    const fork = node.find(name);
    const meta = fork?.metadata;
    const topic = meta?.[MANIFEST_METADATA_NODE_TOPIC];
    if (!fork || !meta || !topic) {
      throw new FolderError(`Path not found: ${name}`);
    }

    await this.keyring.bump(topic);
    this.rotations++;

    const target = fork.targetAddress;
    const wrapped = await this.keyring.wrapFor(host.topic, topic);
    node.removeFork(name);
    node.addFork(name, target, { ...withoutWrappedKeys(meta), ...wrappedKeysMetadata(wrapped) });

    let manifestRef: ContentRef;
    try {
      manifestRef = await this.saveMantarayNode(node, host, requestOptions);
    } catch (err: unknown) {
      // Not rolled back: the save may have landed anyway, and a node sealed below its rotation is
      // open to whoever the rotation withdrew. Its next write re-wraps it instead.
      this.keyring.markForkLag(topic);
      throw err;
    }
    if (host.topic === drive.topic) {
      drive.manifestRef = manifestRef;
    }
  }

  // The one check every write passes through: sealing under a generation a rotation above has
  // already withdrawn would hand the write to whoever it was withdrawn from.
  private assertFresh(topic: string): void {
    if (this.keyring.isStale(topic)) {
      throw new KeyringError(`Node ${topic.slice(0, 6)} is due a key rotation — its path was not prepared first`);
    }
  }

  // A mount whose sharer rotated past its grant re-reads the grant before opening anything under it.
  private async renewIfBehind(topic: string, gen: number): Promise<void> {
    if (!this.keyring.behind(topic, gen) || !this.grantHandles.has(topic)) return;

    let renewal = this.renewals.get(topic);
    if (!renewal) {
      renewal = this.renewGrant(topic).finally(() => this.renewals.delete(topic));
      this.renewals.set(topic, renewal);
    }

    await renewal;
  }

  private async renewGrant(topic: string): Promise<void> {
    const handle = this.grantHandles.get(topic);
    if (!handle) return;

    let blob: GrantBlob;
    try {
      blob = await openGrantBlob(this.swarmClient, await readShareHead(this.swarmClient, handle));
    } catch (err: unknown) {
      throw new ShareError(`The grant for ${topic.slice(0, 6)} could not be renewed`, err);
    }
    if (blob.topic !== topic) {
      throw new ShareError(`The share feed for ${topic.slice(0, 6)} now carries a grant for another node`);
    }

    const { meta } = await this.keyring.requireKeys(topic);
    this.keyring.renew(topic, grantNodeKeys(blob, meta), blob.gen);
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
    this.nodeGenCache.delete(topic);
  }

  /** Drop all cached state */
  clear(): void {
    this.nodeManifestCache.clear();
    this.nodeManifestLoading.clear();
    this.nodeNextIndexCache.clear();
    this.nodeRefCache.clear();
    this.nodeGenCache.clear();
    this.grantHandles.clear();
    this.renewals.clear();
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
      drive.manifestRef = await this.resolveManifestRef(
        drive.topic,
        drive.owner,
        `drive "${drive.name}"`,
        requestOptions,
      );
    }

    return {
      owner: drive.owner,
      topic: drive.topic,
      manifestRef: drive.manifestRef,
      batchId: drive.batchId,
      redundancyLevel: drive.redundancyLevel,
    };
  }

  // With `rotate`, every folder on the way that lags its parent is rotated before it is descended into.
  private async resolveFolder(
    driveInfo: DriveInfo,
    path: string,
    requestOptions?: BeeRequestOptions,
    rotate: boolean = false,
  ): Promise<FolderInfo | null> {
    if (!path || path === ROOT_PATH) return null;

    const segments = pathSegments(path);
    let currentHost: ManifestHost = await this.driveRootHost(driveInfo, requestOptions);
    let currentMantaray = await this.getMantarayNode(currentHost.topic, currentHost.manifestRef, requestOptions);
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

      await this.unwrapFork(currentHost.topic, nodeTopic, meta);
      if (rotate && this.keyring.isStale(nodeTopic)) {
        await this.rotateFork(driveInfo, currentHost, currentMantaray, segment, requestOptions);
      }

      const owner = meta[MANIFEST_METADATA_NODE_OWNER] ?? driveInfo.owner;
      const folderManifestRef = await this.resolveManifestRef(
        nodeTopic,
        owner,
        `folder ${currentPath}`,
        requestOptions,
      );

      currentFolderInfo = {
        type: NodeType.Folder,
        owner,
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
      currentHost = currentFolderInfo;
    }

    return currentFolderInfo;
  }
}
