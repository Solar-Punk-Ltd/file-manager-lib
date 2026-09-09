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
  type NodeAddresses,
  type NumberString,
  PeerAddress,
  type PostageBatch,
  RedundancyLevel,
  Reference,
  Size,
  Topic,
  type UploadResult,
} from '@ethersphere/bee-js';
import { MantarayNode } from '@ethersphere/core-sdk';
import { Optional } from 'cafe-utility';

import { DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID, MOCK_NODE_SIGNER } from '../utils';

import { type FileManagerBase } from '@/fileManager';
import { type DriveInfo, type FileRecord, type Identity, NodeType, type StampInfo, type SwarmClient } from '@/types';
import { fetchStamp, getFeedData, openFeedRef, writeEncryptedFeed, writeSealedRefFeed } from '@/utils/bee';
import {
  ADMIN_DRIVE_NAME,
  FEED_INDEX_ZERO,
  FMK_LENGTH,
  KDF_EPOCH,
  MANIFEST_METADATA_WRAPPED_CONTENT_KEY,
  MANIFEST_METADATA_WRAPPED_META_KEY,
  SWARM_ZERO_ADDRESS,
  UNLOCK_KDF_LABEL,
  UNLOCK_SALT_LENGTH,
} from '@/utils/constants';
import { envelopeTopic, sealKey } from '@/utils/identity';
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
    publicKey: MOCK_NODE_SIGNER.publicKey(),
    pssPublicKey: MOCK_NODE_SIGNER.publicKey(),
  };
}

export async function createMockFileInfo(
  owner: string,
  ref: string = SWARM_ZERO_ADDRESS.toString(),
  overrides?: Partial<FileRecord>,
): Promise<FileRecord> {
  return {
    type: NodeType.File,
    batchId: DUMMY_BATCH_ID,
    name: 'john doe',
    path: '/john doe',
    topic: Topic.fromString('file-1').toString(),
    driveId: Identifier.fromString('123').toString(),
    owner,
    content: { reference: ref },
    redundancyLevel: RedundancyLevel.OFF,
    ...overrides,
  };
}

export function createMockDriveInfo(overrides?: Partial<DriveInfo>): DriveInfo {
  return {
    type: NodeType.Drive,
    id: Identifier.fromString('123').toString(),
    batchId: DUMMY_BATCH_ID,
    owner: DEFAULT_MOCK_SIGNER.publicKey().address().toString(),
    name: 'Test Drive',
    topic: Topic.fromString('drive-topic-1').toString(),
    redundancyLevel: RedundancyLevel.MEDIUM,
    manifestRef: { reference: new Reference('1'.repeat(64)).toString() },
    isAdmin: false,
    ...overrides,
  };
}

export function mockWrappedKeys(seed: string = 'ab'): Record<string, string> {
  return {
    [MANIFEST_METADATA_WRAPPED_META_KEY]: seed.repeat(64 / seed.length),
    [MANIFEST_METADATA_WRAPPED_CONTENT_KEY]: seed.repeat(64 / seed.length),
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
    .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').status), 'getVersions')
    .mockResolvedValue({ beeApiVersion: '0.0.0', beeVersion: '0.0.0' } as BeeVersions);
  jest
    .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').status), 'isSupportedApiVersion')
    .mockResolvedValue(true);
  jest
    .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').connectivity), 'getNodeAddresses')
    .mockResolvedValue(createMockNodeAddresses());
  loadStampListMock();
  jest
    .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').data), 'download')
    .mockResolvedValue(new Bytes(data || SWARM_ZERO_ADDRESS));
  jest
    .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').file), 'download')
    .mockResolvedValue({ data: new Bytes(SWARM_ZERO_ADDRESS) });
  jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').data), 'downloadReadable').mockResolvedValue(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue((data || SWARM_ZERO_ADDRESS).toUint8Array());
        controller.close();
      },
    }),
  );
  jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').data), 'upload').mockResolvedValue({
    reference: data || SWARM_ZERO_ADDRESS,
    historyAddress: Optional.of(data || SWARM_ZERO_ADDRESS),
  } as unknown as UploadResult);
  jest
    .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').feed), 'makeWriter')
    .mockReturnValue(createMockFeedWriter());
  jest
    .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').feed), 'makeReader')
    .mockReturnValue(createMockFeedReader());
  jest
    .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').stamp), 'getAll')
    .mockResolvedValue(loadStampListMock());
}

export function createUploadDataSpy(char: string): jest.SpyInstance {
  return jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').data), 'upload').mockResolvedValueOnce({
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

export const seedKeys = (fm: FileManagerBase, ...topics: string[]): void => {
  const { keyring } = (fm as unknown as { store: { keyring: { mint: (topic: string) => unknown } } }).store;
  for (const topic of topics) {
    keyring.mint(topic);
  }
};

const TEST_FMK = new Uint8Array(FMK_LENGTH).fill(0x2a);
const TEST_UNLOCK_SALT = new Uint8Array(UNLOCK_SALT_LENGTH).fill(0x11);

export async function mockIdentityFeed(client: SwarmClient, rest: (topic: Topic) => unknown): Promise<Identity> {
  const secret = await client.deriveSecret(UNLOCK_KDF_LABEL);
  const { identity, sealed } = await sealKey(secret, TEST_UNLOCK_SALT, TEST_FMK.slice());

  const envelope = {
    v: KDF_EPOCH,
    salt: new Bytes(TEST_UNLOCK_SALT).toString(),
    sealed: new Bytes(sealed).toString(),
    keyId: identity.keyId,
  };
  const envelopeFeed = (await envelopeTopic(secret)).toString();

  (getFeedData as jest.Mock).mockImplementation(async (_client: SwarmClient, topic: Topic) =>
    topic.toString() === envelopeFeed
      ? {
          feedIndex: FEED_INDEX_ZERO,
          feedIndexNext: FeedIndex.fromBigInt(1n),
          payload: Bytes.fromUtf8(JSON.stringify(envelope)),
        }
      : rest(topic),
  );

  return identity;
}

export const refPayload = (
  reference: string = SWARM_ZERO_ADDRESS.toString(),
): { toUint8Array: () => Uint8Array; toJSON: () => object } => ({
  toUint8Array: () => new Reference(reference).toUint8Array(),
  toJSON: () => ({ reference }),
});

export function applyDefaultMocks(): void {
  jest.resetAllMocks();
  createInitMocks();

  (getFeedData as jest.Mock).mockResolvedValue({
    feedIndex: FeedIndex.MINUS_ONE,
    feedIndexNext: FEED_INDEX_ZERO,
    payload: {
      toUint8Array: () => SWARM_ZERO_ADDRESS.toUint8Array(),
      toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString() }),
    },
  });

  (fetchStamp as jest.Mock).mockResolvedValue({ ...mockStampInfo });

  (writeSealedRefFeed as jest.Mock).mockImplementation(jest.requireActual('@/utils/bee').writeSealedRefFeed);
  (writeEncryptedFeed as jest.Mock).mockImplementation(jest.requireActual('@/utils/bee').writeEncryptedFeed);

  (openFeedRef as jest.Mock).mockImplementation(async (payload: { toUint8Array: () => Uint8Array }) => ({
    reference: new Reference(payload.toUint8Array()).toString(),
  }));

  (loadMantaray as jest.Mock).mockResolvedValue(new MantarayNode());
  (getAllNodeEntries as jest.Mock).mockReturnValue([]);
}

export const seedDummyFile = (drive: DriveInfo, path: string, ref: string, owner: string): FileRecord => {
  return {
    type: NodeType.File,
    batchId: DUMMY_BATCH_ID,
    owner,
    topic: Topic.fromString(`dl-${path}`).toString(),
    driveId: drive.id,
    name: path.split('/').filter(Boolean).pop() ?? path,
    path,
    content: { reference: ref },
    redundancyLevel: RedundancyLevel.OFF,
  };
};
