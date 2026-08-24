import { type MantarayNode, type RedundancyLevel } from '@ethersphere/bee-js';

import { type ActReferences } from './utils';

export enum NodeStatus {
  Active = 'active',
  Trashed = 'trashed',
}

export enum NodeType {
  File = 'file',
  Folder = 'folder',
  Drive = 'drive',
}

export enum ListDepth {
  Shallow = 'shallow',
  Deep = 'deep',
}

export interface NodeResource {
  batchId: string;
  topic: string;
  owner: string;
  redundancyLevel: RedundancyLevel;
  actPublisher: string;
  version?: string;
  status?: NodeStatus;
}

export interface FileRecord extends NodeResource {
  type: NodeType.File;
  driveId?: string;
  name: string;
  // On a record loaded straight off its feed this falls back to `name` until a listing hydrates it.
  path: string;
  content: ActReferences;
  timestamp?: number;
  customMetadata?: Record<string, string>;
  trashedFrom?: string;
}

export interface ManifestHost extends NodeResource {
  manifestRef?: ActReferences;
  version?: never;
}

export interface DriveInfo extends ManifestHost {
  type: NodeType.Drive;
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface FolderInfo extends ManifestHost {
  type: NodeType.Folder;
  path: string;
  driveId: string;
  trashedFrom?: string;
}

export type NodeEntry = FileRecord | FolderInfo;

export interface NodeHeader {
  path: string;
  type: NodeType;
  topic: string;
  owner?: string;
  actPublisher?: string;
  version?: string;
  head?: ActReferences;
  rawMetadata: Record<string, string>;
}

export interface ResolvedFileFork {
  host: ManifestHost;
  folder: FolderInfo | null;
  node: MantarayNode;
  filename: string;
  targetAddress: Uint8Array;
  metadata: Record<string, string>;
}
