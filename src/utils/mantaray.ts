import { Bee, DownloadOptions, MantarayNode, Reference } from '@ethersphere/bee-js';

export async function loadMantaray(
  bee: Bee,
  mantarayRef: Reference | string,
  options?: DownloadOptions,
): Promise<MantarayNode> {
  const mantaray = await MantarayNode.unmarshal(bee, mantarayRef, options);
  await mantaray.loadRecursively(bee);
  return mantaray;
}
