import { Bytes, FeedIndex, Reference, Topic } from '@ethersphere/bee-js';

import type { SwarmClient, SwarmRequestOptions } from '../types/swarmClient';
import { getFeedData } from '../utils/bee';
import { awaitAllPromisesBounded, joinPath } from '../utils/common';
import { MAX_CONCURRENT_FEED_FETCHES } from '../utils/constants';
import { Logger } from '../utils/logger';
import { loadMantaray } from '../utils/mantaray';

const logger = Logger.getInstance();

/**
 * v1's bootstrap feed — a fixed, well-known topic per signer.
 *
 * v2 derives its state topic from `STATE_TOPIC_LABEL` instead, so the two can never collide: a
 * migration reads through this module and writes somewhere else entirely, leaving v1 intact and
 * the whole import re-runnable.
 */
export const LEGACY_STATE_TOPIC = Topic.fromString('filemanager-state');

const LEGACY_STATUS_TRASHED = 'trashed';

/*
 * The shapes v1 persisted. Copied rather than imported: v1 is frozen history, and depending on the
 * package would pull a second bee-js into the graph for types that will never change again.
 */

interface LegacyRefWithHistory {
  reference: string;
  historyRef: string;
}

interface LegacyStateTopicInfo {
  topicReference: string;
  historyAddress: string;
}

interface LegacyWrappedUploadResult {
  uploadFilesRes: string;
  uploadPreviewRes?: string;
}

interface LegacyDriveInfo {
  id: string;
  batchId: string;
  owner: string;
  name: string;
  redundancyLevel: number;
  isAdmin: boolean;
  infoFeedList?: { topic: string }[];
}

interface LegacyFileInfo {
  batchId: string;
  file: LegacyRefWithHistory;
  name: string;
  owner: string;
  actPublisher: string;
  topic: string;
  driveId: string;
  timestamp?: number;
  customMetadata?: Record<string, string>;
  status?: string;
}

/** One v2 file record to be created, pointing at content v1 already put on Swarm. */
export interface LegacyFileEntry {
  /** Destination path relative to the drive root. */
  path: string;
  /** Plaintext `/bytes` root of the file payload — transplanted, never re-uploaded. */
  contentRef: string;
  /** v1 wrote `size`, `mime` and `fileCount` here; v2's consumers read the same keys. */
  customMetadata?: Record<string, string>;
  timestamp?: number;
}

/** A file that could not be imported, with the reason, for the caller to surface. */
export interface LegacySkippedFile {
  name: string;
  topic?: string;
  reason: string;
}

export interface LegacyDrive {
  id: string;
  name: string;
  batchId: string;
  isAdmin: boolean;
  redundancyLevel: number;
  entries: LegacyFileEntry[];
  skipped: LegacySkippedFile[];
}

export interface LegacyState {
  drives: LegacyDrive[];
}

function decodeJson<T>(bytes: Uint8Array): T {
  return new Bytes(bytes).toJSON() as T;
}

/**
 * Normalises a v1 name into a drive-relative path. v1 had no folders, so a name is usually a bare
 * filename — but it is free-form caller input, so leading and trailing slashes are trimmed to keep
 * empty path segments out of v2's tree.
 */
function toRelativePath(name: string): string {
  return name.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

async function readStateTopic(
  swarmClient: SwarmClient,
  requestOptions?: SwarmRequestOptions,
): Promise<Topic | undefined> {
  const { payload, feedIndex } = await getFeedData(
    swarmClient,
    LEGACY_STATE_TOPIC,
    swarmClient.owner,
    undefined,
    requestOptions,
  );

  if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
    logger.debug('readLegacyState: no v1 state feed for this owner');

    return undefined;
  }

  const stateTopicInfo = payload.toJSON() as LegacyStateTopicInfo;
  if (!stateTopicInfo?.topicReference || !stateTopicInfo?.historyAddress) {
    throw new Error('v1 state pointer is malformed');
  }

  // The ACT payload behind the pointer is the raw topic bytes, not JSON.
  const topicBytes = await swarmClient.downloadProtected(
    {
      reference: stateTopicInfo.topicReference,
      historyRef: stateTopicInfo.historyAddress,
      publisher: swarmClient.actPublisher,
    },
    undefined,
    undefined,
    requestOptions,
  );

  return new Topic(topicBytes);
}

async function readDriveList(
  swarmClient: SwarmClient,
  stateTopic: Topic,
  requestOptions?: SwarmRequestOptions,
): Promise<LegacyDriveInfo[]> {
  const { payload, feedIndex } = await getFeedData(
    swarmClient,
    stateTopic,
    swarmClient.owner,
    undefined,
    requestOptions,
  );

  if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
    logger.warn('readLegacyState: v1 state pointer resolves to an empty drive-list feed');

    return [];
  }

  const refs = payload.toJSON() as LegacyRefWithHistory;
  const raw = await swarmClient.downloadProtected(
    { reference: refs.reference, historyRef: refs.historyRef, publisher: swarmClient.actPublisher },
    undefined,
    undefined,
    requestOptions,
  );

  return decodeJson<LegacyDriveInfo[]>(raw);
}

async function readFileInfo(
  swarmClient: SwarmClient,
  topic: string,
  requestOptions?: SwarmRequestOptions,
): Promise<LegacyFileInfo> {
  const { payload, feedIndex } = await getFeedData(
    swarmClient,
    new Topic(topic),
    swarmClient.owner,
    undefined,
    requestOptions,
  );

  if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
    throw new Error('file feed has no head');
  }

  const refs = payload.toJSON() as LegacyRefWithHistory;
  const raw = await swarmClient.downloadProtected(
    { reference: refs.reference, historyRef: refs.historyRef, publisher: swarmClient.actPublisher },
    undefined,
    undefined,
    requestOptions,
  );

  return decodeJson<LegacyFileInfo>(raw);
}

/**
 * Resolves a v1 file to the entries it becomes in v2.
 *
 * v1 wrapped every upload in a manifest, so the content reference lives one fork-walk down. The
 * name comes from `FileInfo.name` — the conflict-resolved name the user actually saw — not from the
 * fork path, which carries the pre-rename original and would collide.
 */
async function resolveEntries(
  swarmClient: SwarmClient,
  fileInfo: LegacyFileInfo,
  requestOptions?: SwarmRequestOptions,
): Promise<LegacyFileEntry[]> {
  const wrapped = decodeJson<LegacyWrappedUploadResult>(
    await swarmClient.downloadProtected(
      {
        reference: fileInfo.file.reference,
        historyRef: fileInfo.file.historyRef,
        publisher: fileInfo.actPublisher,
      },
      undefined,
      undefined,
      requestOptions,
    ),
  );

  if (!wrapped?.uploadFilesRes) {
    throw new Error('upload envelope carries no manifest reference');
  }

  // The manifest itself is plaintext: v1 uploaded content with `act: false` and protected only this
  // envelope. `collect()` skips null-target forks, so the `website-index-document` entry that
  // `streamFiles` adds for an index.html upload never shows up here.
  const manifest = await loadMantaray(swarmClient, wrapped.uploadFilesRes, undefined, requestOptions);
  const nodes = manifest.collect();

  if (nodes.length === 0) {
    throw new Error('manifest holds no files');
  }

  const basePath = toRelativePath(fileInfo.name);
  if (!basePath) {
    throw new Error('record has no usable name');
  }

  // One fork is the shipped dashboard's only shape — every v1 upload was a single File. More than
  // one means a library caller passed several, or a folder upload carried webkitRelativePaths; a
  // single name cannot name them all, so it becomes the folder that holds them.
  const isSingle = nodes.length === 1;

  return nodes.map((node) => ({
    path: isSingle ? basePath : joinPath(basePath, node.fullPathString),
    contentRef: new Reference(node.targetAddress).toHex(),
    customMetadata: fileInfo.customMetadata,
    timestamp: fileInfo.timestamp,
  }));
}

async function readDriveEntries(
  swarmClient: SwarmClient,
  drive: LegacyDriveInfo,
  requestOptions?: SwarmRequestOptions,
): Promise<Pick<LegacyDrive, 'entries' | 'skipped'>> {
  const feeds = drive.infoFeedList ?? [];
  const entries: LegacyFileEntry[] = [];
  const skipped: LegacySkippedFile[] = [];
  const takenPaths = new Set<string>();

  await awaitAllPromisesBounded(
    feeds.map((feed) => async (): Promise<{ info: LegacyFileInfo; entries: LegacyFileEntry[] } | null> => {
      const info = await readFileInfo(swarmClient, feed.topic, requestOptions);

      if (info.status === LEGACY_STATUS_TRASHED) {
        logger.debug(`readLegacyState: skipping trashed record "${info.name}"`);

        return null;
      }

      return { info, entries: await resolveEntries(swarmClient, info, requestOptions) };
    }),
    MAX_CONCURRENT_FEED_FETCHES,
    (resolved) => {
      if (!resolved) return;

      for (const entry of resolved.entries) {
        // v2 refuses duplicate destination paths for a whole batch, so a collision here would sink
        // the entire drive. Report it instead and let the caller decide what to do with it.
        if (takenPaths.has(entry.path)) {
          skipped.push({
            name: resolved.info.name,
            topic: resolved.info.topic,
            reason: `another record already claims the path "${entry.path}"`,
          });
          continue;
        }

        takenPaths.add(entry.path);
        entries.push(entry);
      }
    },
    (reason, ix) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      logger.error(`readLegacyState: failed to read v1 record ${feeds[ix].topic.slice(0, 6)}: ${message}`);
      skipped.push({ name: '(unreadable)', topic: feeds[ix].topic, reason: message });
    },
  );

  return { entries, skipped };
}

/**
 * Reads a v1 file manager's state into the shape a v2 import consumes.
 *
 * Read-only and non-destructive: nothing is written, and every v1 feed is left where it is.
 * Returns `undefined` when the owner has no v1 state at all.
 */
export async function readLegacyState(
  swarmClient: SwarmClient,
  requestOptions?: SwarmRequestOptions,
): Promise<LegacyState | undefined> {
  const stateTopic = await readStateTopic(swarmClient, requestOptions);

  if (!stateTopic) return undefined;

  const legacyDrives = await readDriveList(swarmClient, stateTopic, requestOptions);
  const drives: LegacyDrive[] = [];

  for (const drive of legacyDrives) {
    const { entries, skipped } = await readDriveEntries(swarmClient, drive, requestOptions);

    drives.push({
      id: drive.id,
      name: drive.name,
      batchId: drive.batchId,
      isAdmin: drive.isAdmin,
      redundancyLevel: drive.redundancyLevel,
      entries,
      skipped,
    });
  }

  logger.debug(`readLegacyState: resolved ${drives.length} v1 drive(s)`);

  return { drives };
}
