import type { SwarmIdClient } from '@snaha/swarm-id';
import type { Readable } from 'stream';

import type { StampInfo } from '../../types/info';
import type { SwarmClient } from '../../types/swarmClient';
import type { ClientProtectedUploadResult, ClientUploadResult } from '../../types/upload';
import {
  type FeedIndexString,
  type FeedRead,
  type FeedWrite,
  type GranteeListUpdate,
  type Hex,
  type ProtectedRefs,
  type SwarmDownloadOptions,
  type SwarmFeedWriteOptions,
  type SwarmRequestOptions,
  type SwarmUploadOptions,
} from '../../types/utils';
import { errorMessage } from '../../utils/common';
import { FEED_INDEX_NOT_FOUND, FEED_INDEX_START, SWARM_ZERO_ADDRESS } from '../../utils/constants';
import { SignerError } from '../../utils/errors';

import {
  HAS_TIMESTAMP,
  isFeedNotFound,
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
 * - **A protected upload cannot continue an ACT history.** `actUploadData` takes no history
 *   reference, so each one mints a fresh history and grantee list. Amending an existing grant is
 *   unaffected: `actAddGrantees`/`actRevokeGrantees` both take a history and carry it forward.
 * - **`redundancyStrategy` is dropped on protected downloads** — `actDownloadData` has no options
 *   parameter.
 * - **`redundancyLevel` is dropped on upload.** Data written through this backend has no erasure
 *   coding; `encrypt` does survive, since swarm-id's `UploadOptions` carries it.
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

  /**
   * `HMAC(appSecret, label)`, computed inside the iframe. Requires `@snaha/swarm-id` >= 0.4.0.
   *
   * Scoped to `(identity, app origin)`, so an identity provisioned on one origin does not unseal on
   * another.
   */
  async deriveSecret(label: string): Promise<Uint8Array> {
    return await this.client.deriveAppSecret(label);
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
    data: Uint8Array | string | Blob | Readable,
    /** Only `encrypt` survives — swarm-id has no home for `redundancyLevel`. */
    options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientUploadResult> {
    const dataBytes = await toBytesAsync(data);
    const result = await this.client.uploadData(
      dataBytes,
      { encrypt: options?.encrypt },
      toSnahaRequestOptions(requestOptions),
    );

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
    grantees?: Hex[],
    /** Ignored — `actUploadData` always mints a fresh history. See the class note. */
    _historyRef?: Hex,
    /** `redundancyLevel` is the only member and swarm-id has no home for it */
    _options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientProtectedUploadResult> {
    const result = await this.client.actUploadData(
      await toBytesAsync(data),
      grantees ?? [],
      undefined,
      toSnahaRequestOptions(requestOptions),
    );

    return {
      contentRefs: { reference: result.encryptedReference, historyRef: result.historyReference },
      granteeListRef: result.granteeListReference,
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

  // --- grantee lists ---
  //
  // swarm-id addresses a grantee list by its ACT history, so `batchId` and `granteeListRef` carry
  // no meaning here — the list's own reference is returned for the caller to keep in step.

  async addGrantees(
    _batchId: Hex,
    _granteeListRef: Hex,
    historyRef: Hex,
    grantees: Hex[],
    requestOptions?: SwarmRequestOptions,
  ): Promise<GranteeListUpdate> {
    const result = await this.client.actAddGrantees(historyRef, grantees, toSnahaRequestOptions(requestOptions));

    return { granteeListRef: result.granteeListReference, historyRef: result.historyReference };
  }

  async revokeGrantees(
    _batchId: Hex,
    _granteeListRef: Hex,
    historyRef: Hex,
    contentRef: Hex,
    grantees: Hex[],
    requestOptions?: SwarmRequestOptions,
  ): Promise<GranteeListUpdate> {
    const result = await this.client.actRevokeGrantees(
      historyRef,
      contentRef,
      grantees,
      toSnahaRequestOptions(requestOptions),
    );

    return {
      granteeListRef: result.granteeListReference,
      historyRef: result.historyReference,
      contentRef: result.encryptedReference,
    };
  }

  listGrantees(_granteeListRef: Hex, historyRef: Hex, requestOptions?: SwarmRequestOptions): Promise<Hex[]> {
    return this.client.actGetGrantees(historyRef, toSnahaRequestOptions(requestOptions));
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
    /** Only `signer` is read: feed updates are single chunks, so there is no erasure coding to apply. */
    options?: SwarmFeedWriteOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<FeedWrite> {
    // Without a signer the proxy signs with the app key, so the feed owner matches `owner`. With
    // one, the key crosses the postMessage boundary into the swarm-id iframe — which already holds
    // the master key this one ultimately descends from, so it adds no party to the trust boundary.
    const writer = this.client.makeSequentialFeedWriter(
      { topic, signer: options?.signer },
      toSnahaRequestOptions(requestOptions),
    );

    const result = await writer.uploadRawPayload(payload, { index: BigInt(index), hasTimestamp: HAS_TIMESTAMP });

    return { reference: result.reference.toString(), index };
  }

  private appKey(): { address: Hex; publicKey: Hex } {
    let appKey: { address: string; publicKey: string } | undefined;

    try {
      appKey = this.client.connectionInfo.appKey;
    } catch (err) {
      throw new SignerError(`SwarmIdClient is not initialized: ${errorMessage(err)}`);
    }

    if (!appKey) {
      throw new SignerError('Swarm ID is not authenticated — connect() before using the client');
    }

    return appKey;
  }
}
