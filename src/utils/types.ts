import { BatchId, Bytes, EthAddress, FeedIndex, RedundancyLevel, Reference, Topic } from '@upcoming/bee-js';

// TODO: use ReferenceWithHistory within fileinfo: for the file and preview as well
export interface FileInfo {
  batchId: string | BatchId;
  eFileRef: string | Reference;
  topic?: string | Topic;
  historyRef?: string | Reference;
  owner?: string | EthAddress;
  fileName?: string;
  timestamp?: number;
  shared?: boolean;
  preview?: string | Reference;
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

export interface WrappedFileInfoFeed extends ReferenceWithHistory {
  eGranteeRef?: string | Reference;
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
