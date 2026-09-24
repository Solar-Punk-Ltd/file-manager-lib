import type { NodeType } from './info';
import type { ActReferences, Hex } from './utils';

export enum ShareGrade {
  /** `K_meta` — recursive listing of a folder. No file contents. */
  List = 'list',
  /** `K_meta` + `K_content` — full read of a subtree, tracking future changes. */
  Read = 'read',
  /** `K_content` — one file, tracking future versions. */
  Open = 'open',
}

export interface GrantBlob {
  v: number;
  owner: Hex;
  topic: string;
  type: NodeType;
  name: string;
  grade: ShareGrade;
  meta?: Hex; // `K_meta`
  content?: Hex; // `K_content`
  /** The generation of the keys above. Every earlier one derives from them, no later one does. */
  gen: number;
  message?: string;
}

/** Published in the clear on a share feed: an ACT address, useless outside its grantee list. */
export interface ShareFeedHead extends ActReferences {
  v: number;
  publisher: Hex;
}

export interface ShareHandle {
  shareTopic: string;
  /** The sharer's `identity.owner` — the address signing the share feed, not the ACT publisher. */
  owner: Hex;
}

export interface ShareOptions {
  /** Rides inside the grant blob, so it is readable only by the grantee list. */
  message?: string;
}

export interface ShareSubject {
  topic: string;
  type: NodeType;
  name: string;
  owner: Hex;
  path: string;
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
  /** ACT key of whoever encrypted this blob, kept because amending never re-encrypts it. */
  publisher: Hex;
  /** The node's key generation the current blob carries. Behind the node's, the grant is due a re-issue. */
  gen: number;
  createdAt: number;
  revokedAt?: number;
  /** Membership as of the last write, so a re-issue needs no ACT read. */
  grantees: Hex[];
  /** The grant's message, carried into every re-issue of its blob. */
  message?: string;
}

export interface MalformedShare {
  index: number;
  id?: string;
  error: string;
  entry: unknown;
}
