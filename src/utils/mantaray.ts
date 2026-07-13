import { Bee, BeeRequestOptions, DownloadOptions, MantarayNode, Reference } from '@ethersphere/bee-js';

import { NodeType } from '../types/info';

import { MANIFEST_METADATA_FILE_TOPIC, MANIFEST_METADATA_NODE_TOPIC, MANIFEST_METADATA_NODE_TYPE } from './constants';

export async function loadMantaray(
  bee: Bee,
  mantarayRef: string | Reference,
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<MantarayNode> {
  const mantaray = await MantarayNode.unmarshal(bee, mantarayRef, options, requestOptions);
  await mantaray.loadRecursively(bee, options, requestOptions);
  return mantaray;
}

export interface DirectoryEntry {
  path: string;
  type: NodeType;
  topic: string;
  fileTopic?: string;
  rawMetadata: Record<string, string>;
}

export function getAllNodeEntries(root: MantarayNode): DirectoryEntry[] {
  const nodes = root.collect();

  return nodes
    .map((node) => {
      const meta = node.metadata ?? {};
      const nodeType = meta[MANIFEST_METADATA_NODE_TYPE] as NodeType | undefined;
      const nodeTopic = meta[MANIFEST_METADATA_NODE_TOPIC];

      if (!nodeTopic || !nodeType) return null;

      return {
        path: node.fullPathString,
        type: nodeType,
        topic: nodeTopic,
        fileTopic: nodeType === NodeType.File ? meta[MANIFEST_METADATA_FILE_TOPIC] : undefined,
        rawMetadata: { ...meta },
      } as DirectoryEntry;
    })
    .filter((e): e is DirectoryEntry => e !== null);
}
