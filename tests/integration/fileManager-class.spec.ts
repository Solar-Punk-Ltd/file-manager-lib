import { TextDecoder as NodeTextDecoder, TextEncoder } from 'util';
global.TextDecoder = NodeTextDecoder as typeof TextDecoder;
global.TextEncoder = TextEncoder;

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BatchId, BeeDev, MantarayNode, Reference } from '@upcoming/bee-js';
import path from 'path';

import { FileManager } from '../../src/fileManager';
import { OWNER_FEED_STAMP_LABEL, REFERENCE_LIST_TOPIC, SWARM_ZERO_ADDRESS } from '../../src/types/constants';
import { StampError } from '../../src/types/errors';
import { buyStamp } from '../../src/types/utils';
import {
  BEE_URL,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  dowloadAndCompareFiles,
  MOCK_SIGNER,
  OTHER_BEE_URL,
  OTHER_MOCK_SIGNER,
} from '../utils';

describe('FileManager initialization', () => {
  let bee: BeeDev;
  let fileManager: FileManager;

  beforeAll(async () => {
    // Create a BeeDev instance with a valid signer.
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    // Ensure the owner stamp is available (buyStamp may throw if already exists)
    try {
      await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    } catch (e) {
      // Stamp already exists; ignore error.
    }
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    // For each test, create a fresh FileManager instance and initialize it.
    fileManager = new FileManager(bee);
    await fileManager.initialize();
  });

  it('should create and initialize a new instance', async () => {
    // Use a different Bee instance with a different signer.
    const otherBee = new BeeDev(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });
    const fm = new FileManager(otherBee);
    try {
      await fm.initialize();
    } catch (error: any) {
      expect(error).toBeInstanceOf(StampError);
      expect(error.message).toContain('Owner stamp not found');
    }
    const stamps = await fm.getStamps();
    expect(stamps).toEqual([]);
    expect(fm.getFileInfoList()).toEqual([]);
    expect(fm.getSharedWithMe()).toEqual([]);
    expect(fm.getNodeAddresses()).not.toEqual(undefined);
  });

  it('should fetch the owner stamp and initialize the owner feed and topic', async () => {
    // Ensure the owner stamp exists by buying it.
    const batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    const publsiherPublicKey = fileManager.getNodeAddresses()!.publicKey;

    const stamps = await fileManager.getStamps();
    expect(stamps[0].batchID).toEqual(batchId);
    expect(stamps[0].label).toEqual(OWNER_FEED_STAMP_LABEL);
    expect(fileManager.getFileInfoList()).toEqual([]);
    expect(fileManager.getSharedWithMe()).toEqual([]);

    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 0);
    const topicHistory = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 1);
    const topicHex = await bee.downloadData(new Reference(feedTopicData.payload), {
      actHistoryAddress: new Reference(topicHistory.payload),
      actPublisher: publsiherPublicKey,
    });
    expect(topicHex).not.toEqual(SWARM_ZERO_ADDRESS);
    // Test re-initialization; state should remain unchanged.
    await fileManager.initialize();
    const reinitTopicHex = await bee.downloadData(new Reference(feedTopicData.payload), {
      actHistoryAddress: new Reference(topicHistory.payload),
      actPublisher: publsiherPublicKey,
    });
    expect(topicHex).toEqual(reinitTopicHex);
  });

  it('should throw an error if someone else than the owner tries to read the owner feed', async () => {
    const otherBee = new BeeDev(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });
    const publsiherPublicKey = fileManager.getNodeAddresses()!.publicKey;

    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 0, MOCK_SIGNER.publicKey().address());
    const topicHistory = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 1, MOCK_SIGNER.publicKey().address());

    try {
      await bee.downloadData(new Reference(feedTopicData.payload), {
        actHistoryAddress: new Reference(topicHistory.payload),
        actPublisher: OTHER_MOCK_SIGNER.publicKey(),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).stack?.includes('404')).toBeTruthy();
    }

    try {
      await otherBee.downloadData(new Reference(feedTopicData.payload), {
        actHistoryAddress: new Reference(topicHistory.payload),
        actPublisher: publsiherPublicKey,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).stack?.includes('500')).toBeTruthy();
    }
  });

  it('should upload to and fetch from swarm a nested folder with files', async () => {
    const firstFile = new File(['Shh!'], 'secret.txt', { type: 'text/plain' });
    const secondFile = new File(['Hello'], 'nested/hello.txt', { type: 'text/plain' });
    const thirdFile = new File(['World'], 'nested/world.txt', { type: 'text/plain' });
    const expNestedPaths = ['secret.txt', 'nested/hello.txt', 'nested/world.txt'];
    const expFileDataArr: File[][] = [[firstFile], [secondFile, thirdFile]];

    // Use a test stamp for file uploads.
    const testStampId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'testStamp');
    {
      const fileManager = new FileManager(bee);
      await fileManager.initialize();
      const publsiherPublicKey = fileManager.getNodeAddresses()!.publicKey.toCompressedHex();
      await fileManager.upload(testStampId, [firstFile]);
      await fileManager.upload(testStampId, [secondFile, thirdFile]);

      const fileInfoList = fileManager.getFileInfoList();
      expect(fileInfoList.length).toEqual(expFileDataArr.length);
      await dowloadAndCompareFiles(fileManager, publsiherPublicKey, fileInfoList, expFileDataArr);

      const fileList = await fileManager.listFiles(fileInfoList[0], {
        actHistoryAddress: fileInfoList[0].file.historyRef,
        actPublisher: publsiherPublicKey,
      });
      expect(fileList.length).toEqual(expNestedPaths.length);
      for (const [ix, f] of fileList.entries()) {
        expect(path.basename(f.path)).toEqual(path.basename(expNestedPaths[ix]));
      }
    }
    // Reinitialize fileManager after it goes out of scope to test if the file is saved on the feed.
    const fm = new FileManager(bee);
    await fm.initialize();
    const publsiherPublicKey = fm.getNodeAddresses()!.publicKey.toCompressedHex();
    const fileInfoList = fm.getFileInfoList();
    await dowloadAndCompareFiles(fm, publsiherPublicKey, fileInfoList, expFileDataArr);
  });

  // Additional tests from the "Additional FileManager Initialization Integration Tests"
  it('should verify Bee versions and supported API', async () => {
    const versions = await bee.getVersions();
    expect(versions.beeVersion).toBeDefined();
    expect(versions.beeApiVersion).toBeDefined();
    const supported = await bee.isSupportedApiVersion();
    expect(supported).toBeTruthy();
  });

  it('should populate node addresses', async () => {
    const nodeAddresses = fileManager.getNodeAddresses();
    expect(nodeAddresses).toBeDefined();
    expect(nodeAddresses?.publicKey).toBeDefined();
  });

  it('should fetch and store usable stamps', async () => {
    const stamps = await fileManager.getStamps();
    expect(stamps.length).toBeGreaterThan(0);
    const ownerStamp = fileManager.getOwnerFeedStamp();
    expect(ownerStamp).toBeDefined();
    if (ownerStamp) {
      expect(ownerStamp.label).toEqual(OWNER_FEED_STAMP_LABEL);
    }
  });

  it('should initialize owner feed topic and owner feed list correctly', async () => {
    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 0);
    expect(feedTopicData.payload).not.toEqual(SWARM_ZERO_ADDRESS);
    const ownerFeedList = (fileManager as any).ownerFeedList;
    expect(Array.isArray(ownerFeedList)).toBeTruthy();
  });

  it('should not reinitialize if already initialized', async () => {
    const fileInfoListBefore = [...fileManager.getFileInfoList()];
    const stampsBefore = await fileManager.getStamps();
    await fileManager.initialize();
    expect(fileManager.getFileInfoList()).toEqual(fileInfoListBefore);
    expect(await fileManager.getStamps()).toEqual(stampsBefore);
  });
});

describe('FileManager saveMantaray', () => {
  let bee: BeeDev;
  let fileManager: FileManager;
  let batchId: BatchId;

  beforeAll(async () => {
    // Create a BeeDev instance with a valid signer.
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    // Purchase (or ensure) a test stamp is available.
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'testStamp');
    // Create and initialize the FileManager.
    fileManager = new FileManager(bee);
    await fileManager.initialize();
  });

  it('should save a non-empty file node and return a valid ReferenceWithHistory (ACT enabled)', async () => {
    // Create a new MantarayNode representing a file node.
    const node = new MantarayNode();
    // Upload some dummy content to Bee.
    const dummyContent = Buffer.from('dummy content');
    const uploadRes = await bee.uploadData(batchId, dummyContent, { act: true });
    // Set the node's targetAddress using the uploaded reference.
    node.targetAddress = new Reference(uploadRes.reference.toString()).toUint8Array();
    // Add some metadata so the node is not considered empty.
    node.metadata = { dummy: 'value' };

    // Call saveMantaray with { act: true } so that a history address is produced.
    const result = await fileManager.saveMantaray(batchId, node, { act: true });
    console.log('saveMantaray result (file node):', result);

    // Verify that the returned object has non-empty strings for both reference and historyRef.
    expect(typeof result.reference).toBe('string');
    expect(result.reference).not.toEqual('');
    expect(typeof result.historyRef).toBe('string');
    expect(result.historyRef).not.toEqual('');

    // Download the saved data (providing actPublisher) to confirm it was stored.
    const downloaded = await bee.downloadData(new Reference(result.reference), {
      actHistoryAddress: new Reference(result.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    expect(downloaded).toBeDefined();
    expect(downloaded.length).toBeGreaterThan(0);
  });

  it('should throw an error when saving a node without ACT enabled (history address missing)', async () => {
    const node = new MantarayNode();
    const dummyContent = Buffer.from('dummy content');
    const uploadRes = await bee.uploadData(batchId, dummyContent, { act: true });
    node.targetAddress = new Reference(uploadRes.reference.toString()).toUint8Array();
    node.metadata = { dummy: 'value' };

    // Calling saveMantaray with { act: false } should result in no history address,
    // so getOrThrow() inside saveMantaray should throw.
    await expect(fileManager.saveMantaray(batchId, node, { act: false })).rejects.toThrow();
  });

  it('should save a node with a fork and propagate the parent selfAddress', async () => {
    // Create a parent node (simulate a directory).
    const parent = new MantarayNode();
    // Create a child node (simulate a file).
    const child = new MantarayNode();
    const dummyContent = Buffer.from('fork dummy content');
    const uploadRes = await bee.uploadData(batchId, dummyContent, { act: true });
    child.targetAddress = new Reference(uploadRes.reference.toString()).toUint8Array();
    child.metadata = { fork: 'child' };

    // Manually add a fork using an inline object conforming to the Fork interface.
    parent.forks.set(100, {
      prefix: new Uint8Array([100]),
      node: child,
      marshal: () => child.targetAddress,
    });

    const result = await fileManager.saveMantaray(batchId, parent, { act: true });
    console.log('saveMantaray result (node with fork):', result);

    expect(typeof result.reference).toBe('string');
    expect(result.reference).not.toEqual('');
    expect(typeof result.historyRef).toBe('string');
    expect(result.historyRef).not.toEqual('');

    // Verify that parent's selfAddress is set after saving.
    expect(parent.selfAddress).toBeDefined();
  });

  it('should correctly handle a node with multiple forks', async () => {
    // Create a parent node.
    const parent = new MantarayNode();
    // Create two child nodes.
    const child1 = new MantarayNode();
    const child2 = new MantarayNode();

    const dummyContent1 = Buffer.from('child1 content');
    const dummyContent2 = Buffer.from('child2 content');

    const uploadRes1 = await bee.uploadData(batchId, dummyContent1, { act: true });
    const uploadRes2 = await bee.uploadData(batchId, dummyContent2, { act: true });
    child1.targetAddress = new Reference(uploadRes1.reference.toString()).toUint8Array();
    child2.targetAddress = new Reference(uploadRes2.reference.toString()).toUint8Array();
    child1.metadata = { name: 'child1' };
    child2.metadata = { name: 'child2' };

    // Manually add forks for both children using inline fork objects.
    parent.forks.set(50, {
      prefix: new Uint8Array([50]),
      node: child1,
      marshal: () => child1.targetAddress,
    });
    parent.forks.set(51, {
      prefix: new Uint8Array([51]),
      node: child2,
      marshal: () => child2.targetAddress,
    });

    const result = await fileManager.saveMantaray(batchId, parent, { act: true });
    expect(typeof result.reference).toBe('string');
    expect(result.reference).not.toEqual('');
    expect(typeof result.historyRef).toBe('string');
    expect(result.historyRef).not.toEqual('');

    // Optionally, download the saved data to confirm it was stored.
    const downloaded = await bee.downloadData(new Reference(result.reference), {
      actHistoryAddress: new Reference(result.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    expect(downloaded).toBeDefined();
    expect(downloaded.length).toBeGreaterThan(0);
  });
});

describe('FileManager downloadFork', () => {
  let bee: BeeDev;
  let fileManager: FileManager;
  let batchId: BatchId;
  let parent: MantarayNode;
  let child: MantarayNode;
  let childHistoryRef: string; // store child's history reference

  // Define paths and dummy content.
  const folderPath = 'folder/';
  const fileName = 'file.txt';
  const fullPath = folderPath + fileName;
  const dummyContentStr = 'fork dummy file content';

  beforeAll(async () => {
    // Create BeeDev instance.
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    // Purchase (or ensure) a test stamp.
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'testStamp');
    // Create and initialize the FileManager.
    fileManager = new FileManager(bee);
    await fileManager.initialize();

    // Create a parent node with an explicit path "folder/".
    parent = new MantarayNode({ path: new TextEncoder().encode(folderPath) });
    // Create a child node with an explicit path "file.txt".
    child = new MantarayNode({ path: new TextEncoder().encode(fileName) });
    // Set child's parent so that fullPath computes as "folder/file.txt".
    child.parent = parent;

    // Upload dummy content to Bee for the child.
    const dummyContent = Buffer.from(dummyContentStr);
    const uploadRes = await bee.uploadData(batchId, dummyContent, { act: true });
    // Save the child's history reference.
    childHistoryRef = uploadRes.historyAddress.getOrThrow().toString();
    // Set the child's targetAddress using the uploaded reference.
    child.targetAddress = new Reference(uploadRes.reference).toUint8Array();
    child.metadata = { info: 'dummy file' };

    // Manually add a fork to the parent.
    // Create an inline fork object with required properties.
    parent.forks.set(child.path[0], {
      prefix: child.path,
      node: child,
      marshal: () => child.targetAddress,
    });
  });

  it('should download the fork content when the path exists', async () => {
    const options = {
      actHistoryAddress: new Reference(childHistoryRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    };
    const downloaded = await fileManager.downloadFork(parent, fullPath, options);
    const downloadedStr = downloaded.toUtf8();
    expect(downloadedStr).toEqual(dummyContentStr);
  });

  it('should return SWARM_ZERO_ADDRESS when the parent has no forks', async () => {
    // Create a new node without any forks.
    const emptyNode = new MantarayNode({ path: new TextEncoder().encode('emptyFolder/') });
    const options = {
      actHistoryAddress: new Reference(childHistoryRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    };
    const result = await fileManager.downloadFork(emptyNode, 'emptyFolder/file.txt', options);
    expect(result).toEqual(SWARM_ZERO_ADDRESS);
  });

  it('should return SWARM_ZERO_ADDRESS when the fork exists but its targetAddress is NULL_ADDRESS', async () => {
    // Create a node with a fork that has a NULL_ADDRESS.
    const nodeWithNullFork = new MantarayNode({ path: new TextEncoder().encode('nullFolder/') });
    const fakeChild = new MantarayNode({ path: new TextEncoder().encode('file.txt') });
    fakeChild.parent = nodeWithNullFork;
    fakeChild.targetAddress = new Reference(SWARM_ZERO_ADDRESS).toUint8Array();
    fakeChild.metadata = { info: 'should be empty' };
    nodeWithNullFork.forks.set(fakeChild.path[0], {
      prefix: fakeChild.path,
      node: fakeChild,
      marshal: () => new Reference(SWARM_ZERO_ADDRESS).toUint8Array(),
    });
    const options = {
      actHistoryAddress: new Reference(childHistoryRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    };
    const result = await fileManager.downloadFork(nodeWithNullFork, 'nullFolder/file.txt', options);
    expect(result).toEqual(SWARM_ZERO_ADDRESS);
  });

  it('should correctly handle a nested fork structure', async () => {
    // Create a nested structure: parent -> intermediate -> child.
    const nestedParent = new MantarayNode({ path: new TextEncoder().encode('nestedFolder/') });
    const intermediate = new MantarayNode({ path: new TextEncoder().encode('subfolder/') });
    // Set intermediate's parent.
    intermediate.parent = nestedParent;
    const nestedChild = new MantarayNode({ path: new TextEncoder().encode('nestedFile.txt') });
    nestedChild.parent = intermediate;

    const nestedContentStr = 'nested fork dummy content';
    const nestedContent = Buffer.from(nestedContentStr);
    const uploadResNested = await bee.uploadData(batchId, nestedContent, { act: true });
    const nestedChildHistory = uploadResNested.historyAddress.getOrThrow().toString();
    nestedChild.targetAddress = new Reference(uploadResNested.reference).toUint8Array();
    nestedChild.metadata = { info: 'nested file' };

    // Add the nestedChild as a fork to the intermediate node.
    intermediate.forks.set(nestedChild.path[0], {
      prefix: nestedChild.path,
      node: nestedChild,
      marshal: () => nestedChild.targetAddress,
    });
    // Add intermediate as a fork to the nestedParent.
    nestedParent.forks.set(intermediate.path[0], {
      prefix: intermediate.path,
      node: intermediate,
      marshal: () => {
        // For simplicity, use intermediate's targetAddress if set; otherwise, use an empty array.
        return intermediate.targetAddress;
      },
    });

    // Now the full path should be "nestedFolder/subfolder/nestedFile.txt"
    const fullNestedPath = 'nestedFolder/subfolder/nestedFile.txt';
    const options = {
      actHistoryAddress: new Reference(nestedChildHistory),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    };
    const downloadedNested = await fileManager.downloadFork(nestedParent, fullNestedPath, options);
    const downloadedNestedStr = downloadedNested.toUtf8();
    expect(downloadedNestedStr).toEqual(nestedContentStr);
  });
});
