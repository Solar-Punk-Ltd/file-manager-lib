import { Bee, BeeRequestOptions, FeedIndex, PrivateKey, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import { ActReferences } from '../../types/v2';
import { getFeedData } from '../bee';

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
