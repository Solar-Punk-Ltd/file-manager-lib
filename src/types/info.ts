import { BatchId, EthAddress, FeedIndex, Identifier, PublicKey, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import { ReferenceWithHistory } from './utils';

// TODO: set statuses for trashed, recovered, forgotten
export enum FileStatus {
  Active = 'active',
  Trashed = 'trashed',
}

export interface FileInfo {
  batchId: string | BatchId;
  file: ReferenceWithHistory;
  name: string;
  owner: string | EthAddress;
  actPublisher: string | PublicKey;
  topic: string | Topic;
  driveId: string;
  timestamp?: number;
  shared?: boolean;
  preview?: ReferenceWithHistory;
  version?: string | undefined;
  index?: FeedIndex | undefined;
  redundancyLevel?: RedundancyLevel;
  customMetadata?: Record<string, string>;
  status?: FileStatus;
}

/**
 * Represents per-file metadata stored in a mantaray fork within a folder upload.
 * Enables granular versioning, ACT encryption, and sharing per individual file.
 */
export interface FolderFileEntry {
  /** Absolute path of the file within the folder manifest, e.g. /folder/sub/file.txt */
  path: string;
  /** Stable chunk reference for the file content — does not change on move/rename */
  contentRef: string;
  /** Increments only when file bytes change */
  contentVersion: string;
  /** Increments on any metadata change: move, rename, reshare, re-encrypt */
  recordVersion: string;
  /** Feed topic for this individual file's version history */
  fileTopic?: string;
  /** Feed topic of the root folder manifest — stable across versions, used to resolve the current root ref */
  rootFeedTopic?: string;
  /** Encrypted grantee list reference for ACT sharing */
  granteeListRef?: string;
  /** ACT history address for decrypting this file */
  actHistoryAddress?: string;
  /** Full raw metadata from the mantaray fork, including Content-Type, Filename, etc. */
  rawMetadata?: Record<string, string>;
}

export interface ShareItem {
  fileInfo: FileInfo;
  timestamp?: number;
  message?: string;
}

export interface DriveInfo {
  id: string | Identifier;
  batchId: string | BatchId;
  owner: string | EthAddress;
  name: string;
  redundancyLevel: RedundancyLevel;
  isAdmin: boolean;
  driveFeedTopic: string;
  manifestRef?: ReferenceWithHistory;
}
