import { RedundancyLevel } from '@ethersphere/bee-js';

import { ActReferences } from './utils';

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
}

export interface FileRecord extends NodeResource {
  driveId: string;
  path: string;
  content: ActReferences;
  version?: string;
  timestamp?: number;
  shared?: boolean;
  status?: FileStatus;
  customMetadata?: Record<string, string>;
  granteeListRef?: string;
}

export interface ManifestHost extends NodeResource {
  manifestRef?: ActReferences;
}

export interface DriveInfo extends ManifestHost {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface FolderInfo extends ManifestHost {
  path: string;
  driveId: string;
}

export interface ShareItem {
  fileInfo: FileRecord;
  timestamp?: number;
  message?: string;
}

export interface StateTopicInfo {
  topicReference: string;
  historyAddress: string;
}
