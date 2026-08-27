import type { PublicKey } from '@ethersphere/core-sdk';

import { type FailedResult } from './utils';

export interface DownloadResource {
  path: string;
  reference: string;
  actHistoryAddress: string;
  actPublisher: string | PublicKey;
}

export interface DownloadResult {
  path: string;
  result: ReadableStream<Uint8Array>;
}

export interface DownloadFilesResult {
  succeeded: DownloadResult[];
  failed: FailedResult[];
}
