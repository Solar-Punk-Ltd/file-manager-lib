import { BatchId, Bytes, EthAddress, FeedIndex, RedundancyLevel, Reference, Topic } from '@upcoming/bee-js';

export interface FileInfo {
  batchId: BatchId;
  eFileRef: Reference;
  topic?: Topic;
  historyRef?: Reference;
  owner?: EthAddress;
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
  reference: Reference;
  historyRef: Reference;
}

export interface WrappedMantarayFeed extends ReferenceWithHistory {
  eFileRef?: Reference;
  eGranteeRef?: Reference;
}

interface FeedUpdateHeaders {
  feedIndex: FeedIndex;
  feedIndexNext?: FeedIndex;
}
export interface FetchFeedUpdateResponse extends FeedUpdateHeaders {
  payload: Bytes;
}
