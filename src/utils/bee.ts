import type { BeeRequestOptions } from '@ethersphere/bee-js';
import { type BatchId, Bytes, FeedIndex, Reference, Topic } from '@ethersphere/core-sdk';

import type { Identity } from '../types/identity';
import type { StampInfo } from '../types/info';
import type { BulletinHandle, BulletinPayload, GrantBlob, ShareFeedHead, ShareHandle } from '../types/share';
import type { SwarmClient } from '../types/swarmClient';
import { type ContentRef, type FeedResultWithIndex, type FeedTarget, type FeedWriteResult } from '../types/utils';

import { assertBulletinPayload, assertGrantBlob, assertShareFeedHead } from './asserts';
import { FEED_INDEX_NONE, FEED_INDEX_ZERO } from './constants';
import { decryptBytes, encryptBytes, generateRandomBytes } from './crypto';
import { DriveError, ErrorHandler, ShareError, StampError } from './errors';

const errorHandler = ErrorHandler.getInstance();

// A feed payload is a 4-byte big-endian epoch tag followed by the sealed reference. The tag is in
// the clear because a reader has to know which epoch secret to derive before it can open anything.
const EPOCH_TAG_LENGTH = 4;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The epoch a feed payload was sealed under. Read this before deriving the key that opens it. */
export function feedEpoch(payload: Bytes): number {
  const bytes = payload.toUint8Array();
  if (bytes.length <= EPOCH_TAG_LENGTH) {
    throw new DriveError(`Feed payload is ${bytes.length} bytes — too short to carry an epoch tag`);
  }

  return view(bytes).getUint32(0, false);
}

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

export async function writeSealedRefFeed(
  swarmClient: SwarmClient,
  identity: Identity,
  reference: Reference,
  key: CryptoKey,
  epoch: number,
  target: FeedTarget,
  requestOptions?: BeeRequestOptions,
): Promise<FeedWriteResult> {
  const sealed = await encryptBytes(key, reference.toUint8Array());
  const payload = new Uint8Array(EPOCH_TAG_LENGTH + sealed.length);
  view(payload).setUint32(0, epoch, false);
  payload.set(sealed, EPOCH_TAG_LENGTH);

  const { index, nextIndex } = await writePlainFeed(swarmClient, identity, payload, target, requestOptions);

  return { contentRef: { reference: reference.toString() }, index, nextIndex };
}

export async function writePlainFeed(
  swarmClient: SwarmClient,
  identity: Identity,
  payload: string | Uint8Array,
  target: FeedTarget,
  requestOptions?: BeeRequestOptions,
): Promise<{ index: bigint; nextIndex: bigint }> {
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
    payload,
    writeIndex.toString(),
    { signer: identity.signer },
    requestOptions,
  );

  return { index: writeIndex, nextIndex: writeIndex + 1n };
}

export async function writeEncryptedFeed(
  swarmClient: SwarmClient,
  identity: Identity,
  payload: string | Uint8Array,
  key: CryptoKey,
  epoch: number,
  target: FeedTarget,
  requestOptions?: BeeRequestOptions,
): Promise<FeedWriteResult> {
  const upload = await swarmClient.uploadData(
    target.batchId,
    payload,
    { encrypt: true, redundancyLevel: target.redundancyLevel },
    requestOptions,
  );

  return await writeSealedRefFeed(
    swarmClient,
    identity,
    new Reference(upload.reference),
    key,
    epoch,
    target,
    requestOptions,
  );
}

/** Unseal a feed payload. `key` must be the effective key for the epoch {@link feedEpoch} reports. */
export async function openFeedRef(payload: Bytes, key: CryptoKey): Promise<ContentRef> {
  const opened = await decryptBytes(key, payload.toUint8Array().subarray(EPOCH_TAG_LENGTH));

  return { reference: new Reference(opened).toString() };
}

export async function readShareHead(
  swarmClient: SwarmClient,
  handle: ShareHandle,
  requestOptions?: BeeRequestOptions,
): Promise<ShareFeedHead> {
  const { payload, feedIndex } = await getFeedData(
    swarmClient,
    new Topic(handle.shareTopic),
    handle.owner,
    undefined,
    requestOptions,
  );
  if (feedIndex.equals(FEED_INDEX_NONE)) {
    throw new ShareError('Share feed has no head — the handle is wrong or the grant was never published');
  }

  const head = payload.toJSON();
  assertShareFeedHead(head);

  return head;
}

export async function openGrantBlob(
  swarmClient: SwarmClient,
  head: ShareFeedHead,
  requestOptions?: BeeRequestOptions,
): Promise<GrantBlob> {
  const bytes = await swarmClient.downloadProtected(
    { reference: head.reference, historyRef: head.historyRef, publisher: head.publisher },
    undefined,
    undefined,
    requestOptions,
  );

  const blob = new Bytes(bytes).toJSON();
  assertGrantBlob(blob);

  return blob;
}

/** The drive's current epoch secret, if this identity is on the bulletin's grantee list. */
export async function readBulletin(
  swarmClient: SwarmClient,
  handle: BulletinHandle,
  requestOptions?: BeeRequestOptions,
): Promise<BulletinPayload> {
  const { payload, feedIndex } = await getFeedData(
    swarmClient,
    new Topic(handle.topic),
    handle.owner,
    undefined,
    requestOptions,
  );
  if (feedIndex.equals(FEED_INDEX_NONE)) {
    throw new ShareError('Bulletin feed has no head — the drive has published no epoch secret');
  }

  const head = payload.toJSON();
  assertShareFeedHead(head);

  const bytes = await swarmClient.downloadProtected(
    { reference: head.reference, historyRef: head.historyRef, publisher: head.publisher },
    undefined,
    undefined,
    requestOptions,
  );

  const body = new Bytes(bytes).toJSON();
  assertBulletinPayload(body);

  return body;
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
