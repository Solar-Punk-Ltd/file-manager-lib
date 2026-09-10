import type { RedundancyLevel } from '@ethersphere/bee-js';
import { type Bytes, type FeedIndex, type Reference } from '@ethersphere/core-sdk';

export interface ActReferences {
  reference: string;
  historyRef: string;
}

export interface FailedResult {
  path: string;
  error: string;
}

export interface ContentRef {
  reference: Hex;
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

export type SwarmRedundancyLevel = number;

export interface SwarmRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  headers?: Record<string, string>;
}
export interface SwarmUploadOptions {
  redundancyLevel?: SwarmRedundancyLevel;
  /** Swarm native encryption: a random per-object key, returned embedded in a 64-byte reference. */
  encrypt?: boolean;
}
export interface SwarmFeedWriteOptions extends SwarmUploadOptions {
  /**
   * Private key (64 hex chars) to sign the feed update with, overriding the backend's own key.
   *
   * The one place key material crosses the port, and deliberately so: it is never the *backend's*
   * credential, only the FileManager's own FMK-derived signer. Omit it and the update is signed by
   * the backend key — which is what the identity envelope needs, since it must land under the
   * credential's address to be findable before the FMK exists.
   */
  signer?: Hex;
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

export interface FeedTarget {
  batchId: string;
  topic: string;
  redundancyLevel?: RedundancyLevel;
  index?: bigint;
}

export interface FeedWriteResult {
  contentRef: ContentRef;
  index: bigint;
  nextIndex: bigint;
}
