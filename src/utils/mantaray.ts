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
import type { BulletinHandle } from '../types/share';
import type { SwarmClient } from '../types/swarmClient';
import type { FeedWriteResult, SwarmDownloadOptions, SwarmRequestOptions, SwarmUploadOptions } from '../types/utils';

import { writeSealedRefFeed } from './bee';
import { getRecordStatus } from './common';
import {
  DRIVE_FORK_PREFIX,
  MANIFEST_METADATA_BULLETIN_OWNER,
  MANIFEST_METADATA_BULLETIN_TOPIC,
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
  MANIFEST_METADATA_SHARE_TOPIC,
  MANIFEST_METADATA_TRASHED_FROM,
  MANIFEST_METADATA_WRAPPED_CONTENT_KEY,
  MANIFEST_METADATA_WRAPPED_META_KEY,
} from './constants';
import { decryptBytes, encryptBytes } from './crypto';
import { FolderError, KeyringError } from './errors';
import { splitPath } from './path';

export async function loadMantaray(
  swarmClient: SwarmClient,
  mantarayRef: string | Reference,
  key: CryptoKey,
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
  key: CryptoKey,
  options?: SwarmDownloadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<MantarayNode> {
  const sealed = await swarmClient.downloadData(reference.toString(), options, requestOptions);
  const data = await decryptBytes(key, sealed);

  return MantarayNode.unmarshalFromData(data, reference.toUint8Array());
}

async function loadForks(
  swarmClient: SwarmClient,
  node: MantarayNode,
  key: CryptoKey,
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

async function saveMantarayRecursively(
  swarmClient: SwarmClient,
  node: MantarayNode,
  batchId: string,
  key: CryptoKey,
  options?: SwarmUploadOptions,
  requestOptions?: SwarmRequestOptions,
): Promise<Reference> {
  for (const fork of node.forks.values()) {
    await saveMantarayRecursively(swarmClient, fork.node, batchId, key, options, requestOptions);
  }

  const sealed = await encryptBytes(key, await node.marshal());
  const { reference } = await swarmClient.uploadData(batchId, sealed, options, requestOptions);
  const saved = new Reference(reference);
  node.selfAddress = saved.toUint8Array();

  return saved;
}

export function wrappedKeysMetadata(wrapped: WrappedKeys): Record<string, string> {
  return {
    [MANIFEST_METADATA_WRAPPED_META_KEY]: wrapped.meta,
    ...(wrapped.content ? { [MANIFEST_METADATA_WRAPPED_CONTENT_KEY]: wrapped.content } : {}),
  };
}

export function wrappedKeysFromMetadata(meta: Record<string, string>): WrappedKeys {
  const wrappedMeta = meta[MANIFEST_METADATA_WRAPPED_META_KEY];
  if (!wrappedMeta) {
    throw new KeyringError('Fork carries no wrapped keys — it was written by an incompatible version');
  }

  const wrappedContent = meta[MANIFEST_METADATA_WRAPPED_CONTENT_KEY];

  return { meta: wrappedMeta, ...(wrappedContent ? { content: wrappedContent } : {}) };
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

export async function saveNodeManifest(
  swarmClient: SwarmClient,
  identity: Identity,
  node: MantarayNode,
  host: ManifestHost,
  key: CryptoKey,
  epoch: number,
  index?: bigint,
  requestOptions?: BeeRequestOptions,
): Promise<FeedWriteResult> {
  const rootReference = await saveMantarayRecursively(swarmClient, node, host.batchId, key, undefined, requestOptions);

  return writeSealedRefFeed(
    swarmClient,
    identity,
    rootReference,
    key,
    epoch,
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

export function listedRecordFromMetadata(
  meta: Record<string, string>,
  drive: DriveInfo,
  path: string,
  fallbackOwner: string,
): FileRecord {
  return {
    type: NodeType.File,
    topic: meta[MANIFEST_METADATA_NODE_TOPIC],
    owner: meta[MANIFEST_METADATA_NODE_OWNER] ?? fallbackOwner,
    batchId: drive.batchId,
    redundancyLevel: getRlevel(meta, drive.redundancyLevel),
    name: splitPath(path).name,
    path,
    driveId: drive.id,
    status: getRecordStatus(path),
    ...(meta[MANIFEST_METADATA_NODE_VERSION] ? { version: meta[MANIFEST_METADATA_NODE_VERSION] } : {}),
    ...(meta[MANIFEST_METADATA_TRASHED_FROM] ? { trashedFrom: meta[MANIFEST_METADATA_TRASHED_FROM] } : {}),
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

export function mountForkMetadata(
  mount: {
    topic: string;
    type: NodeType;
    owner: string;
    shareTopic: string;
    bulletin: BulletinHandle;
    redundancyLevel: RedundancyLevel;
  },
  wrapped: WrappedKeys,
): Record<string, string> {
  return {
    [MANIFEST_METADATA_NODE_TOPIC]: mount.topic,
    [MANIFEST_METADATA_NODE_TYPE]: mount.type,
    [MANIFEST_METADATA_NODE_OWNER]: mount.owner,
    [MANIFEST_METADATA_REDUNDANCY_LEVEL]: mount.redundancyLevel.toString(),
    // Kept so a mount can find its grant's share feed again. Private to the recipient's own manifest.
    [MANIFEST_METADATA_SHARE_TOPIC]: mount.shareTopic,
    [MANIFEST_METADATA_BULLETIN_TOPIC]: mount.bulletin.topic,
    [MANIFEST_METADATA_BULLETIN_OWNER]: mount.bulletin.owner,
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

export function freeMountName(sharedNode: MantarayNode, name: string): string {
  if (!sharedNode.find(name)) {
    return name;
  }

  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!sharedNode.find(candidate)) {
      return candidate;
    }
  }
}
