import type { Readable } from 'stream';

import type {
  ClientProtectedUploadResult,
  ClientUploadResult,
  FeedIndexString,
  FeedRead,
  FeedWrite,
  Hex,
  ProtectedRefs,
  StampInfo,
  SwarmDownloadOptions,
  SwarmRequestOptions,
  SwarmUploadOptions,
} from './utils';

/**
 * The Swarm I/O seam fm-lib depends on instead of a concrete `Bee` instance.
 *
 * Implementations:
 * - `BeeClient`  — direct bee-js + a local signer. Node and browser.
 * - `SnahaClient` — `@snaha/swarm-id`, browser only; keys never leave the trusted iframe.
 */
export interface SwarmClient {
  /**
   * Derives a secret from the master key
   * @param seed Input string necessary for deriving the secret
   * @returns a 32 byte hex string
   */
  deriveSecret(seed: string): Promise<string>;

  /**
   * Prepare the backend: version/compatibility checks for Bee, connection handshake for swarm-id.
   * {@link owner} and {@link publicKey} are only valid once this resolves.
   */
  initialize(requestOptions?: SwarmRequestOptions): Promise<void>;

  /**
   * Ethereum **address** (20 bytes / 40 hex chars) that owns the feeds this client writes.
   *
   * This is the value to pass wherever a feed owner is expected, and the value to persist as a
   * node's `owner`. Do not substitute {@link publicKey}: it is 33 bytes, so bee-js rejects it with
   * `Bytes#checkByteLength: bytes length is 33 but expected 20`.
   */
  readonly owner: Hex;

  /**
   * Compressed secp256k1 public key (66 hex chars) of {@link owner}.
   *
   * This is the *identity* key — the self grantee once sharing lands. It is **not** the ACT
   * publisher; see {@link actPublisher}.
   */
  readonly publicKey: Hex;

  /**
   * Compressed public key to quote as `actPublisher` when reading ACT-protected content, and to
   * persist as a node's `actPublisher`.
   *
   * Distinct from {@link publicKey} and not interchangeable with it. Under bee-js the Bee **node**
   * performs the ACT encryption, so this is the node's key from `getNodeAddresses()`. Under
   * swarm-id it is the origin-scoped `appKey`. Only valid after {@link initialize}.
   */
  readonly actPublisher: Hex;

  /** Read-only stamp lookup. Returns undefined when the batch is unknown. */
  getStamp(batchId?: Hex, requestOptions?: SwarmRequestOptions): Promise<StampInfo | undefined>;

  // --- plain bytes ---

  uploadData(
    batchId: Hex,
    data: Uint8Array | string,
    options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientUploadResult>;

  downloadData(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array>;

  downloadStream(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ReadableStream<Uint8Array>>;

  // --- ACT-protected bytes ---

  uploadProtected(
    batchId: Hex,
    data: Uint8Array | string | Blob | Readable,
    historyRef?: Hex,
    options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientProtectedUploadResult>;

  downloadProtected(
    refs: ProtectedRefs,
    at?: number,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array>;

  downloadProtectedStream(
    refs: ProtectedRefs,
    at?: number,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ReadableStream<Uint8Array>>;

  // --- chunks: the mantaray substrate ---

  uploadChunk(
    batchId: Hex,
    data: Uint8Array,
    options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientUploadResult>;

  downloadChunk(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array>;

  // --- feed operations ---

  readFeed(topic: Hex, owner: Hex, index?: FeedIndexString, requestOptions?: SwarmRequestOptions): Promise<FeedRead>;

  writeFeed(
    batchId: Hex,
    topic: Hex,
    payload: Uint8Array | string,
    index: FeedIndexString,
    options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<FeedWrite>;
}
