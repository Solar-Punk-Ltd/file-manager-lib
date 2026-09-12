import type { NodeType } from './info';
import type { ActReferences, Hex } from './utils';

export const SHARE_FORMAT_VERSION = 1;

export enum ShareGrade {
  /** `K_meta` — recursive listing of a folder or drive. No file contents. */
  List = 'list',
  /** `K_meta` + `K_content` — full read of a subtree, tracking future changes. */
  Read = 'read',
  /** `K_content` — one file, tracking future versions. */
  Open = 'open',
}

/** A node's share state, derived from the share index and never persisted on a record. */
export enum ShareState {
  None = 'none',
  Direct = 'direct',
  /** An ancestor is shared: a `K_meta` grant reaches every descendant. */
  Inherited = 'inherited',
}

export interface GrantBlob {
  v: number;
  owner: Hex;
  topic: string;
  type: NodeType;
  name: string;
  meta?: Hex; // `K_meta`
  content?: Hex; // `K_content`
  message?: string;
}

export interface ShareFeedHead extends ActReferences {
  v: number;
  publisher: Hex;
  grade: ShareGrade;
}

export interface ShareHandle {
  shareTopic: string;
  owner: Hex;
}

export interface ShareOptions {
  /** Rides inside the grant blob, so it is readable only by the grantee list. */
  message?: string;
}

export interface ShareAmendment {
  add?: Hex[];
  remove?: Hex[];
}

export interface ShareFilter {
  driveId?: string;
  nodeTopic?: string;
  /** Revoked grants are excluded by default. */
  includeRevoked?: boolean;
}

export interface ShareEntry {
  id: string;
  shareTopic: string;
  nodeTopic: string;
  driveId: string;
  type: NodeType;
  path: string;
  grade: ShareGrade;
  granteeList: ActReferences;
  act: ActReferences;
  publisher: Hex;
  createdAt: number;
  revokedAt?: number;
}
