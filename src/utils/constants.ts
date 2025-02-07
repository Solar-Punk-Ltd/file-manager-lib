import { NULL_ADDRESS, Reference, Topic } from '@upcoming/bee-js';

export const REFERENCE_LIST_TOPIC = new Topic(Topic.fromString('reference-list'));
export const SHARED_INBOX_TOPIC = new Topic(Topic.fromString('shared-inbox'));
export const SHARED_WTIHME_TOPIC = 'shared-with-me';
export const OWNER_FEED_STAMP_LABEL = 'owner-stamp';
export const ROOT_PATH = '/';
export const SWARM_ZERO_ADDRESS = new Reference(NULL_ADDRESS);

// TEMPORARY
export const FILE_INFO_LOCAL_STORAGE = 'data.txt';
