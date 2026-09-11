import { type RedundancyLevel } from '@ethersphere/bee-js';
import { type BatchId, type MantarayNode } from '@ethersphere/core-sdk';

import { type ContentRef, type Hex } from './utils';

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
  version?: string;
  status?: NodeStatus;
}

export interface FileRecord extends NodeResource {
  type: NodeType.File;
  driveId?: string;
  name: string;
  // On a record loaded straight off its feed this falls back to `name` until a listing hydrates it.
  path: string;
  content: ContentRef;
  timestamp?: number;
  customMetadata?: Record<string, string>;
  trashedFrom?: string;
}

export interface ManifestHost extends NodeResource {
  manifestRef?: ContentRef;
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

export enum FailureScope {
  Entry = 'entry',
  Subtree = 'subtree',
}

export interface NodeFailure {
  path: string;
  scope: FailureScope;
  error: string;
  type?: NodeType;
  topic?: string;
}

export interface ListFolderResult {
  entries: NodeEntry[];
  failed: NodeFailure[];
}

export interface UnresolvedDrive {
  id: string;
  name: string;
  error: string;
}

export interface NodeHeader {
  path: string;
  type: NodeType;
  topic: string;
  owner?: string;
  version?: string;
  head?: ContentRef;
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

export interface StampInfo {
  batchId: Hex;
  usable: boolean;
  depth: number;
}

export interface CreateDriveParams {
  name: string;
  batchId: string | BatchId;
  redundancyLevel?: RedundancyLevel;
}
