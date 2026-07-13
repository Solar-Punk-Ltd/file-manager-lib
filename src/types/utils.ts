import { Bytes, FeedIndex, Reference } from '@ethersphere/bee-js';

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
