import { FeedIndex, NULL_ADDRESS, Reference, Topic } from '@ethersphere/bee-js';

export const REFERENCE_LIST_TOPIC = Topic.fromString('reference-list');
export const SHARED_INBOX_TOPIC = Topic.fromString('shared-inbox');
export const SHARED_WITH_ME_TOPIC = 'shared-with-me';
export const OWNER_STAMP_LABEL = 'owner';
export const ROOT_PATH = '/';
export const SWARM_ZERO_ADDRESS = new Reference(NULL_ADDRESS);
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n);
