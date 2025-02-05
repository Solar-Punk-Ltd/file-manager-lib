import { BatchId, RedundancyLevel, Reference, ReferenceResponse, Topic } from '@ethersphere/bee-js';

export interface FileInfo {
  batchId: string | BatchId;
  eFileRef: string | Reference;
  topic?: string | Topic;
  historyRef?: string | Reference;
  owner?: string;
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

export interface Bytes<Length extends number> extends Uint8Array {
  readonly length: Length;
}
export type IndexBytes = Bytes<8>;
export interface Epoch {
  time: number;
  level: number;
}
export interface FeedUpdateHeaders {
  feedIndex: Index;
  feedIndexNext: string;
}
export interface FetchFeedUpdateResponse extends ReferenceResponse, FeedUpdateHeaders {}
export type Index = number | Epoch | IndexBytes | string;
const feedTypes = ['sequence', 'epoch'] as const;
export type FeedType = (typeof feedTypes)[number];
