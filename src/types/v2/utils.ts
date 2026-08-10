import { Bytes, FeedIndex, Reference } from '@ethersphere/bee-js';

export interface ActReferences {
  reference: string;
  historyRef: string;
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

export interface FailedResult {
  path: string;
  error: string;
}
