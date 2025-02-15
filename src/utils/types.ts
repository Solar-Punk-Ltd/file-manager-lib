import { BatchId, Bytes, EthAddress, FeedIndex, PublicKey, RedundancyLevel, Reference, Topic } from '@upcoming/bee-js';
import { ReadStream } from 'fs';

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

// TODO: make historyRef optional
export interface ReferenceWithHistory {
  reference: string | Reference;
  historyRef: string | Reference;
}

// TODO: sotre index for a quicker upload
export interface WrappedFileInfoFeed {
  topic: string | Topic;
  eGranteeRef?: string | Reference;
  // index?: FeedIndex;
}

export interface ReferenceWithPath {
  reference: Reference;
  path: string;
}

export interface FileData {
  data: string | Uint8Array | ReadStream;
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

export interface RequestOptions {
  historyRef?: Reference;
  publisher?: PublicKey;
  timestamp?: number;
  redundancyLevel?: RedundancyLevel;
}

export interface UploadProgress {
  total: number;
  processed: number;
}
