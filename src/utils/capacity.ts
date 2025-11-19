import { FeedIndex, PostageBatch, Topic } from '@ethersphere/bee-js';
import { DriveInfo } from './types';

export interface CapacityCheckResult {
  canCreate: boolean;
  requiredBytes: number;
  availableBytes: number;
  message?: string;
}

// Mock mode for testing - simulates admin drive full scenario
let mockAdminDriveFull = false;

export function setMockAdminDriveFull(isFull: boolean): void {
  mockAdminDriveFull = isFull;
  console.warn(`[FileManager Mock] Admin drive full simulation: ${isFull ? 'ENABLED' : 'DISABLED'}`);
}

export function isMockAdminDriveFull(): boolean {
  return mockAdminDriveFull;
}

export function estimateDriveListMetadataSize(
  driveList: DriveInfo[],
  driveCount: number,
  nextIndex: bigint,
  stateFeedTopic?: Topic,
): number {
  const currentDriveListJson = JSON.stringify(driveList);
  const currentDriveListSize = new TextEncoder().encode(currentDriveListJson).length;

  let estimatedDriveListSize: number;
  if (driveList.length > 0 && driveCount > driveList.length) {
    const avgDriveSize = currentDriveListSize / driveList.length;
    estimatedDriveListSize = Math.ceil(avgDriveSize * driveCount);
  } else if (driveCount === 0) {
    estimatedDriveListSize = new TextEncoder().encode('[]').length;
  } else {
    estimatedDriveListSize = currentDriveListSize;
  }

  const actOverhead = Math.ceil(estimatedDriveListSize * 0.2);

  const sampleReferenceWrapper = JSON.stringify({
    reference: '0'.repeat(64),
    historyRef: '0'.repeat(64),
  });
  const referenceWrapperSize = new TextEncoder().encode(sampleReferenceWrapper).length;

  const sampleFeedIndex = FeedIndex.fromBigInt(nextIndex);
  const feedIndexSize = new TextEncoder().encode(sampleFeedIndex.toString()).length;
  const topicSize = stateFeedTopic ? stateFeedTopic.toUint8Array().length : 32; // Topics are 32 bytes
  const feedOverhead = feedIndexSize + topicSize;

  const totalBeforeMargin = estimatedDriveListSize + actOverhead + referenceWrapperSize + feedOverhead;
  const safetyMargin = Math.ceil(totalBeforeMargin * 0.15);

  return totalBeforeMargin + safetyMargin;
}

export function checkDriveCreationCapacity(
  adminStamp: PostageBatch | undefined,
  driveList: DriveInfo[],
  nextIndex: bigint,
  stateFeedTopic?: Topic,
): CapacityCheckResult {
  // Mock mode - simulate admin drive full
  if (mockAdminDriveFull) {
    const mockRequiredBytes = 50000;
    const mockAvailableBytes = 10000; // Intentionally less than required
    console.warn('[FileManager Mock] Simulating FULL admin drive');
    return {
      canCreate: false,
      requiredBytes: mockRequiredBytes,
      availableBytes: mockAvailableBytes,
      message: `Insufficient capacity. Required: ~${mockRequiredBytes} bytes, Available: ${mockAvailableBytes} bytes`,
    };
  }

  if (!adminStamp) {
    return {
      canCreate: false,
      requiredBytes: 0,
      availableBytes: 0,
      message: 'Admin stamp not found',
    };
  }

  if (!adminStamp.usable) {
    return {
      canCreate: false,
      requiredBytes: 0,
      availableBytes: 0,
      message: 'Admin stamp is not usable',
    };
  }

  const requiredBytes = estimateDriveListMetadataSize(driveList, driveList.length + 1, nextIndex, stateFeedTopic);
  const availableBytes = adminStamp.remainingSize.toBytes();

  if (availableBytes < requiredBytes) {
    return {
      canCreate: false,
      requiredBytes,
      availableBytes,
      message: `Insufficient capacity. Required: ~${requiredBytes} bytes, Available: ${availableBytes} bytes`,
    };
  }

  return {
    canCreate: true,
    requiredBytes,
    availableBytes,
  };
}
