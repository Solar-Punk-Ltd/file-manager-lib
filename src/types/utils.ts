import { Bytes, FeedIndex, Reference, Topic } from '@ethersphere/bee-js';

import { FileRecord } from './info';

export interface StateTopicInfo {
  topicReference: string;
  historyAddress: string;
}

export interface BrowserUploadOptions {
  files: File[] | FileList;
  preview?: File;
  onUploadProgress?: (progress: UploadProgress) => void;
}

export enum NodeType {
  File = 'file',
  Folder = 'folder',
  Drive = 'drive',
}

export enum ListDepth {
  Shallow = 'shallow',
  Deep = 'deep',
}

export interface PartialFileInfo extends Omit<
  FileRecord,
  'owner' | 'actPublisher' | 'file' | 'topic' | 'driveId' | 'batchId' | 'redundancyLevel' | 'status'
> {
  file?: ReferenceWithHistory;
  topic?: string | Topic;
}

export type FileInfoOptions = PartialFileInfo & (BrowserUploadOptions | NodeUploadOptions);

export interface NodeUploadOptions {
  path: string;
  previewPath?: string;
}

export interface ReferenceWithHistory {
  reference: string | Reference;
  historyRef: string | Reference;
}

interface FeedUpdateHeaders {
  feedIndex: FeedIndex;
  feedIndexNext?: FeedIndex;
}
export interface FeedPayloadResult extends FeedUpdateHeaders {
  payload: Bytes;
}
export interface FeedReferenceResult extends FeedUpdateHeaders {
  reference: Reference;
}
export interface FeedResultWithIndex extends FeedPayloadResult {
  feedIndexNext: FeedIndex;
}
export interface UploadProgress {
  total: number;
  processed: number;
}

export interface WrappedUploadResult {
  uploadFilesRes: string | Reference;
  uploadPreviewRes?: string | Reference;
}
