import { RedundancyLevel } from '@ethersphere/bee-js';

import { ActReferences } from './utils';
// TODO: rename to NodeStatus during merge
export enum FileStatus {
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
  status?: FileStatus;
}

export interface FileRecord extends NodeResource {
  type: NodeType.File;
  driveId: string;
  path: string;
  content: ActReferences;
  timestamp?: number;
  shared?: boolean;
  customMetadata?: Record<string, string>;
  granteeListRef?: string;
}

export interface ManifestHost extends NodeResource {
  manifestRef?: ActReferences;
  /**
   *  Unlike files, containers (folders, drives) are not content-versioned.
   * Omitted so `NODE_VERSION` is never written for or read from folders/drives.
   */
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

export interface ShareItem {
  record: FileRecord;
  timestamp?: number;
  message?: string;
}
