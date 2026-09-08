import type { Bee } from '@ethersphere/bee-js';
import { Bytes, PrivateKey, Topic } from '@ethersphere/core-sdk';
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
  type SwarmFeedWriteOptions,
  type SwarmRequestOptions,
  type SwarmUploadOptions,
} from '../../types/utils';
import { isNotFoundError } from '../../utils/common';
import { SWARM_ZERO_ADDRESS } from '../../utils/constants';
import { SignerError } from '../../utils/errors';

import {
  toBeeRequestOptions,
  toDownloadOptions,
  toFeedIndex,
  toIndexString,
  toRedundancyLevel,
  verifySupportedBeeVersions,
} from './utils';

/**
 * {@link SwarmClient} backed by a direct bee-js connection and a locally held signer.
 *
 * This is the Node-capable backend and preserves fm-lib's original behaviour. The signer never
 * leaves this class — `FileManager` sees only {@link owner} and {@link publicKey}.
 */
export class BeeClient implements SwarmClient {
  private readonly signerAddress: string;
  private readonly signerPublicKey: string;
  /** ACT publisher: the *node's* public key, not the signer's. Resolved in {@link initialize}. */
  private nodePublicKey: string | undefined;

  constructor(
    private readonly bee: Bee,
    private readonly signer: PrivateKey,
  ) {
    if (!signer) {
      throw new SignerError('Signer required');
    }
    this.signerAddress = signer.publicKey().address().toString();
    this.signerPublicKey = signer.publicKey().toCompressedHex();
  }

  get owner(): Hex {
    return this.signerAddress;
  }

  get publicKey(): Hex {
    return this.signerPublicKey;
  }

  get actPublisher(): Hex {
    if (!this.nodePublicKey) {
      throw new SignerError('BeeClient not initialized — call initialize() before ACT operations');
    }

    return this.nodePublicKey;
  }

  async initialize(requestOptions?: SwarmRequestOptions): Promise<void> {
    const ro = toBeeRequestOptions(requestOptions);
    await verifySupportedBeeVersions(this.bee, ro);

    this.nodePublicKey = (await this.bee.connectivity.getNodeAddresses(ro)).publicKey.toCompressedHex();
  }

  /** `keccak256(signerBytes ‖ label)` — keccak is not length-extendable, so the concatenation is safe. */
  // eslint-disable-next-line require-await
  async deriveSecret(label: string): Promise<Uint8Array> {
    const seedBytes = Bytes.fromUtf8(label);
    const secretAsUint8Arr = new Uint8Array([...this.signer.toUint8Array(), ...seedBytes.toUint8Array()]);
    return Bytes.keccak256(secretAsUint8Arr).toUint8Array();
  }

  async getStamp(batchId?: Hex, requestOptions?: SwarmRequestOptions): Promise<StampInfo | undefined> {
    if (!batchId) return undefined;

    const batches = await this.bee.stamp.getAll(toBeeRequestOptions(requestOptions));
    const batch = batches.find((b) => b.batchID.toString() === batchId.toString());
    if (!batch) return undefined;

    return { batchId: batch.batchID.toString(), usable: batch.usable, depth: batch.depth };
  }

  // --- plain bytes ---

  async uploadData(
    batchId: Hex,
    data: Uint8Array | string | Blob | Readable,
    options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientUploadResult> {
    const result = await this.bee.data.upload(
      batchId,
      data,
      { encrypt: options?.encrypt, redundancyLevel: toRedundancyLevel(options?.redundancyLevel) },
      toBeeRequestOptions(requestOptions),
    );

    return { reference: result.reference.toString(), tagUid: result.tagUid };
  }

  async downloadData(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array> {
    const bytes = await this.bee.data.download(
      reference,
      toDownloadOptions(options),
      toBeeRequestOptions(requestOptions),
    );

    return bytes.toUint8Array();
  }

  downloadStream(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.bee.data.downloadReadable(reference, toDownloadOptions(options), toBeeRequestOptions(requestOptions));
  }

  // --- ACT-protected bytes ---

  async uploadProtected(
    batchId: Hex,
    data: Uint8Array | string | Blob | Readable,
    historyRef?: Hex,
    options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientProtectedUploadResult> {
    const result = await this.bee.data.upload(
      batchId,
      data,
      { act: true, actHistoryAddress: historyRef, redundancyLevel: toRedundancyLevel(options?.redundancyLevel) },
      toBeeRequestOptions(requestOptions),
    );

    return {
      contentRefs: {
        reference: result.reference.toString(),
        historyRef: result.historyAddress.getOrThrow().toString(),
      },
      tagUid: result.tagUid,
    };
  }

  async downloadProtected(
    refs: ProtectedRefs,
    at?: number,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array> {
    const bytes = await this.bee.data.download(
      refs.reference,
      {
        actHistoryAddress: refs.historyRef,
        actPublisher: refs.publisher,
        actTimestamp: at,
        ...toDownloadOptions(options),
      },
      toBeeRequestOptions(requestOptions),
    );

    return bytes.toUint8Array();
  }

  async downloadProtectedStream(
    refs: ProtectedRefs,
    at?: number,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const bytes = await this.bee.data.downloadReadable(
      refs.reference,
      {
        actHistoryAddress: refs.historyRef,
        actPublisher: refs.publisher,
        actTimestamp: at,
        ...toDownloadOptions(options),
      },
      toBeeRequestOptions(requestOptions),
    );

    return bytes;
  }

  // --- chunks ---

  async uploadChunk(
    batchId: Hex,
    data: Uint8Array,
    /** Erasure coding is applied at `/bytes`, not per chunk — accepted for call-site symmetry. */
    _options?: SwarmUploadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<ClientUploadResult> {
    const result = await this.bee.chunk.upload(batchId, data, undefined, toBeeRequestOptions(requestOptions));

    return { reference: result.reference.toString(), tagUid: result.tagUid };
  }

  downloadChunk(
    reference: Hex,
    options?: SwarmDownloadOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<Uint8Array> {
    return this.bee.chunk.download(reference, toDownloadOptions(options), toBeeRequestOptions(requestOptions));
  }

  // --- Feed operations ---

  async readFeed(
    topic: Hex,
    owner: Hex,
    index?: FeedIndexString,
    requestOptions?: SwarmRequestOptions,
  ): Promise<FeedRead> {
    const ro = toBeeRequestOptions(requestOptions);

    try {
      const reader = this.bee.feed.makeReader(new Topic(topic).toUint8Array(), owner, ro);
      const result = await reader.downloadPayload(index !== undefined ? { index: toFeedIndex(index) } : undefined);

      return {
        payload: result.payload.toUint8Array(),
        index: toIndexString(result.feedIndex),
        nextIndex: toIndexString(result.feedIndexNext ?? result.feedIndex.next()),
      };
    } catch (err) {
      if (isNotFoundError(err)) {
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
    batchId: Hex,
    topic: Hex,
    payload: Uint8Array | string,
    index: FeedIndexString,
    /** Only `signer` is read: feed updates are single chunks, so there is no erasure coding to apply. */
    options?: SwarmFeedWriteOptions,
    requestOptions?: SwarmRequestOptions,
  ): Promise<FeedWrite> {
    const writer = this.bee.feed.makeWriter(
      new Topic(topic).toUint8Array(),
      options?.signer ? new PrivateKey(options.signer) : this.signer,
      toBeeRequestOptions(requestOptions),
    );

    const result = await writer.uploadPayload(batchId, payload, { index: toFeedIndex(index) });

    return { reference: result.reference.toString(), index };
  }
}
