import { BatchId, EthAddress, FeedIndex, Identifier, PublicKey, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import { ReferenceWithHistory, WrappedFileInfoFeed } from './utils';

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
  preview?: ReferenceWithHistory;
  version?: string | undefined;
  index?: FeedIndex | undefined;
  redundancyLevel?: RedundancyLevel;
  customMetadata?: Record<string, string>;
  status?: FileStatus;
}

export interface DriveInfo {
  id: string | Identifier;
  batchId: string | BatchId;
  owner: string | EthAddress;
  name: string;
  redundancyLevel: RedundancyLevel;
  isAdmin: boolean;
  infoFeedList?: WrappedFileInfoFeed[];
}
