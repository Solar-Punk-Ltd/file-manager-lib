import { type FileRecord } from './info';
import { type FailedResult } from './utils';

export interface BrowserUploadOptions {
  file: File;
  onUploadProgress?: (tagUid: number) => void;
}

export interface NodeUploadOptions {
  /** Filesystem path to read the bytes from — the upload source. Distinct from `path`, which is
   *  the manifest placement (where the file lands in the drive tree). */
  sourcePath: string;
  onUploadProgress?: (tagUid: number) => void;
}

// The bytes source, discriminated by environment: `file` (browser) or `sourcePath` (node).
export type UploadSource = BrowserUploadOptions | NodeUploadOptions;

type UploadMetadata = Omit<
  FileRecord,
  'type' | 'owner' | 'actPublisher' | 'content' | 'topic' | 'driveId' | 'batchId' | 'redundancyLevel' | 'status'
>;

export type UploadItem = UploadMetadata & UploadSource;

export interface UpdateItem {
  item?: Omit<UploadMetadata, 'path'> & UploadSource;
  customMetadata?: Record<string, string>;
}

export interface UploadFilesResult {
  succeeded: FileRecord[];
  failed: FailedResult[];
}
