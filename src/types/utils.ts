import type { RedundancyLevel } from '@ethersphere/bee-js';
import { type Bytes, type FeedIndex, type Reference } from '@ethersphere/core-sdk';

/**
 * ACT reference pair. No longer part of the tree's vocabulary — kept for the share layer, which is
 * the only thing that still uploads through ACT.
 */
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

/**
 * What a node's feed payload resolves to, once opened: one Swarm reference and nothing else — a
 * mantaray root for a folder or drive, a record blob for a file. Never the sealed form; that lives
 * only in the feed slot.
 *
 * 64 hex chars for plain data, 128 for natively encrypted data — the longer form carries the
 * decryption key alongside the address, so the reference *is* the capability, and sealing it is
 * what gates the bytes behind it.
 */
export interface ContentRef {
  reference: Hex;
}

/** A node's two symmetric keys. `meta` unlocks its listing, `content` unlocks its content pointer. */
export interface NodeKeys {
  meta: Uint8Array;
  content: Uint8Array;
}

/**
 * A child's {@link NodeKeys} sealed under its parent's, as stored in the parent's fork metadata.
 * Each value is `iv || ciphertext`, hex-encoded.
 */
export interface WrappedKeys {
  meta: Hex;
  content: Hex;
}

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
