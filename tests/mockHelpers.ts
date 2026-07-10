import {
  BatchId,
  Bee,
  BeeVersions,
  Bytes,
  Duration,
  EthAddress,
  FeedReader,
  FeedWriter,
  Identifier,
  MantarayNode,
  NodeAddresses,
  NumberString,
  PeerAddress,
  PostageBatch,
  PublicKey,
  RedundancyLevel,
  Reference,
  Size,
  Topic,
  UploadResult,
} from '@ethersphere/bee-js';
import { Optional } from 'cafe-utility';

import { BEE_URL, DEFAULT_MOCK_SIGNER } from './utils';

import { EventEmitter } from '@/eventEmitter/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { DriveInfo, FileRecord } from '@/types';
import { FileManagerEvents } from '@/utils';
import { ADMIN_STAMP_LABEL, SWARM_ZERO_ADDRESS } from '@/utils/constants';

export const MOCK_BATCH_ID = 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';

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

export async function createInitializedFileManager(
  bee: Bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER }),
  batchId?: string | BatchId,
  emitter?: EventEmitter,
): Promise<FileManagerBase> {
  const fm = new FileManagerBase(bee, emitter);

  let isFirstInit = true;
  fm.emitter.on(FileManagerEvents.INITIALIZED, (ok: boolean) => {
    if (isFirstInit) {
      expect(ok).toBe(true);
      isFirstInit = false;
    }
  });

  await fm.initialize();

  if (!fm.driveList.some((d) => d.isAdmin)) {
    await fm.createDrive(batchId ?? MOCK_BATCH_ID, ADMIN_STAMP_LABEL, true, RedundancyLevel.MEDIUM);
  }

  return fm;
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
    batchId: MOCK_BATCH_ID,
    path: '/john doe',
    topic: Topic.fromString('file-1').toString(),
    driveId: Identifier.fromString('123').toString(),
    owner: owner,
    actPublisher,
    fileRefAndHistory: {
      reference: ref,
      historyRef: SWARM_ZERO_ADDRESS.toString(),
    },
    ...overrides,
  };
}

export function createMockDriveInfo(overrides?: Partial<DriveInfo>): DriveInfo {
  return {
    id: Identifier.fromString('123'),
    batchId: MOCK_BATCH_ID,
    owner: DEFAULT_MOCK_SIGNER.publicKey().address().toString(),
    name: 'Test Drive',
    driveFeedTopic: Topic.fromString('drive-topic-1').toString(),
    redundancyLevel: RedundancyLevel.MEDIUM,
    manifestRef: {
      reference: new Reference('1'.repeat(64)).toString(),
      historyRef: new Reference('2'.repeat(64)).toString(),
    },
    isAdmin: false,
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
      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
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
  jest.spyOn(Bee.prototype, 'streamFile').mockResolvedValue((data || SWARM_ZERO_ADDRESS) as Reference);
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
  batchID: new BatchId(MOCK_BATCH_ID),
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
      label: ADMIN_STAMP_LABEL,
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
