import {
  BatchId,
  Bee,
  BeeVersions,
  Bytes,
  Duration,
  EthAddress,
  FeedWriter,
  MantarayNode,
  NodeAddresses,
  NULL_TOPIC,
  NumberString,
  PeerAddress,
  PostageBatch,
  PublicKey,
  Reference,
  UploadResult,
} from '@upcoming/bee-js';
import { Optional } from 'cafe-utility';

import { FileManager } from '../src/fileManager';
import { numberToFeedIndex } from '../src/utils';
import { OWNER_FEED_STAMP_LABEL, SWARM_ZERO_ADDRESS } from '../src/utils/constants';
import { FetchFeedUpdateResponse } from '../src/utils/types';

export const MOCK_BATCH_ID = 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';

export const fileInfoTxt = `[
  {
    "batchId": "${MOCK_BATCH_ID}",
    "file": {
      "reference": "1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68",
      "historyRef": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  },
  {
    "batchId": "${MOCK_BATCH_ID}",
    "file": {
      "reference": "2222222222222222222222222222222222222222222222222222222222222222",
      "historyRef": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  }
]`;

export const extendedFileInfoTxt = `[{"batchId":"${MOCK_BATCH_ID}","file":{"reference":"1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68","historyRef":"0000000000000000000000000000000000000000000000000000000000000000"}},{"batchId":"${MOCK_BATCH_ID}","file":{"reference":"2222222222222222222222222222222222222222222222222222222222222222","historyRef":"0000000000000000000000000000000000000000000000000000000000000000"}},{"batchId":"${MOCK_BATCH_ID}","file":{"reference":"3333333333333333333333333333333333333333333333333333333333333333","historyRef":"0000000000000000000000000000000000000000000000000000000000000000"}}]`;

export const emptyFileInfoTxt = `[]`;

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

export class MockLocalStorage {
  store: Record<string, string>;

  constructor() {
    this.store = {};
  }

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = value;
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

export function setupGlobalLocalStorage(): void {
  Object.defineProperty(global, 'localStorage', {
    value: new MockLocalStorage(),
    writable: true,
  });
}

export const refToPath = new Map<Reference, string>();
refToPath.set(new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68'), 'src/folder/1.txt');
refToPath.set(new Reference('2'.repeat(64)), 'src/folder/2.txt');
refToPath.set(new Reference('3'.repeat(64)), 'src/folder/3.txt');
refToPath.set(new Reference('4'.repeat(64)), 'src/folder/4.txt');

export const pathToRef = new Map<string, Reference>();
pathToRef.set('src/folder/1.txt', new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68'));
pathToRef.set('src/folder/2.txt', new Reference('2'.repeat(64)));
pathToRef.set('src/folder/3.txt', new Reference('3'.repeat(64)));
pathToRef.set('src/folder/4.txt', new Reference('4'.repeat(64)));

export const firstByteArray = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 87, 104, 179, 182,
  167, 219, 86, 210, 29, 26, 191, 244, 13, 65, 206, 191, 200, 52, 72, 254, 216, 215, 233, 176, 110, 192, 211, 176, 115,
  242, 143, 32, 26, 154, 208, 58, 169, 147, 213, 238, 85, 13, 174, 194, 228, 223, 72, 41, 253, 153, 204, 35, 153, 62,
  167, 211, 224, 121, 125, 211, 50, 83, 253, 104, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0,
]);

export const secondByteArray = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 87, 104, 179, 182,
  167, 219, 86, 210, 29, 26, 191, 244, 13, 65, 206, 191, 200, 52, 72, 254, 216, 215, 233, 176, 110, 192, 211, 176, 115,
  242, 143, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 16, 115, 114, 99, 47, 102, 111, 108, 100, 101, 114, 47, 49, 46, 116,
  120, 116, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 148, 0, 17, 119, 248, 231, 159, 158, 240, 146, 107, 58, 95, 110,
  135, 168, 220, 196, 216, 79, 98, 210, 143, 97, 225, 35, 59, 60, 200, 178, 218, 27,
]);

export function createMockPostageBatch(): PostageBatch {
  return {
    batchID: new BatchId(SWARM_ZERO_ADDRESS),
    utilization: 3,
    usable: true,
    label: 'very-good-stamp',
    depth: 22,
    amount: '480000000' as NumberString,
    bucketDepth: 22,
    blockNumber: 111,
    immutableFlag: true,
    duration: Duration.fromSeconds(100),
    usage: 0,
    size: 100,
    remainingSize: 100,
    theoreticalSize: 100,
  };
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
    feedIndex: numberToFeedIndex(currentIndex),
    feedIndexNext: numberToFeedIndex(nextIndex),
    payload: SWARM_ZERO_ADDRESS,
  };
}

export function createMockFeedWriter(char: string = '0'): FeedWriter {
  return {
    upload: jest.fn().mockResolvedValue({
      reference: new Reference(char.repeat(64)),
      historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
    } as UploadResult),
    owner: '' as unknown as EthAddress,
    download: jest.fn(),
    topic: NULL_TOPIC,
  };
}

export function createInitMocks(): any {
  jest
    .spyOn(Bee.prototype, 'getVersions')
    .mockResolvedValue({ beeApiVersion: '0.0.0', beeVersion: '0.0.0' } as BeeVersions);
  jest.spyOn(Bee.prototype, 'isSupportedApiVersion').mockResolvedValue(true);
  jest.spyOn(Bee.prototype, 'getNodeAddresses').mockResolvedValue(createMockNodeAddresses());
  //jest.spyOn(Bee.prototype, 'getAllPostageBatch').mockResolvedValue([createMockPostageBatch()]);
  loadStampListMock();
  jest.spyOn(FileManager.prototype, 'getFeedData').mockResolvedValue(createMockGetFeedDataResult());
  jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(new Bytes(SWARM_ZERO_ADDRESS));
  //jest.spyOn(FileManager.prototype, 'getOwnerFeedStamp').mockReturnValue(createMockPostageBatch());
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
      label: 'one',
      depth: 22,
      amount: '480' as NumberString,
      bucketDepth: 30,
      blockNumber: 980,
      immutableFlag: true,
      duration: Duration.fromSeconds(3),
      usage: 0,
      size: 100,
      remainingSize: 100,
      theoreticalSize: 100,
    },
    {
      batchID: new BatchId('2345'.repeat(16)),
      utilization: 3,
      usable: true,
      label: 'two',
      depth: 22,
      amount: '570' as NumberString,
      bucketDepth: 30,
      blockNumber: 1000,
      immutableFlag: true,
      duration: Duration.fromSeconds(5),
      usage: 0,
      size: 100,
      remainingSize: 100,
      theoreticalSize: 100,
    },
    {
      batchID: new BatchId('3456'.repeat(16)),
      utilization: 5,
      usable: true,
      label: OWNER_FEED_STAMP_LABEL,
      depth: 22,
      amount: '990' as NumberString,
      bucketDepth: 30,
      blockNumber: 1020,
      immutableFlag: false,
      duration: Duration.fromSeconds(8),
      usage: 0,
      size: 100,
      remainingSize: 100,
      theoreticalSize: 100,
    },
  ]);
}
