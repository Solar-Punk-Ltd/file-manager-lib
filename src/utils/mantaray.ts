import { BatchId, Bee, DownloadOptions, MantarayNode, RedundantUploadOptions, Reference } from '@ethersphere/bee-js';
import { ReferenceWithHistory } from './types';

export async function saveMantaray(
  bee: Bee,
  batchId: BatchId,
  mantaray: MantarayNode,
  options?: RedundantUploadOptions,
): Promise<ReferenceWithHistory> {
  const result = await mantaray.saveRecursively(bee, batchId, options);
  return {
    reference: result.reference.toString(),
    historyRef: result.historyAddress.getOrThrow().toString(),
  };
}

export async function loadMantaray(
  bee: Bee,
  mantarayRef: Reference | string,
  options?: DownloadOptions,
): Promise<MantarayNode> {
  const mantaray = await MantarayNode.unmarshal(bee, mantarayRef, options);
  await mantaray.loadRecursively(bee);
  return mantaray;
}
