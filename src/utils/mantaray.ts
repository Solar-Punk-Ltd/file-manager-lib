import { Bee, DownloadOptions, MantarayNode, Reference } from '@ethersphere/bee-js';

export async function loadMantaray(
  bee: Bee,
  mantarayRef: string | Reference,
  options?: DownloadOptions,
): Promise<MantarayNode> {
  const mantaray = await MantarayNode.unmarshal(bee, mantarayRef, options);
  await mantaray.loadRecursively(bee);
  return mantaray;
}

export function getForksMap(root: MantarayNode, paths?: string[]): Record<string, string> {
  const nodesMap: Record<string, string> = root.collectAndMap();

  if (paths && paths.length > 0) {
    const filteredMap: Record<string, string> = {};
    for (const path of paths) {
      if (path in nodesMap) {
        filteredMap[path] = nodesMap[path];
      }
    }

    return filteredMap;
  }

  return nodesMap;
}
