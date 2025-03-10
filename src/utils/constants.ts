import { NULL_ADDRESS, Reference, Topic } from '@upcoming/bee-js';

export const REFERENCE_LIST_TOPIC = Topic.fromString('reference-list');
export const SHARED_INBOX_TOPIC = Topic.fromString('shared-inbox');
export const SHARED_WITH_ME_TOPIC = 'shared-with-me';
export const OWNER_FEED_STAMP_LABEL = 'owner-stamp';
export const ROOT_PATH = '/';
export const SWARM_ZERO_ADDRESS = new Reference(NULL_ADDRESS);

export const FILE_MANAGER_EVENTS = {
  FILE_UPLOADED: 'file-uploaded',
  SHARE_MESSAGE_SENT: 'file-shared',
  FILE_INFO_LIST_INITIALIZED: 'file-info-list-initialized',
};
