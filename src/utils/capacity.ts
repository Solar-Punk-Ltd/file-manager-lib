import { BatchId, FeedIndex, PrivateKey, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import { DriveInfo, FileInfo } from '../types';
import { ReferenceWithHistory, WrappedFileInfoFeed } from '../types/utils';

import { SWARM_ZERO_ADDRESS } from './constants';

const REFERENCE_WRAPPER_SIZE = new TextEncoder().encode(
  JSON.stringify({
    reference: SWARM_ZERO_ADDRESS.toString(),
    historyRef: SWARM_ZERO_ADDRESS.toString(),
  } as ReferenceWithHistory),
).length;
const INFOFEED_WRAPPER_SIZE = new TextEncoder().encode(
  JSON.stringify({
    topic: SWARM_ZERO_ADDRESS.toString(),
    eGranteeRef: SWARM_ZERO_ADDRESS.toString(),
  } as WrappedFileInfoFeed),
).length;
const FEED_OVERHEAD_SIZE = FeedIndex.MINUS_ONE.toString().length + Topic.LENGTH;
const DUMMY_SIGNER = new PrivateKey('634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd');
const DUMMY_STAMP = new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51');
// Estimate overhead for ACT: circa 250 bytes per history entry (storageRefSize, historyRefSize, eGranteeRef, keypairs etc.)
const ACT_OVERHEAD_SIZE = 250;
// shall be about 304 bytes with an upper limit of 40 on the name length
const dummyId = SWARM_ZERO_ADDRESS;
const dummyDriveInfo: DriveInfo = {
  id: dummyId.toString(),
  name: 'a'.repeat(40),
  batchId: DUMMY_STAMP.toString(),
  owner: DUMMY_SIGNER.publicKey().address().toString(),
  redundancyLevel: RedundancyLevel.OFF,
  infoFeedList: [],
  isAdmin: true,
};
const dummyDriveInfoSize = new TextEncoder().encode(JSON.stringify(dummyDriveInfo)).length;
const dummyFileInfo: FileInfo = {
  batchId: DUMMY_STAMP.toString(),
  file: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
  name: 'a'.repeat(40),
  owner: DUMMY_SIGNER.publicKey().address().toString(),
  actPublisher: DUMMY_SIGNER.publicKey().toString(),
  topic: SWARM_ZERO_ADDRESS.toString(),
  driveId: dummyId.toString(),
};
const dummyFileInfoSize = new TextEncoder().encode(JSON.stringify(dummyFileInfo)).length;

// TODO: extend these if ACT trie expands
/**
 * Estimates the total metadata size for saving the drive list.
 *
 * @param drives - Number of DriveInfo objects in the list
 * @returns Estimated size in bytes accounted for the json representaion
 */
export function estimateDriveListMetadataSize(drives: DriveInfo[]): number {
  if (drives.length === 0) {
    return 0;
  }

  const totalInfoFeedItems = drives.reduce((acc, d) => acc + (d.infoFeedList?.length ?? 0), 0);
  const estimatedDriveListSize =
    drives.length * dummyDriveInfoSize + totalInfoFeedItems * INFOFEED_WRAPPER_SIZE + drives.length + 1;
  return estimatedDriveListSize + ACT_OVERHEAD_SIZE + REFERENCE_WRAPPER_SIZE + FEED_OVERHEAD_SIZE;
}

/**
 * Estimates the total metadata size for saving a single FileInfo.
 *
 * @returns Estimated size in bytes  accounted for the json representaion
 */
export function estimateFileInfoMetadataSize(): number {
  return dummyFileInfoSize + ACT_OVERHEAD_SIZE + REFERENCE_WRAPPER_SIZE + FEED_OVERHEAD_SIZE;
}
