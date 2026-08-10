import { RedundancyLevel } from '@ethersphere/bee-js';

import { ActReferences } from './utils';

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
  // Not persisted: stripped before persist and hydrated. A record belongs to whichever drive's manifest references it
  driveId?: string;
  path: string;
  content: ActReferences;
  timestamp?: number;
  customMetadata?: Record<string, string>;
}

export interface ManifestHost extends NodeResource {
  manifestRef?: ActReferences;
  version?: never;
}

export interface TrashEntry {
  topic: string;
  type: NodeType;
  path: string;
  version?: string;
}

export interface DriveInfo extends ManifestHost {
  type: NodeType.Drive;
  id: string;
  name: string;
  isAdmin: boolean;
  trashedNodes?: TrashEntry[];
}

export interface FolderInfo extends ManifestHost {
  type: NodeType.Folder;
  path: string;
  driveId: string;
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
