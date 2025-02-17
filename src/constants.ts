import { NULL_ADDRESS, Reference } from '@upcoming/bee-js';

export const REFERENCE_LIST_TOPIC = 'reference-list';
export const SHARED_INBOX_TOPIC = 'shared-inbox';
export const SHARED_WTIHME_TOPIC = 'shared-with-me';
export const OWNER_FEED_STAMP_LABEL = 'owner-stamp';
export const ROOT_PATH = '/';
export const SWARM_ZERO_ADDRESS = new Reference(NULL_ADDRESS);

export const FILE_MANAGER_EVENTS = {
  FILE_UPLOADED: 'file-uploaded',
  SHARE_MESSAGE_SENT: 'file-shared',
  FILE_INFO_LIST_INITIALIZED: 'file-info-list-initialized',
};

// TEMPORARY
export const FILE_INFO_LOCAL_STORAGE = 'data.txt';
