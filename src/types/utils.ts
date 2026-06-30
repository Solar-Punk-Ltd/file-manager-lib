import { Bytes, FeedIndex, Reference, Topic } from '@ethersphere/bee-js';

import { FileRecord } from './info';

export interface StateTopicInfo {
  topicReference: string;
  historyAddress: string;
  index: string;
}

export interface BrowserUploadOptions {
  files: File[] | FileList;
  preview?: File;
  onUploadProgress?: (progress: UploadProgress) => void;
  /**
   * Per-file extra metadata to inject into each file's mantaray fork.
   * Key is the file path within the manifest (e.g. "/folder/file.txt").
   * Values are merged with the default Content-Type/Filename metadata.
   *
   * NOTE: Requires bee-js streamFiles to support a fileOptionsProvider callback.
   * This field is accepted here to allow callers to prepare metadata ahead of that change.
   */
  fileMetadata?: Map<string, Record<string, string>>;
}

export enum NodeType {
  File = 'file',
  Folder = 'folder',
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
