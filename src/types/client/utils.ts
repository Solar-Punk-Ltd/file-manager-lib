import { type ActReferences } from '../utils';

export type Hex = string;

/**
 * A uint64 feed index as a **decimal** string, e.g. `'0'`, `'42'`.
 * Decimal is the canonical form across this port
 */
export type FeedIndexString = string;

export type SwarmRedundancyLevel = number;

export interface SwarmRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  headers?: Record<string, string>;
}
export interface SwarmUploadOptions {
  redundancyLevel?: SwarmRedundancyLevel;
}
export type SwarmRedundancyStrategy = number;
export interface SwarmDownloadOptions {
  redundancyStrategy?: SwarmRedundancyStrategy;
  fallback?: boolean;
}
export interface ProtectedRefs extends ActReferences {
  publisher: Hex;
}
export interface FeedRead {
  payload: Uint8Array;
  index: FeedIndexString;
  nextIndex: FeedIndexString;
}
export interface FeedWrite {
  reference: Hex;
  index: FeedIndexString;
}
export interface StampInfo {
  batchId: Hex;
  usable: boolean;
  depth: number;
}
export interface ClientUploadResult {
  reference: Hex;
  tagUid?: number;
}
export interface ClientProtectedUploadResult {
  contentRefs: ActReferences;
  tagUid?: number;
}
