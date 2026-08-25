import {
  BatchId,
  EthAddress,
  FeedIndex,
  Identifier,
  PublicKey,
  type RedundancyLevel,
  Reference,
  Topic,
} from '@ethersphere/bee-js';
import { Types } from 'cafe-utility';

import { type SwarmClient } from '../types/client/swarmClient';
import {
  type DriveInfo,
  type FileRecord,
  type FolderInfo,
  type NodeResource,
  NodeStatus,
  NodeType,
} from '../types/info';
import { type ActReferences } from '../types/utils';

import {
  MANIFEST_METADATA_DRIVE_ACT_PUBLISHER,
  MANIFEST_METADATA_DRIVE_BATCH_ID,
  MANIFEST_METADATA_DRIVE_ID,
  MANIFEST_METADATA_DRIVE_IS_ADMIN,
  MANIFEST_METADATA_DRIVE_NAME,
  MANIFEST_METADATA_DRIVE_OWNER,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
} from './constants';
import { DriveError, SignerError } from './errors';

export function isRecord(value: unknown): value is Record<string, string> {
  return Types.isStrictlyObject(value) && Object.values(value).every((v) => typeof v === 'string');
}

export function assertActReferences(value: unknown): asserts value is ActReferences {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('ActReferences has to be object!');
  }

  const ar = value as unknown as ActReferences;

  new Reference(ar.reference);
  new Reference(ar.historyRef);
}

export function assertNodeResource(value: unknown): asserts value is NodeResource {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('NodeResource has to be object!');
  }

  const nr = value as unknown as NodeResource;

  new BatchId(nr.batchId);
  new Topic(nr.topic);
  new EthAddress(nr.owner);
  new PublicKey(nr.actPublisher);

  if (typeof nr.redundancyLevel !== 'number') {
    throw new TypeError('redundancyLevel property of NodeResource has to be number!');
  }
}

export function assertFileRecord(value: unknown): asserts value is FileRecord {
  assertNodeResource(value);

  const fr = value as unknown as FileRecord;

  if (fr.type !== NodeType.File) {
    throw new TypeError('type property of FileRecord has to be NodeType.File!');
  }

  assertActReferences(fr.content);

  if (fr.driveId !== undefined) {
    new Identifier(fr.driveId);
  }

  if (typeof fr.name !== 'string' || fr.name.length === 0) {
    throw new TypeError('name property of FileRecord has to be a non-empty string!');
  }

  if (fr.version !== undefined) {
    if (typeof fr.version !== 'string') {
      throw new TypeError('version property of FileRecord has to be string!');
    }
    new FeedIndex(fr.version);
  }

  if (fr.customMetadata !== undefined && !isRecord(fr.customMetadata)) {
    throw new TypeError('FileRecord customMetadata has to be object!');
  }

  if (fr.timestamp !== undefined && typeof fr.timestamp !== 'number') {
    throw new TypeError('timestamp property of FileRecord has to be number!');
  }

  if (fr.status !== undefined && !Object.values(NodeStatus).includes(fr.status)) {
    throw new TypeError('status property of FileRecord has to be a valid NodeStatus!');
  }
}

export function assertDriveInfo(value: unknown): asserts value is DriveInfo {
  assertNodeResource(value);

  const di = value as unknown as DriveInfo;

  if (di.type !== NodeType.Drive) {
    throw new TypeError('type property of DriveInfo has to be NodeType.Drive!');
  }

  new Identifier(di.id);

  if (typeof di.name !== 'string' || di.name.length === 0) {
    throw new TypeError('name property of DriveInfo has to be non-empty string!');
  }

  if (typeof di.isAdmin !== 'boolean') {
    throw new TypeError('isAdmin property of DriveInfo has to be boolean!');
  }

  if (di.manifestRef !== undefined) {
    assertActReferences(di.manifestRef);
  }
}

export function assertFolderInfo(value: unknown): asserts value is FolderInfo {
  assertNodeResource(value);

  const fi = value as unknown as FolderInfo;

  if (fi.type !== NodeType.Folder) {
    throw new TypeError('type property of FolderInfo has to be NodeType.Folder!');
  }

  new Identifier(fi.driveId);

  if (typeof fi.path !== 'string' || fi.path.length === 0) {
    throw new TypeError('path property of FolderInfo has to be a non-empty string!');
  }

  if (fi.manifestRef !== undefined) {
    assertActReferences(fi.manifestRef);
  }
}

export function assertDriveInfoFromMetadata(meta: Record<string, string>): DriveInfo {
  const id = meta[MANIFEST_METADATA_DRIVE_ID];
  const name = meta[MANIFEST_METADATA_DRIVE_NAME];
  const owner = meta[MANIFEST_METADATA_DRIVE_OWNER];
  const batchId = meta[MANIFEST_METADATA_DRIVE_BATCH_ID];
  const isAdmin = meta[MANIFEST_METADATA_DRIVE_IS_ADMIN] === 'true';
  const actPublisher = meta[MANIFEST_METADATA_DRIVE_ACT_PUBLISHER];
  const redundancyLevel = parseInt(meta[MANIFEST_METADATA_REDUNDANCY_LEVEL] ?? '0') as RedundancyLevel;
  const topic = meta[MANIFEST_METADATA_NODE_TOPIC];

  if (!id || !name || !owner || !batchId || !topic || !actPublisher) {
    throw new DriveError(`Invalid drive fork metadata — missing required fields`);
  }

  const driveInfo: DriveInfo = {
    type: NodeType.Drive,
    id,
    name,
    owner,
    batchId,
    isAdmin,
    redundancyLevel,
    topic,
    actPublisher,
  };
  assertDriveInfo(driveInfo);

  return driveInfo;
}

interface FMReadyState {
  publisher: string;
  isInitialized: boolean;
  stateFeedTopic: string;
}

export function assertReady(
  swarmClient: SwarmClient,
  isInitialized: boolean | undefined,
  stateFeedTopic: Topic | undefined,
): FMReadyState {
  if (!isInitialized) {
    throw new DriveError('FileManager is not initialized');
  }
  if (!stateFeedTopic) {
    throw new DriveError('FileManager state feed topic not found.');
  }

  const publisher = swarmClient.actPublisher;
  if (!publisher) {
    throw new SignerError('Publisher not found');
  }

  return {
    publisher,
    isInitialized,
    stateFeedTopic: stateFeedTopic.toString(),
  };
}
