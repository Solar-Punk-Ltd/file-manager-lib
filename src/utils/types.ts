import {
  BatchId,
  Bytes,
  DownloadOptions,
  EthAddress,
  FeedIndex,
  PublicKey,
  RedundancyLevel,
  Reference,
  Topic,
} from '@upcoming/bee-js';
import { ReadStream } from 'fs';

// TODO: discuss interface functions
export interface IFileManager {
  upload(options: FileManagerUploadOptions): Promise<void>;
  listFiles(fileInfo: FileInfo, options?: DownloadOptions): Promise<ReferenceWithPath[]>;
  download(eRef: Reference, options?: DownloadOptions): Promise<string[]>;
  shareItem(fileInfo: FileInfo, targetOverlays: string[], recipients: string[], message?: string): Promise<void>;
}

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

export interface FileManagerUploadOptions {
  batchId: BatchId;
  name: string;
  files?: File[] | FileList;
  path?: string;
  customMetadata?: Record<string, string>;
  historyRef?: Reference;
  infoTopic?: string;
  index?: number | undefined;
  preview?: File;
  previewPath?: string;
  redundancyLevel?: RedundancyLevel;
  onUploadProgress?: (T: any) => void;
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

export interface WrappedFileInfoFeed {
  topic: string | Topic;
  eGranteeRef?: string | Reference;
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
