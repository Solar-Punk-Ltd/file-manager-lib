import {
  BatchId,
  Bee,
  type BeeVersions,
  Bytes,
  Duration,
  EthAddress,
  FeedIndex,
  type FeedReader,
  type FeedWriter,
  Identifier,
  MantarayNode,
  type NodeAddresses,
  type NumberString,
  PeerAddress,
  type PostageBatch,
  PublicKey,
  RedundancyLevel,
  Reference,
  Size,
  Topic,
  type UploadResult,
} from '@ethersphere/bee-js';
import { Optional } from 'cafe-utility';

import { DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { type FileManagerBase } from '@/fileManager';
import { type DriveInfo, type FileRecord, NodeType, type StampInfo } from '@/types';
import { fetchStamp, getFeedData } from '@/utils/bee';
import { ADMIN_DRIVE_NAME, FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from '@/utils/constants';
import { getAllNodeEntries, loadMantaray } from '@/utils/mantaray';

export function createMockMantarayNode(all = true): MantarayNode {
  const mn = new MantarayNode();
  if (all) {
    mn.addFork('/root', new Reference('0'.repeat(64)));
    mn.addFork('/root/1.txt', new Reference('1'.repeat(64)));
    mn.addFork('/root/2.txt', new Reference('2'.repeat(64)));
    mn.addFork('/root/subfolder/3.txt', new Reference('3'.repeat(64)));
  } else {
    mn.addFork('/root/2.txt', new Reference('2'.repeat(64)));
  }

  return mn;
}

export function createMockNodeAddresses(): NodeAddresses {
  return {
    overlay: new PeerAddress('1'.repeat(64)),
    underlay: ['mock-underlay'],
    ethereum: new EthAddress('33'.repeat(20)),
    publicKey: new PublicKey('22'.repeat(64)),
    pssPublicKey: new PublicKey('22'.repeat(64)),
  };
}

export async function createMockFileInfo(
  owner: string,
  actPublisher: string,
  ref: string = SWARM_ZERO_ADDRESS.toString(),
  overrides?: Partial<FileRecord>,
): Promise<FileRecord> {
  return {
    type: NodeType.File,
    batchId: DUMMY_BATCH_ID,
    path: '/john doe',
    topic: Topic.fromString('file-1').toString(),
    driveId: Identifier.fromString('123').toString(),
    owner,
    actPublisher,
    content: {
      reference: ref,
      historyRef: SWARM_ZERO_ADDRESS.toString(),
    },
    redundancyLevel: RedundancyLevel.OFF,
    ...overrides,
  };
}

export function createMockDriveInfo(actPublisher: string, overrides?: Partial<DriveInfo>): DriveInfo {
  return {
    type: NodeType.Drive,
    id: Identifier.fromString('123').toString(),
    batchId: DUMMY_BATCH_ID,
    owner: DEFAULT_MOCK_SIGNER.publicKey().address().toString(),
    name: 'Test Drive',
    topic: Topic.fromString('drive-topic-1').toString(),
    redundancyLevel: RedundancyLevel.MEDIUM,
    manifestRef: {
      reference: new Reference('1'.repeat(64)).toString(),
      historyRef: new Reference('2'.repeat(64)).toString(),
    },
    isAdmin: false,
    actPublisher,
    ...overrides,
  };
}

export function createMockFeedReader(char: string = '1'): FeedReader {
  return {
    owner: new EthAddress(char.repeat(40)),
    download: jest.fn().mockRejectedValue({ payload: new Bytes(char.repeat(64)) }),
    downloadReference: jest.fn().mockRejectedValue({ reference: new Reference(char.repeat(64)) }),
    downloadPayload: jest.fn().mockResolvedValue({ payload: new Bytes(char.repeat(64)) }),
    topic: Topic.fromString(char),
  };
}

export function createMockFeedWriter(char: string = '1'): FeedWriter {
  return {
    upload: jest.fn().mockResolvedValue({
      reference: new Reference(char.repeat(64)),
      historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
    } as UploadResult),
    uploadReference: jest.fn().mockResolvedValue({
      reference: new Reference(char.repeat(64)),
      historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
    } as UploadResult),
    uploadPayload: jest.fn().mockResolvedValue({
      reference: new Reference(char.repeat(64)),
      historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
    } as UploadResult),
    ...createMockFeedReader(char),
  };
}

export function createInitMocks(data?: Reference): any {
  jest
    .spyOn(Bee.prototype, 'getVersions')
    .mockResolvedValue({ beeApiVersion: '0.0.0', beeVersion: '0.0.0' } as BeeVersions);
  jest.spyOn(Bee.prototype, 'isSupportedApiVersion').mockResolvedValue(true);
  jest.spyOn(Bee.prototype, 'getNodeAddresses').mockResolvedValue(createMockNodeAddresses());
  loadStampListMock();
  jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(new Bytes(data || SWARM_ZERO_ADDRESS));
  jest.spyOn(Bee.prototype, 'downloadFile').mockResolvedValue({ data: new Bytes(SWARM_ZERO_ADDRESS) });
  jest.spyOn(Bee.prototype, 'downloadReadableData').mockResolvedValue(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue((data || SWARM_ZERO_ADDRESS).toUint8Array());
        controller.close();
      },
    }),
  );
  jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue({
    reference: data || SWARM_ZERO_ADDRESS,
    historyAddress: Optional.of(data || SWARM_ZERO_ADDRESS),
  } as unknown as UploadResult);
  jest.spyOn(Bee.prototype, 'makeFeedWriter').mockReturnValue(createMockFeedWriter());
  jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(createMockFeedReader());
  jest.spyOn(Bee.prototype, 'getPostageBatches').mockResolvedValue(loadStampListMock());
}

export function createUploadDataSpy(char: string): jest.SpyInstance {
  return jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValueOnce({
    reference: new Reference(char.repeat(64)),
    historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
  });
}

export const mockPostageBatch: PostageBatch = {
  batchID: new BatchId(DUMMY_BATCH_ID),
  utilization: 2,
  usable: true,
  usageText: '2%',
  label: 'one',
  depth: 22,
  amount: '480' as NumberString,
  bucketDepth: 30,
  blockNumber: 980,
  immutableFlag: true,
  duration: Duration.fromDays(3),
  usage: 0,
  size: Size.fromGigabytes(100),
  remainingSize: Size.fromGigabytes(100),
  theoreticalSize: Size.fromGigabytes(100),
  calculateSize: () => Size.fromGigabytes(100),
  calculateRemainingSize: () => Size.fromGigabytes(100),
};

export const mockStampInfo: StampInfo = {
  batchId: mockPostageBatch.batchID.toString(),
  usable: mockPostageBatch.usable,
  depth: mockPostageBatch.depth,
};

export function loadStampListMock(): PostageBatch[] {
  return [
    {
      ...mockPostageBatch,
    },
    {
      batchID: new BatchId('2345'.repeat(16)),
      utilization: 3,
      usable: true,
      usageText: '2%',
      label: 'two',
      depth: 22,
      amount: '570' as NumberString,
      bucketDepth: 30,
      blockNumber: 1000,
      immutableFlag: true,
      duration: Duration.fromSeconds(5),
      usage: 0,
      size: Size.fromGigabytes(100),
      remainingSize: Size.fromGigabytes(100),
      theoreticalSize: Size.fromGigabytes(100),
      calculateSize: () => Size.fromGigabytes(100),
      calculateRemainingSize: () => Size.fromGigabytes(100),
    },
    {
      batchID: new BatchId('3456'.repeat(16)),
      utilization: 5,
      usable: true,
      usageText: '2%',
      label: ADMIN_DRIVE_NAME,
      depth: 22,
      amount: '990' as NumberString,
      bucketDepth: 30,
      blockNumber: 1020,
      immutableFlag: false,
      duration: Duration.fromSeconds(8),
      usage: 0,
      size: Size.fromGigabytes(100),
      remainingSize: Size.fromGigabytes(100),
      theoreticalSize: Size.fromGigabytes(100),
      calculateSize: () => Size.fromGigabytes(100),
      calculateRemainingSize: () => Size.fromGigabytes(100),
    },
  ];
}

export type SeedableFm = { _recordList: FileRecord[] };
export const seedRecords = (fm: FileManagerBase, ...records: FileRecord[]): void => {
  (fm as unknown as SeedableFm)._recordList.push(...records);
};

export function applyDefaultMocks(): void {
  jest.resetAllMocks();
  createInitMocks();

  (getFeedData as jest.Mock).mockResolvedValue({
    feedIndex: FeedIndex.MINUS_ONE,
    feedIndexNext: FEED_INDEX_ZERO,
    payload: {
      toUint8Array: () => SWARM_ZERO_ADDRESS.toUint8Array(),
      toJSON: () => ({
        reference: SWARM_ZERO_ADDRESS.toString(),
        historyRef: SWARM_ZERO_ADDRESS.toString(),
      }),
    },
  });

  (fetchStamp as jest.Mock).mockResolvedValue({ ...mockStampInfo });

  (loadMantaray as jest.Mock).mockResolvedValue(new MantarayNode());
  (getAllNodeEntries as jest.Mock).mockReturnValue([]);
}

export const seedDummyFile = (
  drive: DriveInfo,
  path: string,
  ref: string,
  owner: string,
  actPublisher: string,
): FileRecord => {
  return {
    type: NodeType.File,
    batchId: DUMMY_BATCH_ID,
    owner,
    actPublisher,
    topic: Topic.fromString(`dl-${path}`).toString(),
    driveId: drive.id,
    path,
    content: {
      reference: ref,
      historyRef: SWARM_ZERO_ADDRESS.toString(),
    },
    redundancyLevel: RedundancyLevel.OFF,
  };
};
