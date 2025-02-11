import { BatchId, Bytes, EthAddress, FeedIndex, RedundancyLevel, Reference, Topic } from '@upcoming/bee-js';

export interface FileInfo {
  batchId: string | BatchId;
  file: ReferenceWithHistory;
  topic?: string | Topic;
  owner?: string | EthAddress;
  name?: string;
  timestamp?: number;
  shared?: boolean;
  preview?: ReferenceWithHistory;
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

export interface FileData {
  data: string | Uint8Array;
  name: string;
  contentType: string;
}

interface FeedUpdateHeaders {
  feedIndex: FeedIndex;
  feedIndexNext?: FeedIndex;
}
export interface FetchFeedUpdateResponse extends FeedUpdateHeaders {
  payload: Bytes;
}
