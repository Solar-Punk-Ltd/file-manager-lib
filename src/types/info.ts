import {
  BatchId,
  Bytes,
  EthAddress,
  FeedIndex,
  Identifier,
  PublicKey,
  RedundancyLevel,
  Topic,
} from '@ethersphere/bee-js';

import { ReferenceWithHistory } from './utils';

export enum FileStatus {
  Active = 'active',
  Trashed = 'trashed',
}

export interface FileRecord {
  topic: string | Topic;
  driveId: string;
  path: string;
  file: ReferenceWithHistory;
  batchId: string | BatchId;
  owner: string | EthAddress;
  actPublisher: string | PublicKey;
  redundancyLevel?: RedundancyLevel;
  version?: string | FeedIndex;
  timestamp?: number;
  shared?: boolean;
  preview?: ReferenceWithHistory;
  status?: FileStatus;
  customMetadata?: Record<string, string>;
  granteeListRef?: string;
}

export interface ManifestHost {
  topic: string;
  manifestRef?: ReferenceWithHistory;
  batchId: string | BatchId;
  redundancyLevel: RedundancyLevel;
}

export interface FolderInfo extends ManifestHost {
  path: string;
  driveId: string;
}

export interface ShareItem {
  fileInfo: FileRecord;
  timestamp?: number;
  message?: string;
}

export interface DownloadResource {
  path: string;
  reference: string;
  actHistoryAddress: string;
  actPublisher: string | PublicKey;
}

export interface DownloadResult {
  path: string;
  result: Bytes | ReadableStream<Uint8Array>;
}

export interface DriveInfo {
  id: string | Identifier;
  batchId: string | BatchId;
  owner: string | EthAddress;
  name: string;
  redundancyLevel: RedundancyLevel;
  isAdmin: boolean;
  driveFeedTopic: string | Topic;
  manifestRef?: ReferenceWithHistory;
}
