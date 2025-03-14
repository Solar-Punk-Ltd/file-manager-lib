import {
  BatchId,
  Bee,
  BeeVersions,
  Bytes,
  Duration,
  EthAddress,
  FeedIndex,
  FeedWriter,
  MantarayNode,
  NodeAddresses,
  NULL_TOPIC,
  NumberString,
  PeerAddress,
  PublicKey,
  Reference,
  Size,
  UploadResult,
} from '@upcoming/bee-js';
import { Optional } from 'cafe-utility';

import { FileManagerBase } from '../src/fileManager/fileManager';
import { FileManagerFactory, FileManagerType } from '../src/fileManagerFactory';
import { OWNER_STAMP_LABEL, SWARM_ZERO_ADDRESS } from '../src/utils/constants';
import { EventEmitterBase } from '../src/utils/eventEmitter';
import { FetchFeedUpdateResponse } from '../src/utils/types';

import { BEE_URL, MOCK_SIGNER } from './utils';

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

  mn.calculateSelfAddress();

  return mn;
}

export async function createInitializedFileManager(
  bee: Bee = new Bee(BEE_URL, { signer: MOCK_SIGNER }),
  emitter?: EventEmitterBase,
): Promise<FileManagerBase> {
  const fileManager = (await FileManagerFactory.create(FileManagerType.Node, bee, emitter)) as FileManagerBase;
  return fileManager;
}

export function createMockNodeAddresses(): NodeAddresses {
  return {
    overlay: SWARM_ZERO_ADDRESS as PeerAddress,
    underlay: ['mock-underlay'],
    ethereum: 'mock-address' as unknown as EthAddress,
    publicKey: SWARM_ZERO_ADDRESS.toString().repeat(2) as unknown as PublicKey,
    pssPublicKey: 'mock-pss-public-key',
  } as unknown as NodeAddresses;
}

export function createMockGetFeedDataResult(currentIndex = 0, nextIndex = 1): FetchFeedUpdateResponse {
  return {
    feedIndex: FeedIndex.fromBigInt(BigInt(currentIndex)),
    feedIndexNext: FeedIndex.fromBigInt(BigInt(nextIndex)),
    payload: SWARM_ZERO_ADDRESS,
  };
}

export function createMockFeedWriter(char: string = '0'): FeedWriter {
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
    owner: '' as unknown as EthAddress,
    download: jest.fn(),
    downloadReference: jest.fn(),
    downloadPayload: jest.fn(),
    topic: NULL_TOPIC,
  };
}

export function createInitMocks(): any {
  jest
    .spyOn(Bee.prototype, 'getVersions')
    .mockResolvedValue({ beeApiVersion: '0.0.0', beeVersion: '0.0.0' } as BeeVersions);
  jest.spyOn(Bee.prototype, 'isSupportedApiVersion').mockResolvedValue(true);
  jest.spyOn(Bee.prototype, 'getNodeAddresses').mockResolvedValue(createMockNodeAddresses());
  loadStampListMock();
  jest.spyOn(FileManagerBase.prototype, 'getFeedData').mockResolvedValue(createMockGetFeedDataResult());
  jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(new Bytes(SWARM_ZERO_ADDRESS));
  jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue({
    reference: SWARM_ZERO_ADDRESS,
    historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
  } as unknown as UploadResult);
  jest.spyOn(Bee.prototype, 'makeFeedWriter').mockReturnValue(createMockFeedWriter());
}

export function createUploadFilesFromDirectorySpy(char: string): jest.SpyInstance {
  return jest.spyOn(Bee.prototype, 'uploadFilesFromDirectory').mockResolvedValueOnce({
    reference: new Reference(char.repeat(64)),
    historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
  });
}

export function createUploadFileSpy(char: string): jest.SpyInstance {
  return jest.spyOn(Bee.prototype, 'uploadFile').mockResolvedValueOnce({
    reference: new Reference(char.repeat(64)),
    historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
  });
}

export function createUploadDataSpy(char: string): jest.SpyInstance {
  return jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValueOnce({
    reference: new Reference(char.repeat(64)),
    historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
  });
}

export function loadStampListMock(): jest.SpyInstance {
  return jest.spyOn(Bee.prototype, 'getAllPostageBatch').mockResolvedValue([
    {
      batchID: new BatchId('1234'.repeat(16)),
      utilization: 2,
      usable: true,
      usageText: '2%',
      label: 'one',
      depth: 22,
      amount: '480' as NumberString,
      bucketDepth: 30,
      blockNumber: 980,
      immutableFlag: true,
      duration: Duration.fromSeconds(3),
      usage: 0,
      size: Size.fromGigabytes(100),
      remainingSize: Size.fromGigabytes(100),
      theoreticalSize: Size.fromGigabytes(100),
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
    },
    {
      batchID: new BatchId('3456'.repeat(16)),
      utilization: 5,
      usable: true,
      usageText: '2%',
      label: OWNER_STAMP_LABEL,
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
    },
  ]);
}
