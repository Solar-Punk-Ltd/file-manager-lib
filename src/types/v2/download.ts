import { PublicKey } from '@ethersphere/bee-js';

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
