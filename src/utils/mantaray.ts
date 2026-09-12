import { type BeeRequestOptions, RedundancyLevel } from '@ethersphere/bee-js';
import { MantarayNode, Reference } from '@ethersphere/core-sdk';

import type { WrappedKeys } from '../types/crypto';
import type { Identity } from '../types/identity';
import {
  type ControlNode,
  type DriveInfo,
  type FileRecord,
  type FolderInfo,
  type ManifestHost,
  type NodeHeader,
  NodeType,
} from '../types/info';
import type { SwarmClient } from '../types/swarmClient';
import type { FeedWriteResult, SwarmDownloadOptions, SwarmRequestOptions, SwarmUploadOptions } from '../types/utils';

import { writeSealedRefFeed } from './bee';
import { getRecordStatus } from './common';
import {
  DRIVE_FORK_PREFIX,
  MANIFEST_METADATA_DRIVE_BATCH_ID,
  MANIFEST_METADATA_DRIVE_ID,
  MANIFEST_METADATA_DRIVE_KIND,
  MANIFEST_METADATA_DRIVE_NAME,
  MANIFEST_METADATA_DRIVE_OWNER,
  MANIFEST_METADATA_NODE_OWNER,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_NODE_VERSION,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  MANIFEST_METADATA_TRASHED_FROM,
  MANIFEST_METADATA_WRAPPED_CONTENT_KEY,
  MANIFEST_METADATA_WRAPPED_META_KEY,
} from './constants';
import { openWithKey, sealWithKey } from './crypto';
import { FolderError, KeyringError } from './errors';

/**
 * Load a manifest tree, decrypting every node under `key`.
 *
 * `key` is the host's `meta` key: one manifest is one node's listing, so all of its chunks share it.
 */
export async function loadMantaray(
  swarmClient: SwarmClient,
  mantarayRef: string | Reference,
  key: Uint8Array,
  options?: SwarmDownloadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<MantarayNode> {
  const root = await unmarshalNode(swarmClient, new Reference(mantarayRef), key, options, requestOptions);
  await loadForks(swarmClient, root, key, options, requestOptions);

  return root;
}

async function unmarshalNode(
  swarmClient: SwarmClient,
  reference: Reference,
  key: Uint8Array,
  options?: SwarmDownloadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<MantarayNode> {
  const sealed = await swarmClient.downloadData(reference.toString(), options, requestOptions);
  const data = await openWithKey(key, sealed);

  return MantarayNode.unmarshalFromData(data, reference.toUint8Array());
}

async function loadForks(
  swarmClient: SwarmClient,
  node: MantarayNode,
  key: Uint8Array,
  options?: SwarmDownloadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<void> {
  for (const fork of node.forks.values()) {
    if (!fork.node.selfAddress) {
      throw new FolderError('Mantaray fork has no selfAddress — manifest is corrupt');
    }

    const loaded = await unmarshalNode(swarmClient, new Reference(fork.node.selfAddress), key, options, requestOptions);
    fork.node.targetAddress = loaded.targetAddress;
    fork.node.forks = loaded.forks;
    fork.node.path = fork.prefix;
    fork.node.parent = node;

    await loadForks(swarmClient, fork.node, key, options, requestOptions);
  }
}

/**
 * Marshal each node, seal it under `key`, and upload it **unencrypted** at the Swarm level.
 *
 * Native encryption is deliberately not used here. Mantaray stores one reference length per node
 * and applies it to the entry *and* every fork, while fm-lib's entries are 32-byte topics; a
 * natively encrypted manifest would mix a 32-byte entry with 64-byte fork addresses, and any node
 * carrying both — one entry name being a prefix of another, `report` beside `report.pdf` — would
 * be written successfully and fail to parse on the way back. Sealing the bytes ourselves keeps
 * every reference 32 bytes and puts the key under our control rather than inside the reference.
 */
async function saveMantarayRecursively(
  swarmClient: SwarmClient,
  node: MantarayNode,
  batchId: string,
  key: Uint8Array,
  options?: SwarmUploadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<Reference> {
  for (const fork of node.forks.values()) {
    await saveMantarayRecursively(swarmClient, fork.node, batchId, key, options, requestOptions);
  }

  const sealed = await sealWithKey(key, await node.marshal());
  const { reference } = await swarmClient.uploadData(batchId, sealed, options, requestOptions);
  const saved = new Reference(reference);
  node.selfAddress = saved.toUint8Array();

  return saved;
}

export function wrappedKeysMetadata(wrapped: WrappedKeys): Record<string, string> {
  return {
    [MANIFEST_METADATA_WRAPPED_META_KEY]: wrapped.meta,
    [MANIFEST_METADATA_WRAPPED_CONTENT_KEY]: wrapped.content,
  };
}

export function wrappedKeysFromMetadata(meta: Record<string, string>): WrappedKeys {
  const wrapped = {
    meta: meta[MANIFEST_METADATA_WRAPPED_META_KEY],
    content: meta[MANIFEST_METADATA_WRAPPED_CONTENT_KEY],
  };
  if (!wrapped.meta || !wrapped.content) {
    throw new KeyringError('Fork carries no wrapped keys — it was written by an incompatible version');
  }

  return wrapped;
}

export function getAllNodeEntries(root: MantarayNode): NodeHeader[] {
  const nodes = root.collect();

  return nodes
    .map((node): NodeHeader | null => {
      const meta = node.metadata ?? {};
      const nodeType = meta[MANIFEST_METADATA_NODE_TYPE] as NodeType | undefined;
      const nodeTopic = meta[MANIFEST_METADATA_NODE_TOPIC];

      if (!nodeTopic || !nodeType) return null;

      return {
        path: node.fullPathString,
        type: nodeType,
        topic: nodeTopic,
        owner: meta[MANIFEST_METADATA_NODE_OWNER],
        version: meta[MANIFEST_METADATA_NODE_VERSION],
        rawMetadata: { ...meta },
      };
    })
    .filter((e): e is NodeHeader => e !== null);
}

/**
 * Save the manifest tree under `key`, then seal its root reference into the host's feed.
 *
 * The root reference goes into the feed slot directly. It is 32 bytes, so nothing is gained by
 * uploading it as its own blob first, and a manifest read would then cost an extra round trip on
 * every node a listing walks.
 */
export async function saveNodeManifest(
  swarmClient: SwarmClient,
  identity: Identity,
  node: MantarayNode,
  host: ManifestHost,
  key: Uint8Array,
  index?: bigint,
  requestOptions?: BeeRequestOptions,
): Promise<FeedWriteResult> {
  const rootReference = await saveMantarayRecursively(swarmClient, node, host.batchId, key, undefined, requestOptions);

  return writeSealedRefFeed(
    swarmClient,
    identity,
    rootReference,
    key,
    {
      batchId: host.batchId,
      topic: host.topic,
      redundancyLevel: host.redundancyLevel,
      index,
    },
    requestOptions,
  );
}

export function fileForkMetadata(record: FileRecord, wrapped: WrappedKeys): Record<string, string> {
  return {
    [MANIFEST_METADATA_NODE_TOPIC]: record.topic,
    [MANIFEST_METADATA_NODE_TYPE]: NodeType.File,
    [MANIFEST_METADATA_NODE_OWNER]: record.owner,
    ...wrappedKeysMetadata(wrapped),
    ...(record.version !== undefined ? { [MANIFEST_METADATA_NODE_VERSION]: record.version } : {}),
  };
}

export function folderForkMetadata(folder: FolderInfo, wrapped: WrappedKeys): Record<string, string> {
  return {
    [MANIFEST_METADATA_NODE_TOPIC]: folder.topic,
    [MANIFEST_METADATA_NODE_TYPE]: NodeType.Folder,
    [MANIFEST_METADATA_REDUNDANCY_LEVEL]: folder.redundancyLevel.toString(),
    [MANIFEST_METADATA_NODE_OWNER]: folder.owner,
    ...wrappedKeysMetadata(wrapped),
  };
}

export function folderInfoFromMetadata(
  meta: Record<string, string>,
  drive: DriveInfo,
  path: string,
  fallbackOwner: string,
): FolderInfo {
  return {
    type: NodeType.Folder,
    topic: meta[MANIFEST_METADATA_NODE_TOPIC],
    owner: meta[MANIFEST_METADATA_NODE_OWNER] ?? fallbackOwner,
    batchId: drive.batchId,
    redundancyLevel: getRlevel(meta, drive.redundancyLevel),
    path,
    driveId: drive.id,
    status: getRecordStatus(path),
    ...(meta[MANIFEST_METADATA_TRASHED_FROM] ? { trashedFrom: meta[MANIFEST_METADATA_TRASHED_FROM] } : {}),
  };
}

export function driveForkMetadata(drive: DriveInfo, wrapped: WrappedKeys): Record<string, string> {
  return {
    [MANIFEST_METADATA_NODE_TOPIC]: drive.topic,
    [MANIFEST_METADATA_NODE_TYPE]: NodeType.Drive,
    [MANIFEST_METADATA_DRIVE_ID]: drive.id,
    [MANIFEST_METADATA_DRIVE_NAME]: drive.name,
    [MANIFEST_METADATA_DRIVE_OWNER]: drive.owner,
    [MANIFEST_METADATA_DRIVE_KIND]: drive.kind,
    [MANIFEST_METADATA_DRIVE_BATCH_ID]: drive.batchId,
    [MANIFEST_METADATA_REDUNDANCY_LEVEL]: drive.redundancyLevel.toString(),
    ...wrappedKeysMetadata(wrapped),
  };
}

export function controlForkMetadata(node: ControlNode, wrapped: WrappedKeys): Record<string, string> {
  return {
    [MANIFEST_METADATA_NODE_TOPIC]: node.topic,
    [MANIFEST_METADATA_NODE_TYPE]: NodeType.Control,
    [MANIFEST_METADATA_NODE_OWNER]: node.owner,
    [MANIFEST_METADATA_REDUNDANCY_LEVEL]: node.redundancyLevel.toString(),
    ...wrappedKeysMetadata(wrapped),
  };
}

export function getDriveForkPath(driveId: string): string {
  return `${DRIVE_FORK_PREFIX}-${driveId}`;
}

export function getRlevel(meta: Record<string, string>, cachedRlevel: RedundancyLevel): RedundancyLevel {
  const raw = meta[MANIFEST_METADATA_REDUNDANCY_LEVEL];
  if (!raw) {
    return cachedRlevel;
  }

  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < RedundancyLevel.OFF || parsed > RedundancyLevel.PARANOID) {
    return cachedRlevel;
  }

  return parsed as RedundancyLevel;
}
