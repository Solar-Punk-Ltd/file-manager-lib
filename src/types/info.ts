import { type RedundancyLevel } from '@ethersphere/bee-js';
import { type BatchId, type MantarayNode } from '@ethersphere/core-sdk';

import { type ShareEntry } from './share';
import { type ContentRef, type Hex } from './utils';

export enum NodeStatus {
  Active = 'active',
  Trashed = 'trashed',
}

export enum NodeType {
  File = 'file',
  Folder = 'folder',
  Drive = 'drive',
  /** A control-plane document in the admin manifest: the share index, the address book. */
  Control = 'control',
}

export enum DriveKind {
  /** The admin drive — the drive registry and the control-plane nodes. */
  Admin = 'admin',
  /** Regular user drive */
  User = 'user',
  /**
   * The inbound-share drive. Owned and written by this identity, but every node in it is a mount
   * point onto someone else's subtree, so the drive itself is read-only and kept out of `driveList`.
   */
  Shared = 'shared',
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
  /**
   * Pointer to the bytes. Absent on a file listed through a `list` grant, which carries the
   * structure of a subtree and no key to any file in it
   */
  content?: ContentRef;
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
  kind: DriveKind;
}

/** A document node in the admin manifest: no manifest of its own, one JSON payload on its own feed. */
export interface ControlNode extends NodeResource {
  type: NodeType.Control;
  name: string;
}

export type ControlDocument = ShareEntry[];

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
