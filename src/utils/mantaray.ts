import { Bee, BeeRequestOptions, DownloadOptions, MantarayNode, Reference } from '@ethersphere/bee-js';

import { FolderFileEntry } from '../types/info';

import {
  MANIFEST_METADATA_CONTENT_REF,
  MANIFEST_METADATA_CONTENT_VERSION,
  MANIFEST_METADATA_FILE_TOPIC,
  MANIFEST_METADATA_PATH,
  MANIFEST_METADATA_RECORD_VERSION,
  MANIFEST_METADATA_ROOT_FEED_TOPIC,
} from './constants';

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

/**
 * Extracts per-file metadata from all leaf nodes of a loaded mantaray tree.
 * Must be called after loadRecursively so that targetAddresses and metadata are populated.
 */
export function getFolderEntries(root: MantarayNode): FolderFileEntry[] {
  const nodes = root.collect();

  return nodes.map((node) => {
    const meta = node.metadata ?? {};
    const contentRef = meta[MANIFEST_METADATA_CONTENT_REF] ?? new Reference(node.targetAddress).toHex();

    return {
      path: meta[MANIFEST_METADATA_PATH] ?? node.fullPathString,
      contentRef,
      contentVersion: meta[MANIFEST_METADATA_CONTENT_VERSION] ?? '0',
      recordVersion: meta[MANIFEST_METADATA_RECORD_VERSION] ?? '0',
      fileTopic: meta[MANIFEST_METADATA_FILE_TOPIC],
      rootFeedTopic: meta[MANIFEST_METADATA_ROOT_FEED_TOPIC],
      granteeListRef: meta['granteelistref'],
      actHistoryAddress: meta['swarm-act-history-address'],
      rawMetadata: Object.keys(meta).length > 0 ? { ...meta } : undefined,
    };
  });
}
