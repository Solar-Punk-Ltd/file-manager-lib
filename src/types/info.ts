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
}
// TODO: consider storing version for better performance
export interface TrashEntry {
  topic: string;
  type: NodeType;
  path: string;
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

/**
 * Lean projection of a manifest fork, produced from fork metadata alone (no feed fetch).
 * {@link FileManager.listFolder} hydrates these into full {@link NodeEntry} objects.
 * `head`/`version`/`owner`/`actPublisher` come from enriched fork metadata and enable a future
 * hydration that skips the feed lookup — the fork head-pointer fast path.
 */
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
