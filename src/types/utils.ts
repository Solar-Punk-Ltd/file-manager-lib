import { Bytes, FeedIndex, Reference } from '@ethersphere/bee-js';

import { FileRecord } from './info';

export interface StateTopicInfo {
  topicReference: string;
  historyAddress: string;
}

export interface BrowserUploadOptions {
  file: File;
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

// uploadFile() only accepts NEW-content fields (path + customMetadata, plus the platform
// Browser/Node file source via the intersection below). Re-version inputs (topic,
// fileRefAndHistory) moved to updateFile(record, ...), so they are intentionally omitted here.
export type PartialFileInfo = Omit<
  FileRecord,
  'owner' | 'actPublisher' | 'fileRefAndHistory' | 'topic' | 'driveId' | 'batchId' | 'redundancyLevel' | 'status'
>;

export type FileInfoOptions = PartialFileInfo & (BrowserUploadOptions | NodeUploadOptions);

export interface NodeUploadOptions {
  path: string;
}

export interface UploadFilesEntry {
  /** Path relative to destinationPath, e.g. "docs/report.pdf". For browser folder
   *  selections, derive from File.webkitRelativePath; for flat multi-select, File.name. */
  relativePath: string;
  /** Browser: the File object. Node: absolute filesystem path. */
  source: File | string;
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
