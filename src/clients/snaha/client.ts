import { Bytes } from '@ethersphere/core-sdk';
import type { SwarmIdClient } from '@snaha/swarm-id';
import type { Readable } from 'stream';

import type { SwarmClient } from '../../types/swarmClient';
import {
  type ClientProtectedUploadResult,
  type ClientUploadResult,
  FEED_INDEX_NOT_FOUND,
  FEED_INDEX_START,
  type FeedIndexString,
  type FeedRead,
  type FeedWrite,
  type Hex,
  type ProtectedRefs,
  type StampInfo,
  type SwarmDownloadOptions,
  type SwarmRequestOptions,
  type SwarmUploadOptions,
} from '../../types/utils';
import { SWARM_ZERO_ADDRESS } from '../../utils/constants';
import { SignerError } from '../../utils/errors';

import {
  HAS_TIMESTAMP,
  isFeedNotFound,
  toBytes,
  toBytesAsync,
  toDownloadOptions,
  toSnahaRequestOptions,
  toStream,
} from './utils';

/**
 * {@link SwarmClient} backed by `@snaha/swarm-id`. **Browser only** — the SDK mounts a hidden
 * iframe on a trusted origin and keys never leave it.
 *
 * The caller owns the `SwarmIdClient` lifecycle: construct it, `initialize()` it, and drive
 * `connect()`/`disconnect()` before handing it here. This class only adapts an already-connected
 * client onto the port.
 *
 * ### Packaging
 * `@snaha/swarm-id` is ESM-only while fm-lib builds CJS *and* ESM. This file imports **types only**
 * — TypeScript elides those, so the emitted CJS contains no `require('@snaha/swarm-id')` and the
 * CJS build stays loadable for consumers that never touch this adapter.
 *
 * ### Identity
 * swarm-id performs ACT **client-side inside the iframe**, using a key derived from `appSecret` —
 * not on the Bee node the way bee-js does. So the ACT publisher and the identity key are the same
 * value here (`connectionInfo.appKey.publicKey`), unlike {@link BeeClient} where they differ. The
 * key is scoped to the app origin, so the same user on two origins owns two different feed sets.
 *
 * ### Known gaps against the port contract
 * - **`AbortSignal` is dropped.** swarm-id's `RequestOptions` carries only `timeout`/`headers`, so
 *   in-flight cancellation is not propagated across the iframe boundary.
 * - **Streaming is faked.** swarm-id is buffered-only; the stream variants wrap the full response
 *   in a one-chunk `ReadableStream`, so there is no backpressure.
 * - **ACT history continuity is lost.** `actUploadData` takes no history reference, so every
 *   protected write mints a fresh ACT history and grantee list. Reads still work (fm-lib persists
 *   the returned history per node), but grantee state does not carry over between writes. This
 *   matters once sharing lands, not before.
 * - **`redundancyStrategy` is dropped on protected downloads** — `actDownloadData` has no options
 *   parameter.
 * - **`redundancyLevel` is dropped on upload.
 */
export class SnahaClient implements SwarmClient {
  constructor(private readonly client: SwarmIdClient) {}

  get owner(): Hex {
    return this.appKey().address;
  }

  get publicKey(): Hex {
    return this.appKey().publicKey;
  }

  /** Identical to {@link publicKey} here — the iframe encrypts with the app key itself. */
  get actPublisher(): Hex {
    return this.appKey().publicKey;
  }

  // eslint-disable-next-line require-await
  async initialize(): Promise<void> {
    // Fails loudly now rather than at the first feed write if the user has not authenticated.
    this.appKey();
  }

  // eslint-disable-next-line require-await
  async deriveSecret(seed: string): Promise<string> {
    const { publicKey } = this.appKey();
    const appKeyBytes = new Bytes(publicKey).toUint8Array();
    const seedBytes = Bytes.fromUtf8(seed);
    const secretAsUint8Arr = new Uint8Array([...appKeyBytes, ...seedBytes.toUint8Array()]);

    return Bytes.keccak256(secretAsUint8Arr).toString();
  }

  /**
   * swarm-id owns exactly one batch per identity and offers no lookup by id, so a request for any
   * other batch is genuinely unresolvable — reported as `undefined` rather than silently
   * substituting the current one.
   */
  async getStamp(batchId?: Hex): Promise<StampInfo | undefined> {
    const batch = await this.client.getPostageBatch();
    if (!batch) return undefined;

    if (batchId && batch.batchID.toString() !== batchId.toString()) return undefined;

    return { batchId: batch.batchID.toString(), usable: batch.usable, depth: batch.depth };
  }

  // --- plain bytes ---

  async uploadData(
    /** swarm-id resolves the stamp itself; accepted for port symmetry and ignored. */
    _batchId: Hex,
    data: Uint8Array | string,
    /** `redundancyLevel` is the only member and swarm-id has no home for it */
    _options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientUploadResult> {
    const result = await this.client.uploadData(toBytes(data), undefined, toSnahaRequestOptions(requestOptions));

    return { reference: result.reference.toString(), tagUid: result.tagUid };
  }

  downloadData(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array> {
    return this.client.downloadData(reference, toDownloadOptions(options), toSnahaRequestOptions(requestOptions));
  }

  async downloadStream(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return toStream(await this.downloadData(reference, options, requestOptions));
  }

  // --- ACT-protected bytes ---

  async uploadProtected(
    _batchId: Hex,
    data: Uint8Array | string | Blob | Readable,
    /** Ignored — `actUploadData` always mints a fresh history. See the class note. */
    _historyRef?: Hex,
    /** `redundancyLevel` is the only member and swarm-id has no home for it */
    _options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientProtectedUploadResult> {
    const result = await this.client.actUploadData(
      await toBytesAsync(data),
      // The publisher is always granted access to its own upload, so self needs no entry.
      [],
      undefined,
      toSnahaRequestOptions(requestOptions),
    );

    return {
      contentRefs: { reference: result.encryptedReference, historyRef: result.historyReference },
      tagUid: result.tagUid,
    };
  }

  downloadProtected(
    refs: ProtectedRefs,
    at?: number,
    /** `actDownloadData` takes no download options — redundancy hints cannot be passed through. */
    _options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array> {
    return this.client.actDownloadData(
      refs.reference,
      refs.historyRef,
      refs.publisher,
      at,
      toSnahaRequestOptions(requestOptions),
    );
  }

  async downloadProtectedStream(
    refs: ProtectedRefs,
    at?: number,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return toStream(await this.downloadProtected(refs, at, options, requestOptions));
  }

  // --- chunks ---

  async uploadChunk(
    _batchId: Hex,
    data: Uint8Array,
    /** Erasure coding is applied at `/bytes`, not per chunk — accepted for call-site symmetry. */
    _options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientUploadResult> {
    const result = await this.client.uploadChunk(data, undefined, toSnahaRequestOptions(requestOptions));

    return { reference: result.reference.toString(), tagUid: result.tagUid };
  }

  downloadChunk(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array> {
    return this.client.downloadChunk(reference, toDownloadOptions(options), toSnahaRequestOptions(requestOptions));
  }

  // --- Feed operations ---

  async readFeed(
    topic: Hex,
    owner: Hex,
    index?: FeedIndexString,
    requestOptions?: SwarmRequestOptions,
  ): Promise<FeedRead> {
    const reader = this.client.makeSequentialFeedReader({ topic, owner }, toSnahaRequestOptions(requestOptions));

    try {
      const result = await reader.downloadRawPayload({
        index: index !== undefined ? BigInt(index) : undefined,
        hasTimestamp: HAS_TIMESTAMP,
      });

      // swarm-id already reports indexes as decimal uint64 strings — the port's own format.
      return { payload: result.payload, index: result.feedIndex, nextIndex: result.feedIndexNext };
    } catch (err) {
      if (isFeedNotFound(err)) {
        return {
          index: FEED_INDEX_NOT_FOUND,
          nextIndex: FEED_INDEX_START,
          payload: SWARM_ZERO_ADDRESS.toUint8Array(),
        };
      }

      throw err;
    }
  }

  async writeFeed(
    _batchId: Hex,
    topic: Hex,
    payload: Uint8Array | string,
    index: FeedIndexString,
    /** Feed updates are single chunks — no erasure coding to apply. */
    _options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<FeedWrite> {
    // No signer: the proxy signs with the app key, so the feed owner matches `owner`.
    const writer = this.client.makeSequentialFeedWriter({ topic }, toSnahaRequestOptions(requestOptions));

    const result = await writer.uploadRawPayload(payload, { index: BigInt(index), hasTimestamp: HAS_TIMESTAMP });

    return { reference: result.reference.toString(), index };
  }

  private appKey(): { address: Hex; publicKey: Hex } {
    let appKey: { address: string; publicKey: string } | undefined;

    try {
      appKey = this.client.connectionInfo.appKey;
    } catch (err) {
      throw new SignerError(`SwarmIdClient is not initialized: ${(err as Error).message}`);
    }

    if (!appKey) {
      throw new SignerError('Swarm ID is not authenticated — connect() before using the client');
    }

    return appKey;
  }
}
