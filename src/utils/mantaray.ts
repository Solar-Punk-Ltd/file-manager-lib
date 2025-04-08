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

export function getForkAddresses(root: MantarayNode, paths?: string[]): string[] {
  let nodes: MantarayNode[] = root.collect();

  if (paths && paths.length > 0) {
    nodes = nodes.filter((node) => paths.includes(node.fullPathString));
  }

  const addresses: string[] = [];
  for (const node of nodes) {
    addresses.push(new Reference(node.targetAddress).toString());
  }

  return addresses;
}
