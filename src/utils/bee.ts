import { BatchId, Bee, BeeRequestOptions, EthAddress, FeedIndex, PostageBatch, Topic } from '@ethersphere/bee-js';

import { FeedResultWithIndex } from '../types/utils';

import { isNotFoundError } from './common';
import { FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from './constants';
import { generateRandomBytes } from './crypto';
import { StampError } from './errors';

import { FileRecord } from '@/types';

export async function getFeedData(
  bee: Bee,
  topic: Topic,
  address: string | EthAddress,
  index?: bigint,
  requestOptions?: BeeRequestOptions,
): Promise<FeedResultWithIndex> {
  try {
    const feedReader = bee.makeFeedReader(topic.toUint8Array(), address, requestOptions);

    const feedOptions = index !== undefined ? { index: FeedIndex.fromBigInt(index) } : undefined;
    const data = await feedReader.downloadPayload(feedOptions);

    return {
      feedIndex: data.feedIndex,
      feedIndexNext: data.feedIndexNext ?? data.feedIndex.next(),
      payload: data.payload,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      };
    }

    throw error;
  }
}

export async function getTopicAndVersion(
  bee: Bee,
  address: string | EthAddress,
  record?: FileRecord,
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

  if (record?.version !== undefined) {
    return { topic, version: new FeedIndex(record.version).next().toString() };
  }

  const { feedIndex, feedIndexNext } = await getFeedData(bee, new Topic(topic), address, undefined, requestOptions);
  if (feedIndex.equals(FeedIndex.MINUS_ONE)) {
    return { topic, version: FEED_INDEX_ZERO.toString() };
  }

  return { topic, version: feedIndexNext.toString() };
}

export async function buyStamp(
  bee: Bee,
  amount: string | bigint,
  depth: number,
  label?: string,
  requestOptions?: BeeRequestOptions,
): Promise<BatchId> {
  const stamp = (await bee.getPostageBatches(requestOptions)).find((b) => b.label === label);
  if (stamp && stamp.usable) {
    return stamp.batchID;
  }

  return await bee.createPostageBatch(amount, depth, {
    waitForUsable: true,
    label,
  });
}

export async function fetchStamp(
  bee: Bee,
  batchId: string | BatchId,
  requestOptions?: BeeRequestOptions,
): Promise<PostageBatch | undefined> {
  try {
    return (await bee.getPostageBatches(requestOptions)).find((s) => s.batchID.toString() === batchId.toString());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error(`Failed to fetch stamp: ${error.message || error}`);
    return;
  }
}

export const verifyStampUsability = (
  s: PostageBatch | undefined,
  requestedBatchId?: string,
  mustBeUsable: boolean = true,
): PostageBatch => {
  if (!s || (mustBeUsable && !s.usable)) {
    const batchIdStr = s ? s.batchID.toString().slice(0, 6) : (requestedBatchId?.slice(0, 6) ?? 'unknown');
    throw new StampError(`Stamp with batchId: ${batchIdStr}... not found OR not usable`);
  }

  return s;
};
