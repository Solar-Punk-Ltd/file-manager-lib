import type { Readable } from 'stream';

import type { StampInfo } from './info';
import type { ClientProtectedUploadResult, ClientUploadResult } from './upload';
import type {
  FeedIndexString,
  FeedRead,
  FeedWrite,
  Hex,
  ProtectedRefs,
  SwarmDownloadOptions,
  SwarmFeedWriteOptions,
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
   * Ethereum **address** (20 bytes / 40 hex chars) of the backend's own key — whichever credential
   * the user logged in with.
   *
   * fm-lib uses it only to locate the identity envelope. Every other feed is owned by
   * `identity.owner` and signed by `identity.signer`, so this is not the value to persist as a
   * node's owner, and reading a node feed here finds nothing.
   *
   * Do not substitute `publicKey`: it is 33 bytes, and bee-js rejects it where 20 are expected.
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
   * Compressed public key to quote as `actPublisher` when reading ACT-protected content.
   *
   * Distinct from {@link publicKey} and not interchangeable with it. Under bee-js the Bee **node**
   * performs the ACT encryption, so this is the node's key from `getNodeAddresses()`. Under
   * swarm-id it is the origin-scoped `appKey`. Only valid after {@link initialize}.
   */
  readonly actPublisher: Hex;

  /**
   * Derive 32 stable, secret bytes from the backend's own key material. Used for the identity
   * envelope's unlock key, so this value alone locates the envelope, unseals the FMK, and yields
   * read and write access to every drive.
   *
   */
  deriveSecret(label: string): Promise<Uint8Array>;

  /**
   * Prepare the backend: version/compatibility checks for Bee, connection handshake for swarm-id.
   * {@link owner} and {@link publicKey} are only valid once this resolves.
   */
  initialize(requestOptions?: SwarmRequestOptions): Promise<void>;

  /** Read-only stamp lookup. Returns undefined when the batch is unknown. */
  getStamp(batchId?: Hex, requestOptions?: SwarmRequestOptions): Promise<StampInfo | undefined>;

  // --- plain bytes ---

  /** With `options.encrypt` the returned reference is 64 bytes and carries the decryption key. */
  uploadData(
    batchId: Hex,
    data: Uint8Array | string | Blob | Readable,
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

  /**
   * Reads one feed slot — the latest when `index` is omitted.
   *
   * **A feed with no update yet resolves rather than rejecting**, carrying `FEED_INDEX_NOT_FOUND`
   * as `index`, `FEED_INDEX_START` as `nextIndex`, and a zero-address payload. Implementations must
   * map their backend's not-found signal onto exactly that; callers must test for it. Both
   * constants are exported alongside these types — see `FEED_INDEX_NOT_FOUND` for why absence is
   * reported in band rather than thrown.
   */
  readFeed(topic: Hex, owner: Hex, index?: FeedIndexString, requestOptions?: SwarmRequestOptions): Promise<FeedRead>;

  /**
   * Writes one feed slot.
   *
   * Signed by `options.signer` when given, otherwise by the backend's own key — in which case the
   * update lands under {@link owner}. Bee **silently no-ops on a taken index**, so `index` must come
   * from a probe, never from a guess.
   */
  writeFeed(
    batchId: Hex,
    topic: Hex,
    payload: Uint8Array | string,
    index: FeedIndexString,
    options?: SwarmFeedWriteOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<FeedWrite>;
}
