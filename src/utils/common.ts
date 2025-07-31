import {
  BatchId,
  Bee,
  BeeRequestOptions,
  DownloadOptions,
  EthAddress,
  FeedIndex,
  Reference,
  Topic,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import { getRandomBytesBrowser } from './browser';
import { FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from './constants';
import { getRandomBytesNode } from './node';
import { FeedPayloadResult, WrappedUploadResult } from './types';
import { FileInfoError } from './errors';
import { asserWrappedUploadResult } from './asserts';

// Fetches the feed data for the given topic, index and address
export async function getFeedData(
  bee: Bee,
  topic: Topic,
  address: EthAddress | string,
  index?: bigint,
  options?: BeeRequestOptions,
): Promise<FeedPayloadResult> {
  try {
    const feedReader = bee.makeFeedReader(topic.toUint8Array(), address, options);
    if (index !== undefined) {
      return await feedReader.download({ index: FeedIndex.fromBigInt(index) });
    }
    return await feedReader.download();
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

export function generateTopic(): Topic {
  if (isNode) {
    return new Topic(getRandomBytesNode(Topic.LENGTH));
  }
  return new Topic(getRandomBytesBrowser(Topic.LENGTH));
}

// status is undefined in the error object
// Determines if the error is about 'Not Found'
export function isNotFoundError(error: any): boolean {
  return error.stack?.includes('404') || error.message?.includes('Not Found') || error.message?.includes('404');
}

export async function buyStamp(bee: Bee, amount: string | bigint, depth: number, label?: string): Promise<BatchId> {
  const stamp = (await bee.getAllPostageBatch()).find((b) => b.label === label);
  if (stamp && stamp.usable) {
    return stamp.batchID;
  }

  return await bee.createPostageBatch(amount, depth, {
    waitForUsable: true,
    label,
  });
}

export async function getWrappedData(
  bee: Bee,
  eRef: string | Reference,
  options?: DownloadOptions,
): Promise<WrappedUploadResult> {
  try {
    const rawData = await bee.downloadData(eRef.toString(), options);
    const wrappedResult = rawData.toJSON() as WrappedUploadResult;
    asserWrappedUploadResult(wrappedResult);
    return wrappedResult;
  } catch (error) {
    throw new FileInfoError(`Failed to get wrapped data: ${error}`);
  }
}

export async function settlePromises<T>(promises: Promise<T>[], cb: (value: T) => void): Promise<void> {
  await Promise.allSettled(promises).then((results) => {
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        cb(result.value);
      } else {
        console.error(`Failed to resolve promise: ${result.reason}`);
      }
    });
  });
}
