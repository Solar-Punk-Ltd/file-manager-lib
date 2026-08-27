import { type BeeRequestOptions, RedundancyLevel } from '@ethersphere/bee-js';
import { MantarayNode, Reference } from '@ethersphere/core-sdk';

import {
  type DriveInfo,
  type FileRecord,
  type FolderInfo,
  type ManifestHost,
  type NodeHeader,
  NodeType,
} from '../types/info';
import type { SwarmClient } from '../types/swarmClient';
import type { SwarmDownloadOptions, SwarmRequestOptions, SwarmUploadOptions } from '../types/utils';

import { type FeedWriteResult, writeActFeed } from './bee';
import { getRecordStatus } from './common';
import {
  DRIVE_FORK_PREFIX,
  MANIFEST_METADATA_DRIVE_ACT_PUBLISHER,
  MANIFEST_METADATA_DRIVE_BATCH_ID,
  MANIFEST_METADATA_DRIVE_ID,
  MANIFEST_METADATA_DRIVE_IS_ADMIN,
  MANIFEST_METADATA_DRIVE_NAME,
  MANIFEST_METADATA_DRIVE_OWNER,
  MANIFEST_METADATA_NODE_ACT_PUBLISHER,
  MANIFEST_METADATA_NODE_OWNER,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_NODE_VERSION,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  MANIFEST_METADATA_TRASHED_FROM,
} from './constants';
import { FolderError } from './errors';

export async function loadMantaray(
  swarmClient: SwarmClient,
  mantarayRef: string | Reference,
  options?: SwarmDownloadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<MantarayNode> {
  const root = await unmarshalNode(swarmClient, new Reference(mantarayRef), options, requestOptions);
  await loadForks(swarmClient, root, options, requestOptions);

  return root;
}

async function unmarshalNode(
  swarmClient: SwarmClient,
  reference: Reference,
  options?: SwarmDownloadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<MantarayNode> {
  const data = await swarmClient.downloadData(reference.toString(), options, requestOptions);

  return MantarayNode.unmarshalFromData(data, reference.toUint8Array());
}

async function loadForks(
  swarmClient: SwarmClient,
  node: MantarayNode,
  options?: SwarmDownloadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<void> {
  for (const fork of node.forks.values()) {
    if (!fork.node.selfAddress) {
      throw new FolderError('Mantaray fork has no selfAddress — manifest is corrupt');
    }

    const loaded = await unmarshalNode(swarmClient, new Reference(fork.node.selfAddress), options, requestOptions);
    fork.node.targetAddress = loaded.targetAddress;
    fork.node.forks = loaded.forks;
    fork.node.path = fork.prefix;
    fork.node.parent = node;

    await loadForks(swarmClient, fork.node, options, requestOptions);
  }
}

async function saveMantarayRecursively(
  swarmClient: SwarmClient,
  node: MantarayNode,
  batchId: string,
  options?: SwarmUploadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<Reference> {
  for (const fork of node.forks.values()) {
    await saveMantarayRecursively(swarmClient, fork.node, batchId, options, requestOptions);
  }

  const { reference } = await swarmClient.uploadData(batchId, await node.marshal(), options, requestOptions);
  const saved = new Reference(reference);
  node.selfAddress = saved.toUint8Array();

  return saved;
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
        actPublisher: meta[MANIFEST_METADATA_NODE_ACT_PUBLISHER],
        version: meta[MANIFEST_METADATA_NODE_VERSION],
        rawMetadata: { ...meta },
      };
    })
    .filter((e): e is NodeHeader => e !== null);
}

export async function saveNodeManifest(
  swarmClient: SwarmClient,
  node: MantarayNode,
  host: ManifestHost,
  index?: bigint,
  requestOptions?: BeeRequestOptions,
): Promise<FeedWriteResult> {
  const rootReference = await saveMantarayRecursively(swarmClient, node, host.batchId, undefined, requestOptions);

  return writeActFeed(
    swarmClient,
    rootReference.toUint8Array(),
    {
      batchId: host.batchId,
      topic: host.topic,
      redundancyLevel: host.redundancyLevel,
      actHistoryAddress: host.manifestRef?.historyRef,
      index,
    },
    requestOptions,
  );
}

export function fileForkMetadata(record: FileRecord): Record<string, string> {
  return {
    [MANIFEST_METADATA_NODE_TOPIC]: record.topic,
    [MANIFEST_METADATA_NODE_TYPE]: NodeType.File,
    [MANIFEST_METADATA_NODE_OWNER]: record.owner,
    [MANIFEST_METADATA_NODE_ACT_PUBLISHER]: record.actPublisher,
    ...(record.version !== undefined ? { [MANIFEST_METADATA_NODE_VERSION]: record.version } : {}),
  };
}

export function folderForkMetadata(folder: FolderInfo): Record<string, string> {
  return {
    [MANIFEST_METADATA_NODE_TOPIC]: folder.topic,
    [MANIFEST_METADATA_NODE_TYPE]: NodeType.Folder,
    [MANIFEST_METADATA_REDUNDANCY_LEVEL]: folder.redundancyLevel.toString(),
    [MANIFEST_METADATA_NODE_OWNER]: folder.owner,
    [MANIFEST_METADATA_NODE_ACT_PUBLISHER]: folder.actPublisher,
  };
}

export function folderInfoFromMetadata(
  meta: Record<string, string>,
  drive: DriveInfo,
  path: string,
  fallback: { owner: string; actPublisher: string },
): FolderInfo {
  return {
    type: NodeType.Folder,
    topic: meta[MANIFEST_METADATA_NODE_TOPIC],
    owner: meta[MANIFEST_METADATA_NODE_OWNER] ?? fallback.owner,
    actPublisher: meta[MANIFEST_METADATA_NODE_ACT_PUBLISHER] ?? fallback.actPublisher,
    batchId: drive.batchId,
    redundancyLevel: getRlevel(meta, drive.redundancyLevel),
    path,
    driveId: drive.id,
    status: getRecordStatus(path),
    ...(meta[MANIFEST_METADATA_TRASHED_FROM] ? { trashedFrom: meta[MANIFEST_METADATA_TRASHED_FROM] } : {}),
  };
}

export function driveForkMetadata(drive: DriveInfo): Record<string, string> {
  return {
    [MANIFEST_METADATA_NODE_TOPIC]: drive.topic,
    [MANIFEST_METADATA_NODE_TYPE]: NodeType.Drive,
    [MANIFEST_METADATA_DRIVE_ID]: drive.id,
    [MANIFEST_METADATA_DRIVE_NAME]: drive.name,
    [MANIFEST_METADATA_DRIVE_OWNER]: drive.owner,
    [MANIFEST_METADATA_DRIVE_IS_ADMIN]: String(drive.isAdmin),
    [MANIFEST_METADATA_DRIVE_BATCH_ID]: drive.batchId,
    [MANIFEST_METADATA_DRIVE_ACT_PUBLISHER]: drive.actPublisher,
    [MANIFEST_METADATA_REDUNDANCY_LEVEL]: drive.redundancyLevel.toString(),
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
