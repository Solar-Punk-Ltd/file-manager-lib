import { BatchId, EthAddress, FeedIndex, Identifier, PublicKey, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import { ReferenceWithHistory } from './utils';

export enum FileStatus {
  Active = 'active',
  Trashed = 'trashed',
}

export interface FileRecord {
  topic: string | Topic;
  driveId: string;
  /**
   * Persisted value (what gets written to the file's feed) is the relative filename only.
   * The in-memory copy held in FileManager.fileInfoList is stamped with the current absolute
   * path by whichever walker or write path last resolved it — always trust the in-memory value,
   * not a value freshly deserialized from the feed without re-stamping.
   */
  path: string;
  fileRefAndHistory: ReferenceWithHistory;
  batchId: string | BatchId;
  owner: string | EthAddress;
  actPublisher: string | PublicKey;
  redundancyLevel?: RedundancyLevel;
  version?: string | FeedIndex;
  timestamp?: number;
  shared?: boolean;
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
  result: ReadableStream<Uint8Array>;
}

export interface UploadFilesResult {
  succeeded: FileRecord[];
  failed: { path: string; error: string }[];
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
