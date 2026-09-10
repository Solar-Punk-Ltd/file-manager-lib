import { type FailedResult } from './utils';

export interface DownloadResource {
  path: string;
  /** 64-byte reference: the content key rides in the reference, so no separate key is needed. */
  reference: string;
}

export interface DownloadResult {
  path: string;
  result: ReadableStream<Uint8Array>;
}

export interface DownloadFilesResult {
  succeeded: DownloadResult[];
  failed: FailedResult[];
}
