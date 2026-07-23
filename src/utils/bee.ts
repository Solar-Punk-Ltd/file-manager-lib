import {
  BatchId,
  Bee,
  BeeRequestOptions,
  EthAddress,
  FeedIndex,
  PostageBatch,
  PrivateKey,
  RedundancyLevel,
  Topic,
} from '@ethersphere/bee-js';

import { ActReferences, FeedResultWithIndex } from '../types/utils';

import { isNotFoundError } from './common';
import { FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from './constants';
import { generateRandomBytes } from './crypto';
import { BeeVersionError, ErrorHandler, StampError } from './errors';
import { Logger } from './logger';

import { FileRecord } from '@/types';

const logger = Logger.getInstance();
const errorHandler = ErrorHandler.getInstance();

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
  } catch (err) {
    if (isNotFoundError(err)) {
      return {
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      };
    }

    throw err;
  }
}

export interface FeedTarget {
  batchId: string;
  topic: string;
  redundancyLevel?: RedundancyLevel;
  actHistoryAddress?: string;
  index?: bigint;
}

export async function writeActFeed(
  bee: Bee,
  signer: PrivateKey,
  payload: string | Uint8Array,
  target: FeedTarget,
  requestOptions?: BeeRequestOptions,
): Promise<{ contentRefs: ActReferences; newIndex: bigint }> {
  const upload = await bee.uploadData(
    target.batchId,
    payload,
    { act: true, actHistoryAddress: target.actHistoryAddress, redundancyLevel: target.redundancyLevel },
    requestOptions,
  );
  const contentRefs: ActReferences = {
    reference: upload.reference.toString(),
    historyRef: upload.historyAddress.getOrThrow().toString(),
  };

  let writeIndex = target.index;
  if (writeIndex === undefined) {
    const { feedIndexNext } = await getFeedData(
      bee,
      new Topic(target.topic),
      signer.publicKey().address().toString(),
      undefined,
      requestOptions,
    );
    writeIndex = feedIndexNext.toBigInt();
  }

  const fw = bee.makeFeedWriter(new Topic(target.topic).toUint8Array(), signer, requestOptions);
  await fw.uploadPayload(target.batchId, JSON.stringify(contentRefs), { index: FeedIndex.fromBigInt(writeIndex) });

  return { contentRefs, newIndex: writeIndex + 1n };
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
  } catch (err: unknown) {
    errorHandler.handleError(err, 'Failed to fetch stamp');
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

export async function verifySupportedBeeVersions(bee: Bee, requestOptions?: BeeRequestOptions): Promise<void> {
  const beeVersions = await bee.getVersions(requestOptions);
  logger.debug(`Bee version: ${beeVersions.beeVersion}`);
  logger.debug(`Bee API version: ${beeVersions.beeApiVersion}`);
  const supportedApi = await bee.isSupportedApiVersion(requestOptions);

  if (!supportedApi) {
    logger.error('Supported bee API version: ', beeVersions.supportedBeeApiVersion);
    logger.error('Supported bee version: ', beeVersions.supportedBeeVersion);
    throw new BeeVersionError('Bee or Bee API version not supported');
  }
}
