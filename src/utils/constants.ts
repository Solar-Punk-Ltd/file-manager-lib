import { FeedIndex, NULL_ADDRESS, Reference, Topic } from '@ethersphere/bee-js';

export const FILEMANAGER_STATE_TOPIC = Topic.fromString('filemanager-state');
export const SHARED_INBOX_TOPIC = Topic.fromString('shared-inbox');
export const SHARED_WITH_ME_TOPIC = 'shared-with-me';
export const ADMIN_STAMP_LABEL = 'admin';
export const SWARM_ZERO_ADDRESS = new Reference(NULL_ADDRESS);
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n);
export const ROOT_PATH = '/';
// Mantaray fork metadata keys for per-file granular versioning and sharing
export const MANIFEST_METADATA_CONTENT_REF = 'swarm-content-ref';
export const MANIFEST_METADATA_CONTENT_VERSION = 'swarm-content-version';
export const MANIFEST_METADATA_RECORD_VERSION = 'swarm-record-version';
export const MANIFEST_METADATA_PATH = 'swarm-path';
export const MANIFEST_METADATA_FILE_TOPIC = 'swarm-file-topic';
export const MANIFEST_METADATA_ROOT_FEED_TOPIC = 'swarm-root-feed-topic';
export const MANIFEST_METADATA_GRANTEELIST_REF = 'swarm-grantee-list-ref';
export const MANIFEST_METADATA_ACT_HISTORY_REF = 'swarm-act-history-ref';
export const MANIFEST_METADATA_NODE_TOPIC = 'swarm-node-topic';
export const MANIFEST_METADATA_NODE_TYPE = 'swarm-node-type';
export const MANIFEST_METADATA_REDUNDANCY_LEVEL = 'swarm-redundancy-level';
