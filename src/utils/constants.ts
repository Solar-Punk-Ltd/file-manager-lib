import { NULL_ADDRESS } from '@ethersphere/bee-js';
import { FeedIndex, Reference } from '@ethersphere/core-sdk';

import { FEED_INDEX_NOT_FOUND } from '../types/utils';

export const STATE_TOPIC_LABEL = 'filemanager-state/v2';
export const ADMIN_DRIVE_NAME = 'admin';
export const SWARM_ZERO_ADDRESS = new Reference(NULL_ADDRESS);
// --- Feed indexes ---
//
// Two representations of the same two values, because the layers speak different languages:
// the `SwarmClient` port uses decimal strings (`FEED_INDEX_START`, `FEED_INDEX_NOT_FOUND` in
// `types/utils.ts`), while the domain layer compares `FeedIndex` objects. The pair below is the
// domain-side form. Do not stringify them for the port — `FeedIndex.toString()` emits 16-char
// **hex**, not decimal, and the mismatch is silent because `BigInt('0000000000000000')` is still 0.

/** The first writable slot. `.toString()` gives the 16-hex form persisted as a node's `version`. */
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n);
/**
 * "This feed has no update yet" — the domain-side twin of the port's {@link FEED_INDEX_NOT_FOUND},
 * which is what `readFeed` reports for an empty feed. **Derived from that constant, never re-typed**,
 * so the two spellings cannot drift apart.
 */
export const FEED_INDEX_NONE = FeedIndex.fromBigInt(BigInt(FEED_INDEX_NOT_FOUND));
export const ROOT_PATH = '/';
export const TRASH_FOLDER_NAME = '.trash';
export const MAX_CONCURRENT_FEED_FETCHES = 10;
export const MAX_CONCURRENT_UPLOADS = 2;
export const DRIVE_FORK_PREFIX = '/drive';
export const MANIFEST_METADATA_NODE_TOPIC = 'swarm-node-topic';
export const MANIFEST_METADATA_NODE_TYPE = 'swarm-node-type';
export const MANIFEST_METADATA_REDUNDANCY_LEVEL = 'swarm-redundancy-level';
export const MANIFEST_METADATA_NODE_OWNER = 'swarm-node-owner';
export const MANIFEST_METADATA_NODE_ACT_PUBLISHER = 'swarm-node-act-publisher';
export const MANIFEST_METADATA_NODE_VERSION = 'swarm-node-version';
export const MANIFEST_METADATA_TRASHED_FROM = 'swarm-trashed-from';
export const MANIFEST_METADATA_DRIVE_ID = 'swarm-drive-id';
export const MANIFEST_METADATA_DRIVE_NAME = 'swarm-drive-name';
export const MANIFEST_METADATA_DRIVE_OWNER = 'swarm-drive-owner';
export const MANIFEST_METADATA_DRIVE_IS_ADMIN = 'swarm-drive-is-admin';
export const MANIFEST_METADATA_DRIVE_BATCH_ID = 'swarm-drive-batch-id';
export const MANIFEST_METADATA_DRIVE_ACT_PUBLISHER = 'swarm-drive-act-publisher';
