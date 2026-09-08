import type { BeeRequestOptions } from '@ethersphere/bee-js';
import { type BatchId, Bytes, FeedIndex, Reference, Topic } from '@ethersphere/core-sdk';

import type { Identity } from '../types/identity';
import type { SwarmClient } from '../types/swarmClient';
import {
  type ContentRef,
  type FeedResultWithIndex,
  type FeedTarget,
  type FeedWriteResult,
  type StampInfo,
} from '../types/utils';

import { FEED_INDEX_NONE, FEED_INDEX_ZERO } from './constants';
import { generateRandomBytes, openWithKey, sealWithKey } from './crypto';
import { ErrorHandler, StampError } from './errors';

const errorHandler = ErrorHandler.getInstance();

export async function getFeedData(
  swarmClient: SwarmClient,
  topic: Topic,
  owner: string,
  index?: bigint,
  requestOptions?: BeeRequestOptions,
): Promise<FeedResultWithIndex> {
  const res = await swarmClient.readFeed(topic.toString(), owner, index?.toString(), requestOptions);

  return {
    feedIndex: FeedIndex.fromBigInt(BigInt(res.index)),
    feedIndexNext: FeedIndex.fromBigInt(BigInt(res.nextIndex)),
    payload: new Bytes(res.payload),
  };
}

export async function getTopicAndVersion(
  swarmClient: SwarmClient,
  owner: string,
  currentVersion?: string,
  currentTopic?: string | Topic,
  requestOptions?: BeeRequestOptions,
): Promise<{ topic: string; version: string }> {
  let version: string | undefined;
  let topic: string;

  if (!currentTopic) {
    const randomTopic = generateRandomBytes(Topic.LENGTH);
    version = FEED_INDEX_ZERO.toString();
    topic = new Topic(randomTopic).toString();
  } else {
    topic = currentTopic.toString();
  }

  if (version) {
    return { topic, version };
  }

  if (currentVersion !== undefined) {
    return { topic, version: new FeedIndex(currentVersion).next().toString() };
  }

  const feedTopic = new Topic(topic);
  const { feedIndex, feedIndexNext } = await getFeedData(swarmClient, feedTopic, owner, undefined, requestOptions);
  if (feedIndex.equals(FEED_INDEX_NONE)) {
    return { topic, version: FEED_INDEX_ZERO.toString() };
  }

  return { topic, version: feedIndexNext.toString() };
}

/**
 * Seal `reference` under `key` and write it as the feed payload at `target.topic`.
 *
 * A node's feed payload is one Swarm reference and nothing else: `AES-GCM(key, reference)`, ~60 or
 * ~92 bytes, unreadable without the node's key. This is the library's only feed write outside the
 * identity envelope, signed by `identity.signer` so it lands under the identity's address rather
 * than the backend's.
 *
 * Call it directly for a reference that already exists — every manifest root, which needs no blob
 * in between. {@link writeEncryptedFeed} is the variant that uploads first.
 */
export async function writeSealedRefFeed(
  swarmClient: SwarmClient,
  identity: Identity,
  reference: Reference,
  key: Uint8Array,
  target: FeedTarget,
  requestOptions?: BeeRequestOptions,
): Promise<FeedWriteResult> {
  const sealed = await sealWithKey(key, reference.toUint8Array());

  let writeIndex = target.index;
  if (writeIndex === undefined) {
    const { feedIndexNext } = await getFeedData(
      swarmClient,
      new Topic(target.topic),
      identity.owner,
      undefined,
      requestOptions,
    );
    writeIndex = feedIndexNext.toBigInt();
  }

  await swarmClient.writeFeed(
    target.batchId,
    target.topic,
    sealed,
    writeIndex.toString(),
    { signer: identity.signer },
    requestOptions,
  );

  return { contentRef: { reference: reference.toString() }, index: writeIndex, nextIndex: writeIndex + 1n };
}

/**
 * Upload `payload` with Swarm native encryption, then seal the 64-byte reference into the feed.
 *
 * For a payload too large for a feed slot — a file record, whose `customMetadata` is unbounded. The
 * reference carries the content key, so sealing the reference is what gates the payload; the bytes
 * themselves need no second encryption.
 */
export async function writeEncryptedFeed(
  swarmClient: SwarmClient,
  identity: Identity,
  payload: string | Uint8Array,
  key: Uint8Array,
  target: FeedTarget,
  requestOptions?: BeeRequestOptions,
): Promise<FeedWriteResult> {
  const upload = await swarmClient.uploadData(
    target.batchId,
    payload,
    { encrypt: true, redundancyLevel: target.redundancyLevel },
    requestOptions,
  );

  return await writeSealedRefFeed(swarmClient, identity, new Reference(upload.reference), key, target, requestOptions);
}

/**
 * Open a sealed feed payload back into the reference it carries.
 *
 * Throws if `key` is wrong (GCM authenticates) or if the plaintext is not a 32/64-byte reference,
 * so a mis-keyed read fails here rather than as a puzzling 404 further down.
 */
export async function openFeedRef(payload: Bytes, key: Uint8Array): Promise<ContentRef> {
  const opened = await openWithKey(key, payload.toUint8Array());

  return { reference: new Reference(opened).toString() };
}

export async function fetchStamp(
  swarmClient: SwarmClient,
  batchId: string | BatchId,
  requestOptions?: BeeRequestOptions,
): Promise<StampInfo | undefined> {
  try {
    return await swarmClient.getStamp(batchId.toString(), requestOptions);
  } catch (err: unknown) {
    errorHandler.handleError(err, 'Failed to fetch stamp');
    return;
  }
}

export const verifyStampUsability = (
  s: StampInfo | undefined,
  requestedBatchId?: string,
  mustBeUsable: boolean = true,
): StampInfo => {
  if (!s || (mustBeUsable && !s.usable)) {
    const batchIdStr = s ? s.batchId.toString().slice(0, 6) : (requestedBatchId?.slice(0, 6) ?? 'unknown');
    throw new StampError(`Stamp with batchId: ${batchIdStr}... not found OR not usable`);
  }

  return s;
};
