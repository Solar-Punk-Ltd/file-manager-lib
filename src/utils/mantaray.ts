import {
  BatchId,
  Bee,
  Bytes,
  DownloadOptions,
  MantarayNode,
  RedundantUploadOptions,
  Reference,
} from '@ethersphere/bee-js';
import { ReferenceWithHistory } from './types';
import { SWARM_ZERO_ADDRESS } from './constants';

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

// TODO: decide on downloadFork vs download: based on path or eRef - all vs single ?
// TODO: use node.find() - it does not seem to work - test it
export async function downloadFork(
  bee: Bee,
  mantaray: MantarayNode,
  path: string,
  options?: DownloadOptions,
): Promise<Bytes> {
  // const node = mantaray.find(path);
  const node = mantaray.collect().find((n) => n.fullPathString === path);
  if (!node) return SWARM_ZERO_ADDRESS;

  return await bee.downloadData(node.targetAddress, options);
}
