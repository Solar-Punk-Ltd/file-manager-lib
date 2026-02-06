import { BeeRequestOptions, FeedIndex, NULL_ADDRESS, Reference, Topic } from '@ethersphere/bee-js';

export const FILEMANAGER_STATE_TOPIC = Topic.fromString('filemanager-state');
export const SHARED_INBOX_TOPIC = Topic.fromString('shared-inbox');
export const SHARED_WITH_ME_TOPIC = 'shared-with-me';
export const ADMIN_STAMP_LABEL = 'admin';
export const SWARM_ZERO_ADDRESS = new Reference(NULL_ADDRESS);
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n);
export const NO_CACHE_BEE_REQUES_OPTIONS: BeeRequestOptions = {
  headers: {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  },
};
