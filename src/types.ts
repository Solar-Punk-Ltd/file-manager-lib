import { BatchId, EthAddress, MantarayNode, RedundancyLevel, Reference, Topic } from '@upcoming/bee-js';

export interface FileInfo {
  batchId: string | BatchId;  // string possibly shouldn't be allowed
  eFileRef: string | Reference; // string possibly shouldn't be allowed
  topic?: string | Topic;  // string possibly shouldn't be allowed
  historyRef?: string | Reference;  // string possibly shouldn't be allowed
  owner?: EthAddress;
  fileName?: string;
  timestamp?: number;
  shared?: boolean;
  preview?: string;  // possibly should be Reference
  redundancyLevel?: RedundancyLevel;
  customMetadata?: Record<string, string>;
}
export interface ShareItem {
  fileInfoList: FileInfo[];
  timestamp?: number;
  message?: string;
}

export interface Bytes<Length extends number> extends Uint8Array {
  readonly length: Length;
}
export type IndexBytes = Bytes<8>;
export interface Epoch {
  time: number;
  level: number;
}
export type Index = number | Epoch | IndexBytes | string;
const feedTypes = ['sequence', 'epoch'] as const;
export type FeedType = (typeof feedTypes)[number];

export interface MantarayStackItem {
  node: MantarayNode;
  path: string;
}
