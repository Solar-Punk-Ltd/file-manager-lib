import type { Readable } from 'stream';

import type { StampInfo } from './info';
import type { ClientProtectedUploadResult, ClientUploadResult } from './upload';
import type {
  FeedIndexString,
  FeedRead,
  FeedWrite,
  GranteeListUpdate,
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
   * The *identity* key: who this login is. It is **not** what ACT decrypts with, and it is not what to publish as a grantee key.
   * {@link granteeKey} is the key an identity hands out to be shared with.
   */
  readonly publicKey: Hex;

  /**
   * Compressed public key of whatever performs ACT for this backend — quoted as `actPublisher` when
   * reading protected content this client uploaded.
   *
   * Distinct from {@link publicKey} and not interchangeable with it. Under bee-js the Bee **node**
   * performs the ACT encryption, so this is the node's key from `getNodeAddresses()` — which means
   * it identifies a node and not a person, and everyone sharing that node shares its grants. Under
   * swarm-id it is the origin-scoped `appKey`. Only valid after {@link initialize}.
   */
  readonly actPublisher: Hex;

  /**
   * Compressed public key to hand out to be granted access — the key this backend's ACT engine
   * decrypts grants with.
   *
   * Under bee-js it is the Bee node's key, the same as {@link actPublisher}. Under swarm-id it is the
   * account-wide sharing key, so a grant made out to it opens on every origin the user logs in from.
   * Only valid after {@link initialize}.
   */
  readonly granteeKey: Hex;

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

  /**
   * Upload bytes gated by an ACT grantee list.
   *
   * `grantees` are compressed public keys, each the key its holder's own ACT engine decrypts with —
   * a Bee node's key for a `BeeClient` recipient, the account-wide sharing key for a swarm-id one; in
   * both cases the recipient's {@link granteeKey}, never their {@link publicKey}. The publisher is
   * always granted and needs no entry. Passing `historyRef` continues an existing ACT history
   * instead of minting one.
   */
  uploadProtected(
    batchId: Hex,
    data: Uint8Array | string | Blob | Readable,
    grantees?: Hex[],
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

  // --- grantee lists ---

  /**
   * Add public keys to the grantee list at `granteeListRef`, on the ACT history `historyRef`.
   *
   * The protected object's encrypted reference is unchanged, so only the returned history and list
   * reference need republishing.
   */
  addGrantees(
    batchId: Hex,
    granteeListRef: Hex,
    historyRef: Hex,
    grantees: Hex[],
    requestOptions?: SwarmRequestOptions,
  ): Promise<GranteeListUpdate>;

  /**
   * Remove public keys from the grantee list, re-keying the ACT.
   *
   * `contentRef` is the protected object's current encrypted reference: a revocation may return a
   * rotated one. Access already exercised is not withdrawn — a grantee keeps whatever they have
   * already dereferenced.
   */
  revokeGrantees(
    batchId: Hex,
    granteeListRef: Hex,
    historyRef: Hex,
    contentRef: Hex,
    grantees: Hex[],
    requestOptions?: SwarmRequestOptions,
  ): Promise<GranteeListUpdate>;

  /**
   * The grantee list's current members, as compressed public keys.
   */
  listGrantees(granteeListRef: Hex, historyRef: Hex, requestOptions?: SwarmRequestOptions): Promise<Hex[]>;

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
