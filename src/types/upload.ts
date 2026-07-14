import { FileRecord } from './info';

export interface BrowserUploadOptions {
  file: File;
  onUploadProgress?: (tagUid: number) => void;
}

export interface NodeUploadOptions {
  path: string;
  onUploadProgress?: (tagUid: number) => void;
}

type PartialFileInfoUploadOptions = Omit<
  FileRecord,
  'owner' | 'actPublisher' | 'content' | 'topic' | 'driveId' | 'batchId' | 'redundancyLevel' | 'status'
>;

export type FileInfoOptions = PartialFileInfoUploadOptions & (BrowserUploadOptions | NodeUploadOptions);

export interface UploadFilesEntry {
  relativePath: string;
  /** Browser: the File object. Node: absolute filesystem path. */
  source: File | string;
}

export interface UploadFilesResult {
  succeeded: FileRecord[];
  failed: { path: string; error: string }[];
}
