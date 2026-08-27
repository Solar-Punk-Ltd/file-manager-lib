import { type Bytes, type FeedIndex, type Reference } from '@ethersphere/core-sdk';

export interface ActReferences {
  reference: string;
  historyRef: string;
}

export interface FailedResult {
  path: string;
  error: string;
}

// --- SwarmClient port vocabulary ---
//
// Deliberately free of bee-js and swarm-id types: hex strings and plain bytes only, converted on
// each side of the port. This is what keeps the seam stable across backend SDK major versions.

export type Hex = string;

/**
 * A uint64 feed index as a **decimal** string, e.g. `'0'`, `'42'`.
 * Decimal is the canonical form across this port
 */
export type FeedIndexString = string;

/**
 * The index {@link SwarmClient.readFeed} reports when a feed has no update yet: uint64 max
 * (`0xffffffffffffffff`), the value bee spells `FeedIndex.MINUS_ONE`.
 *
 * An empty feed is an expected state, not a failure, so the port reports it **in band** — a
 * successful return carrying this index and a zero-address payload — rather than throwing. Every
 * backend must emit exactly this value, and every caller must test for it.
 *
 * Two consequences worth knowing:
 * - Retry-on-throw helpers do not fire, because nothing throws. Retry loops must test this
 *   constant, not catch.
 * - A missed check reads as a valid index whose payload is 32 zero bytes, which surfaces far away
 *   as `JSON.parse` failing on `""`.
 */
export const FEED_INDEX_NOT_FOUND: FeedIndexString = '18446744073709551615';

/**
 * The first writable slot of a feed, and therefore the `nextIndex` that accompanies
 * {@link FEED_INDEX_NOT_FOUND}: an empty feed's next write always lands at 0.
 */
export const FEED_INDEX_START: FeedIndexString = '0';

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

// --- Internal feed results ---
//
// These carry bee-js/core-sdk value types and are library internals, not port vocabulary.

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
