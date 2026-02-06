import {
  BatchId,
  Bee,
  BeeRequestOptions,
  DownloadOptions,
  EthAddress,
  FeedIndex,
  PostageBatch,
  PublicKey,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { FeedPayloadResult, FeedResultWithIndex, WrappedUploadResult } from '../utils/types';

import { assertWrappedUploadResult } from './asserts';
import { isNotFoundError } from './common';
import { FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from './constants';
import { FileInfoError } from './errors';

export async function getFeedData(
  bee: Bee,
  topic: Topic,
  address: string | EthAddress,
  index?: bigint,
  requestOptions?: BeeRequestOptions,
): Promise<FeedResultWithIndex> {
  try {
    let data: FeedPayloadResult;
    const feedReader = bee.makeFeedReader(topic.toUint8Array(), address, requestOptions);

    // TODO: act options
    if (index !== undefined) {
      data = await feedReader.downloadPayload({ index: FeedIndex.fromBigInt(index) });
    } else {
      data = await feedReader.downloadPayload();
    }

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

export async function getWrappedData(
  bee: Bee,
  ref: string | Reference,
  actPublisher: string | PublicKey,
  actHistoryAddress: string | Reference,
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<WrappedUploadResult> {
  try {
    const rawData = await bee.downloadData(
      ref.toString(),
      { ...options, actPublisher, actHistoryAddress },
      requestOptions,
    );
    const wrappedResult = rawData.toJSON() as WrappedUploadResult;
    assertWrappedUploadResult(wrappedResult);
    return wrappedResult;
  } catch (error) {
    throw new FileInfoError(`Failed to get wrapped data: ${error}`);
  }
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
