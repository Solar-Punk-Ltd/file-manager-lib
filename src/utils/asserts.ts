import { BatchId, EthAddress, Identifier, PublicKey, RedundancyLevel, Reference, Topic } from '@ethersphere/bee-js';
import { Types } from 'cafe-utility';

import { DriveInfo, FileRecord, ShareItem, StateTopicInfo } from '../types/info';

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

export function assertFileRecord(value: unknown): asserts value is FileRecord {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('FileRecord has to be object!');
  }

  const fi = value as unknown as FileRecord;

  new Reference(fi.content.reference);
  new Reference(fi.batchId);
  new Reference(fi.content.historyRef);
  new EthAddress(fi.owner);
  new Topic(fi.topic);
  new PublicKey(fi.actPublisher);

  if (typeof fi.path !== 'string' || fi.path.length === 0) {
    throw new TypeError('path property of FileRecord has to be a non-empty string!');
  }

  if (fi.customMetadata !== undefined && !isRecord(fi.customMetadata)) {
    throw new TypeError('FileRecord customMetadata has to be object!');
  }

  if (fi.timestamp !== undefined && typeof fi.timestamp !== 'number') {
    throw new TypeError('timestamp property of FileRecord has to be number!');
  }

  if (fi.shared !== undefined && typeof fi.shared !== 'boolean') {
    throw new TypeError('shared property of FileRecord has to be boolean!');
  }

  if (fi.redundancyLevel !== undefined && typeof fi.redundancyLevel !== 'number') {
    throw new TypeError('redundancyLevel property of FileRecord has to be number!');
  }

  if (fi.status !== undefined && typeof fi.status !== 'string') {
    throw new TypeError('status property of FileRecord has to be string!');
  }
}

export function assertShareItem(value: unknown): asserts value is ShareItem {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('ShareItem has to be object!');
  }

  const item = value as unknown as ShareItem;

  assertFileRecord(item.fileInfo);

  if (item.timestamp !== undefined && typeof item.timestamp !== 'number') {
    throw new TypeError('timestamp property of ShareItem has to be number!');
  }

  if (item.message !== undefined && typeof item.message !== 'string') {
    throw new TypeError('message property of ShareItem has to be string!');
  }
}

export function assertDriveInfo(value: unknown): asserts value is DriveInfo {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('DriveInfo has to be object!');
  }

  const di = value as unknown as DriveInfo;

  new BatchId(di.batchId);
  new EthAddress(di.owner);
  new Identifier(di.id);

  if (di.topic === undefined || typeof di.topic !== 'string' || di.topic.length === 0) {
    throw new TypeError('topic property of DriveInfo has to be non-empty string!');
  }

  if (di.name === undefined || typeof di.name !== 'string' || di.name.length === 0) {
    throw new TypeError('name property of DriveInfo has to be string!');
  }

  if (di.redundancyLevel === undefined || typeof di.redundancyLevel !== 'number') {
    throw new TypeError('redundancyLevel property of DriveInfo has to be number!');
  }

  if (di.isAdmin === undefined || typeof di.isAdmin !== 'boolean') {
    throw new TypeError('isAdmin property of DriveInfo has to be boolean!');
  }
}

export function driveInfoFromMetadata(meta: Record<string, string>): DriveInfo {
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

export function assertStateTopicInfo(value: unknown): asserts value is StateTopicInfo {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('StateTopicInfo has to be object!');
  }

  const sti = value as unknown as StateTopicInfo;

  new Reference(sti.topicReference);
  new Reference(sti.historyAddress);
}

interface FMReadyState {
  publisher: string;
  isInitialized: boolean;
  stateFeedTopic: string;
}

export function assertReady(
  publisher: PublicKey | undefined,
  isInitialized: boolean | undefined,
  stateFeedTopic: Topic | undefined,
): FMReadyState {
  if (!isInitialized) {
    throw new DriveError('FileManager is not initialized');
  }
  if (!stateFeedTopic) {
    throw new DriveError('FileManager state feed topic not found.');
  }
  if (!publisher) {
    throw new SignerError('Publisher not found');
  }

  return {
    publisher: publisher.toCompressedHex(),
    isInitialized,
    stateFeedTopic: stateFeedTopic.toString(),
  };
}
