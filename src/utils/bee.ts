import type { BeeRequestOptions, RedundancyLevel } from '@ethersphere/bee-js';
import { type BatchId, Bytes, FeedIndex, Topic } from '@ethersphere/core-sdk';

import type { SwarmClient } from '../types/swarmClient';
import { type ActReferences, type FeedResultWithIndex, type StampInfo } from '../types/utils';

import { FEED_INDEX_NONE, FEED_INDEX_ZERO } from './constants';
import { generateRandomBytes } from './crypto';
import { ErrorHandler, StampError } from './errors';

const errorHandler = ErrorHandler.getInstance();

export async function getFeedData(
  swarmClient: SwarmClient,
  topic: Topic,
  owner?: string,
  index?: bigint,
  requestOptions?: BeeRequestOptions,
): Promise<FeedResultWithIndex> {
  const res = await swarmClient.readFeed(
    topic.toString(),
    owner ?? swarmClient.owner,
    index?.toString(),
    requestOptions,
  );

  return {
    feedIndex: FeedIndex.fromBigInt(BigInt(res.index)),
    feedIndexNext: FeedIndex.fromBigInt(BigInt(res.nextIndex)),
    payload: new Bytes(res.payload),
  };
}

export async function getTopicAndVersion(
  swarmClient: SwarmClient,
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

  const { feedIndex, feedIndexNext } = await getFeedData(
    swarmClient,
    new Topic(topic),
    swarmClient.owner,
    undefined,
    requestOptions,
  );
  if (feedIndex.equals(FEED_INDEX_NONE)) {
    return { topic, version: FEED_INDEX_ZERO.toString() };
  }

  return { topic, version: feedIndexNext.toString() };
}

export interface FeedTarget {
  batchId: string;
  topic: string;
  redundancyLevel?: RedundancyLevel;
  actHistoryAddress?: string;
  index?: bigint;
}

export interface FeedWriteResult {
  contentRefs: ActReferences;
  index: bigint;
  nextIndex: bigint;
}

export async function writeActFeed(
  swarmClient: SwarmClient,
  payload: string | Uint8Array,
  target: FeedTarget,
  requestOptions?: BeeRequestOptions,
): Promise<FeedWriteResult> {
  const upload = await swarmClient.uploadProtected(
    target.batchId,
    payload,
    target.actHistoryAddress,
    { redundancyLevel: target.redundancyLevel },
    requestOptions,
  );
  const contentRefs: ActReferences = {
    reference: upload.contentRefs.reference.toString(),
    historyRef: upload.contentRefs.historyRef.toString(),
  };

  let writeIndex = target.index;
  if (writeIndex === undefined) {
    const { feedIndexNext } = await getFeedData(
      swarmClient,
      new Topic(target.topic),
      swarmClient.owner,
      undefined,
      requestOptions,
    );
    writeIndex = feedIndexNext.toBigInt();
  }

  await swarmClient.writeFeed(
    target.batchId,
    target.topic,
    JSON.stringify(contentRefs),
    writeIndex.toString(),
    undefined,
    requestOptions,
  );

  return { contentRefs, index: writeIndex, nextIndex: writeIndex + 1n };
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
