import { BatchId, Bytes, EthAddress, FeedIndex, PublicKey, RedundancyLevel, Reference, Topic } from '@upcoming/bee-js';

export interface FileInfo {
  batchId: string | BatchId;
  file: ReferenceWithHistory;
  topic?: string | Topic;
  owner?: string | EthAddress;
  name?: string;
  timestamp?: number;
  shared?: boolean;
  preview?: ReferenceWithHistory;
  index?: number | undefined;
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

// TODO: sotre index for a quicker upload
export interface WrappedFileInfoFeed extends ReferenceWithHistory {
  eGranteeRef?: string | Reference;
  // index?: FeedIndex;
}

export interface ReferenceWithPath {
  reference: Reference;
  path: string;
}

interface FeedUpdateHeaders {
  feedIndex: FeedIndex;
  feedIndexNext?: FeedIndex;
}
export interface FetchFeedUpdateResponse extends FeedUpdateHeaders {
  payload: Bytes;
}

export interface RequestOptions {
  historyRef?: Reference;
  publisher?: PublicKey;
  timestamp?: number;
  redundancyLevel?: RedundancyLevel;
}
