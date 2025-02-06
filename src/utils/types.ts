import { BatchId, Bytes, EthAddress, FeedIndex, RedundancyLevel, Reference, Topic } from '@upcoming/bee-js';

export interface FileInfo {
  batchId: string | BatchId;
  eFileRef: string | Reference;
  topic?: string | Topic;
  historyRef?: string | Reference;
  owner?: string | EthAddress;
  fileName?: string;
  timestamp?: number;
  shared?: boolean;
  preview?: string;
  redundancyLevel?: RedundancyLevel;
  customMetadata?: Record<string, string>;
}

export interface ShareItem {
  fileInfo: FileInfo;
  timestamp?: number;
  message?: string;
}

export interface ReferenceWithHistory {
  reference: string | Reference;
  historyRef: string | Reference;
}

export interface WrappedMantarayFeed extends ReferenceWithHistory {
  eFileRef?: string | Reference;
  eGranteeRef?: string | Reference;
}

interface FeedUpdateHeaders {
  feedIndex: FeedIndex;
  feedIndexNext?: FeedIndex;
}
export interface FetchFeedUpdateResponse extends FeedUpdateHeaders {
  payload: Bytes;
}
