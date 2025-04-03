import {
  BatchId,
  Bee,
  DownloadOptions,
  MantarayNode,
  RedundantUploadOptions,
  Reference,
  UploadResult,
} from '@ethersphere/bee-js';

export async function saveMantaray(
  bee: Bee,
  batchId: BatchId,
  mantaray: MantarayNode,
  options?: RedundantUploadOptions,
): Promise<UploadResult> {
  return await mantaray.saveRecursively(bee, batchId, options);
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
