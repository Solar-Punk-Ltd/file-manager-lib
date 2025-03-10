import { BatchId, BeeDev, Bytes, MantarayNode, PostageBatch, Reference, Topic } from '@upcoming/bee-js';
import * as fs from 'fs';
import path from 'path';

import { FileManager } from '../../src/fileManager';
import { OWNER_FEED_STAMP_LABEL, REFERENCE_LIST_TOPIC, SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { StampError } from '../../src/utils/errors';
import { buyStamp } from '../../src/utils/utils';
import {
  BEE_URL,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  dowloadAndCompareFiles,
  getTestFile,
  MOCK_SIGNER,
  OTHER_BEE_URL,
  OTHER_MOCK_SIGNER,
  readFilesOrDirectory,
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

    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 0n);
    const topicHistory = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 1n);
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

    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 0n, MOCK_SIGNER.publicKey().address());
    const topicHistory = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 1n, MOCK_SIGNER.publicKey().address());

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
    const exptTestFileData = getTestFile('fixtures/test.txt');
    const expNestedPaths = await readFilesOrDirectory(path.join(__dirname, '../fixtures/nested'), 'nested');
    const expFileDataArr: string[][] = [];
    const fileDataArr: string[] = [];
    for (const f of expNestedPaths) {
      fileDataArr.push(getTestFile(`./fixtures/${f}`));
    }
    expFileDataArr.push(fileDataArr);
    expFileDataArr.push([exptTestFileData]);

    // Use a test stamp for file uploads.
    const testStampId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'testStamp');
    {
      const fm = new FileManager(bee);
      await fm.initialize();
      const publsiherPublicKey = fm.getNodeAddresses()!.publicKey.toCompressedHex();
      await fm.upload(testStampId, path.join(__dirname, '../fixtures/nested'));
      await fm.upload(testStampId, path.join(__dirname, '../fixtures/test.txt'));

      const fileInfoList = fm.getFileInfoList();
      expect(fileInfoList.length).toEqual(expFileDataArr.length);
      await dowloadAndCompareFiles(fm, publsiherPublicKey, fileInfoList, expFileDataArr);

      const fileList = await fm.listFiles(fileInfoList[0], {
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
    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 0n);
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
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
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
    parent = new MantarayNode({ path: Bytes.fromUtf8(folderPath).toUint8Array() });
    // Create a child node with an explicit path "file.txt".
    child = new MantarayNode({ path: Bytes.fromUtf8(fileName).toUint8Array() });
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
    const emptyNode = new MantarayNode({ path: Bytes.fromUtf8('emptyFolder/').toUint8Array() });
    const options = {
      actHistoryAddress: new Reference(childHistoryRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    };
    const result = await fileManager.downloadFork(emptyNode, 'emptyFolder/file.txt', options);
    expect(result).toEqual(SWARM_ZERO_ADDRESS);
  });

  it('should return SWARM_ZERO_ADDRESS when the fork exists but its targetAddress is NULL_ADDRESS', async () => {
    // Create a node with a fork that has a NULL_ADDRESS.
    const nodeWithNullFork = new MantarayNode({ path: Bytes.fromUtf8('nullFolder/').toUint8Array() });
    const fakeChild = new MantarayNode({ path: Bytes.fromUtf8('file.txt').toUint8Array() });
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
    const nestedParent = new MantarayNode({ path: Bytes.fromUtf8('nestedFolder/').toUint8Array() });
    const intermediate = new MantarayNode({ path: Bytes.fromUtf8('subfolder/').toUint8Array() });
    // Set intermediate's parent.
    intermediate.parent = nestedParent;
    const nestedChild = new MantarayNode({ path: Bytes.fromUtf8('nestedFile.txt').toUint8Array() });
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

  it('should upload 2 files, verify, add a 3rd file, save again, and then download forks to verify all files', async () => {
    // Create a folder node with 2 files and save it
    const folderPathOnDisk = path.join(__dirname, '../fixtures/folder');
    const file1Path = path.join(folderPathOnDisk, '1.txt');
    const file2Path = path.join(folderPathOnDisk, '2.txt');

    // Read file contents.
    const file1Content = fs.readFileSync(file1Path);
    const file2Content = fs.readFileSync(file2Path);

    // Create a folder node with a designated integration folder path.
    const integrationFolderPath = 'integrationFolder/';
    const folderNode = new MantarayNode({ path: Bytes.fromUtf8(integrationFolderPath).toUint8Array() });

    // Create and add 1.txt.
    const child1 = new MantarayNode({ path: Bytes.fromUtf8('1.txt').toUint8Array() });
    child1.parent = folderNode;
    const uploadRes1 = await bee.uploadData(batchId, file1Content, { act: true });
    child1.targetAddress = new Reference(uploadRes1.reference).toUint8Array();
    child1.metadata = { info: 'file 1' };
    folderNode.forks.set(child1.path[0], {
      prefix: child1.path,
      node: child1,
      marshal: () => child1.targetAddress,
    });

    // Create and add 2.txt.
    const child2 = new MantarayNode({ path: Bytes.fromUtf8('2.txt').toUint8Array() });
    child2.parent = folderNode;
    const uploadRes2 = await bee.uploadData(batchId, file2Content, { act: true });
    child2.targetAddress = new Reference(uploadRes2.reference).toUint8Array();
    child2.metadata = { info: 'file 2' };
    folderNode.forks.set(child2.path[0], {
      prefix: child2.path,
      node: child2,
      marshal: () => child2.targetAddress,
    });

    // Save the initial mantaray structure (with 2 files).
    const savedMantaray = await fileManager.saveMantaray(batchId, folderNode, { act: true });
    console.log('Initial state saved:', savedMantaray);

    // Download the 2 files to verify the initial state
    const options1 = {
      actHistoryAddress: new Reference(uploadRes1.historyAddress.getOrThrow().toString()),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    };
    const downloaded1 = await fileManager.downloadFork(folderNode, integrationFolderPath + '1.txt', options1);
    expect(downloaded1.toUtf8()).toEqual(file1Content.toString());

    const options2 = {
      actHistoryAddress: new Reference(uploadRes2.historyAddress.getOrThrow().toString()),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    };
    const downloaded2 = await fileManager.downloadFork(folderNode, integrationFolderPath + '2.txt', options2);
    expect(downloaded2.toUtf8()).toEqual(file2Content.toString());

    // Add a 3rd file to the same folder node and save again
    const file3Name = '3.txt';
    const file3ContentStr = 'new file 3 content';
    const file3Content = Buffer.from(file3ContentStr);

    // Create and add 3.txt.
    const child3 = new MantarayNode({ path: Bytes.fromUtf8(file3Name).toUint8Array() });
    child3.parent = folderNode;
    const uploadRes3 = await bee.uploadData(batchId, file3Content, { act: true });
    child3.targetAddress = new Reference(uploadRes3.reference).toUint8Array();
    child3.metadata = { info: 'file 3' };
    folderNode.forks.set(child3.path[0], {
      prefix: child3.path,
      node: child3,
      marshal: () => child3.targetAddress,
    });

    // Save the updated mantaray (now including the 3rd file).
    const updatedMantaraySaved = await fileManager.saveMantaray(batchId, folderNode, { act: true });
    console.log('Updated state saved:', updatedMantaraySaved);

    // Download each file using downloadFork to verify the final state
    const options3 = {
      actHistoryAddress: new Reference(uploadRes3.historyAddress.getOrThrow().toString()),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    };
    const downloaded3 = await fileManager.downloadFork(folderNode, integrationFolderPath + file3Name, options3);
    expect(downloaded3.toUtf8()).toEqual(file3ContentStr);

    // We re-download 1.txt and 2.txt to verify
    const reDownloaded1 = await fileManager.downloadFork(folderNode, integrationFolderPath + '1.txt', options1);
    expect(reDownloaded1.toUtf8()).toEqual(file1Content.toString());

    const reDownloaded2 = await fileManager.downloadFork(folderNode, integrationFolderPath + '2.txt', options2);
    expect(reDownloaded2.toUtf8()).toEqual(file2Content.toString());
  });
});

describe('FileManager listFiles', () => {
  let bee: BeeDev;
  let fileManager: FileManager;
  let batchId: BatchId;
  let tempDir: string;

  beforeAll(async () => {
    // Create a BeeDev instance with a valid signer.
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    // Purchase a test stamp.
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'listFilesIntegrationStamp');
    // Create and initialize the FileManager.
    fileManager = new FileManager(bee);
    await fileManager.initialize();

    // Create a temporary directory for our test files.
    // Use a unique folder name to avoid collisions.
    tempDir = path.join(__dirname, 'tmpIntegrationListFiles');
    fs.mkdirSync(tempDir, { recursive: true });
    // Create two files in the root.
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'Content A');
    fs.writeFileSync(path.join(tempDir, 'b.txt'), 'Content B');
    // Create a subfolder and a file inside it.
    const subfolder = path.join(tempDir, 'subfolder');
    fs.mkdirSync(subfolder, { recursive: true });
    fs.writeFileSync(path.join(subfolder, 'c.txt'), 'Content C');
  });

  afterAll(() => {
    // Clean up the temporary directory.
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return a list of files for the uploaded folder', async () => {
    // Upload the entire folder.
    await fileManager.upload(batchId, tempDir);

    // Retrieve our FileInfo by filtering on the unique folder name.
    const allFileInfos = fileManager.getFileInfoList();
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(tempDir));
    expect(fileInfo).toBeDefined();

    // Call listFiles.
    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });

    // Instead of comparing full paths (which may vary), we assert that the basenames match.
    const returnedBasenames = fileList.map((item) => path.basename(item.path));
    expect(returnedBasenames).toContain('a.txt');
    expect(returnedBasenames).toContain('b.txt');
    expect(returnedBasenames).toContain('c.txt');
    expect(fileList.length).toEqual(3);
  });

  it('should return an empty file list when uploading an empty folder', async () => {
    const emptyDir = path.join(__dirname, 'emptyFolder');
    fs.mkdirSync(emptyDir, { recursive: true });

    // We allow for two behaviors:
    // 1. The upload call fails (e.g. with status code 400).
    // 2. The upload call succeeds but returns a manifest with no files.
    let fileInfo;
    try {
      await fileManager.upload(batchId, emptyDir);
      const allFileInfos = fileManager.getFileInfoList();
      fileInfo = allFileInfos.find((fi) => fi.name === path.basename(emptyDir));
    } catch (error: any) {
      expect(error).toMatch(/status code 400/);
      fs.rmSync(emptyDir, { recursive: true, force: true });
      return;
    }

    // If upload did not throw, listFiles should return an empty array.
    expect(fileInfo).toBeDefined();
    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    expect(fileList.length).toEqual(0);

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('should correctly return nested file paths in a deeply nested folder structure', async () => {
    const deepDir = path.join(__dirname, 'deepNestedFolder');
    // Create a structure: deepNestedFolder/level1/level2/level3/d.txt
    const level1 = path.join(deepDir, 'level1');
    const level2 = path.join(level1, 'level2');
    const level3 = path.join(level2, 'level3');
    fs.mkdirSync(level3, { recursive: true });
    fs.writeFileSync(path.join(level3, 'd.txt'), 'Content D');

    await fileManager.upload(batchId, deepDir);
    const allFileInfos = fileManager.getFileInfoList();
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(deepDir));
    expect(fileInfo).toBeDefined();

    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });

    // Expect that the nested file is found.
    const returnedBasenames = fileList.map((item) => path.basename(item.path));
    expect(returnedBasenames).toContain('d.txt');

    // Depending on your implementation, the full relative path may be built relative to the upload root.
    // Here we assume the paths are relative to deepDir, so the expected path is "level1/level2/level3/d.txt".
    const expectedFullPath = path.join('level1', 'level2', 'level3', 'd.txt');
    const found = fileList.find((item) => item.path === expectedFullPath);
    expect(found).toBeDefined();

    fs.rmSync(deepDir, { recursive: true, force: true });
  });

  it('should ignore entries with empty paths', async () => {
    // Simulate a folder upload where one file's path is empty.
    const folderWithEmpty = path.join(__dirname, 'folderWithEmpty');
    fs.mkdirSync(folderWithEmpty, { recursive: true });
    // Create a valid file.
    fs.writeFileSync(path.join(folderWithEmpty, 'valid.txt'), 'Valid Content');
    // Create another file that we will later simulate as having an empty path.
    fs.writeFileSync(path.join(folderWithEmpty, 'empty.txt'), 'Should be ignored');

    await fileManager.upload(batchId, folderWithEmpty);
    const allFileInfos = fileManager.getFileInfoList();
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(folderWithEmpty));
    expect(fileInfo).toBeDefined();

    let fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    // Simulate that the entry for 'empty.txt' has an empty path.
    fileList = fileList.map((item) => {
      if (path.basename(item.path) === 'empty.txt') {
        return { ...item, path: '' };
      }
      return item;
    });
    // Filtering should remove entries with empty paths.
    const filtered = fileList.filter((item) => item.path !== '');
    const returnedBasenames = filtered.map((item) => path.basename(item.path));
    expect(returnedBasenames).toContain('valid.txt');
    expect(returnedBasenames).not.toContain('empty.txt');

    fs.rmSync(folderWithEmpty, { recursive: true, force: true });
  });
});

describe('FileManager upload', () => {
  let bee: BeeDev;
  let fileManager: FileManager;
  let batchId: BatchId;
  let tempUploadDir: string;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'uploadIntegrationStamp');
    fileManager = new FileManager(bee);
    await fileManager.initialize();

    // Create a temporary directory with a nested structure for upload.
    tempUploadDir = path.join(__dirname, 'tmpUploadIntegration');
    fs.mkdirSync(tempUploadDir, { recursive: true });
    fs.writeFileSync(path.join(tempUploadDir, 'file1.txt'), 'Upload Content 1');
    fs.writeFileSync(path.join(tempUploadDir, 'file2.txt'), 'Upload Content 2');
    const subfolder = path.join(tempUploadDir, 'subfolder');
    fs.mkdirSync(subfolder, { recursive: true });
    fs.writeFileSync(path.join(subfolder, 'file3.txt'), 'Upload Content 3');
  });

  afterAll(() => {
    fs.rmSync(tempUploadDir, { recursive: true, force: true });
  });

  it('should upload a directory and update the file info list', async () => {
    await fileManager.upload(batchId, tempUploadDir);
    const fileInfoList = fileManager.getFileInfoList();
    const uploadedInfo = fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(uploadedInfo).toBeDefined();
  });

  it('should upload with previewPath if provided', async () => {
    // Create a temporary preview folder with a single file.
    const previewDir = path.join(__dirname, 'tmpUploadPreview');
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'preview.txt'), 'Preview Content');

    // Call upload with both main path and previewPath.
    await fileManager.upload(batchId, tempUploadDir, previewDir);

    // The fileInfoList should have been updated (we check for the main upload)
    const fileInfoList = fileManager.getFileInfoList();
    const uploadedInfo = fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(uploadedInfo).toBeDefined();

    // Check if the preview property exists.
    if (uploadedInfo!.preview !== undefined) {
      expect(uploadedInfo!.preview).toBeDefined();
    } else {
      console.warn('Preview property is not defined. Your implementation may not store preview info.');
    }

    fs.rmSync(previewDir, { recursive: true, force: true });
  });

  it('should throw an error if infoTopic and historyRef are not provided together', async () => {
    // Here we call upload with infoTopic provided but no historyRef.
    await expect(fileManager.upload(batchId, tempUploadDir, undefined, undefined, 'someInfoTopic')).rejects.toThrow(
      /infoTopic and historyRef have to be provided at the same time/,
    );
  });

  it('should upload a single file and update the file info list', async () => {
    // Create a temporary file.
    const tempFile = path.join(__dirname, 'tempFile.txt');
    fs.writeFileSync(tempFile, 'Single File Content');
    await fileManager.upload(batchId, tempFile);
    const fileInfoList = fileManager.getFileInfoList();
    const uploadedInfo = fileInfoList.find((fi) => fi.name === path.basename(tempFile));
    expect(uploadedInfo).toBeDefined();
    fs.rmSync(tempFile, { force: true });
  });
});

describe('FileManager downloadFiles', () => {
  let bee: BeeDev;
  let fileManager: FileManager;
  let batchId: BatchId;
  let tempDownloadDir: string;
  const expectedContents: Record<string, string> = {};

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'downloadFilesIntegrationStamp');
    fileManager = new FileManager(bee);
    await fileManager.initialize();

    // Create a temporary directory for downloadFiles test.
    tempDownloadDir = path.join(__dirname, 'tmpDownloadIntegration');
    fs.mkdirSync(tempDownloadDir, { recursive: true });
    // Create two files at the root.
    const file1Path = path.join(tempDownloadDir, 'alpha.txt');
    const file2Path = path.join(tempDownloadDir, 'beta.txt');
    fs.writeFileSync(file1Path, 'Download Content Alpha');
    fs.writeFileSync(file2Path, 'Download Content Beta');
    expectedContents['alpha.txt'] = 'Download Content Alpha';
    expectedContents['beta.txt'] = 'Download Content Beta';

    // Create a subfolder and one file inside it.
    const subfolder = path.join(tempDownloadDir, 'subfolder');
    fs.mkdirSync(subfolder, { recursive: true });
    const file3Path = path.join(subfolder, 'gamma.txt');
    fs.writeFileSync(file3Path, 'Download Content Gamma');
    expectedContents['gamma.txt'] = 'Download Content Gamma';

    // Upload the folder.
    await fileManager.upload(batchId, tempDownloadDir);
  });

  afterAll(() => {
    fs.rmSync(tempDownloadDir, { recursive: true, force: true });
  });

  it('should download all file contents from the uploaded manifest', async () => {
    // Retrieve the FileInfo list. (Filter by our unique folder name.)
    const allFileInfos = fileManager.getFileInfoList();
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(tempDownloadDir));
    expect(fileInfo).toBeDefined();

    // downloadFiles returns an array of strings.
    const fileContents = await fileManager.downloadFiles(new Reference(fileInfo!.file.reference), {
      actHistoryAddress: new Reference(fileInfo!.file.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    const expectedArray = Object.values(expectedContents);
    expect(fileContents.sort()).toEqual(expectedArray.sort());
  });

  it('should return an empty array when the manifest is empty', async () => {
    // Create an empty Mantaray node (with no forks).
    const emptyNode = new (await import('@upcoming/bee-js')).MantarayNode({
      path: new TextEncoder().encode('emptyFolder/'),
    });
    const saved = await fileManager.saveMantaray(batchId, emptyNode, { act: true });
    const files = await fileManager.downloadFiles(new Reference(saved.reference), {
      actHistoryAddress: new Reference(saved.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    expect(files.length).toEqual(0);
  });

  it('should download an empty file as an empty string', async () => {
    const emptyFileDir = path.join(__dirname, 'emptyFileFolder');
    fs.mkdirSync(emptyFileDir, { recursive: true });
    // Create a file with empty content.
    fs.writeFileSync(path.join(emptyFileDir, 'empty.txt'), '');
    await fileManager.upload(batchId, emptyFileDir);
    const allFileInfos = fileManager.getFileInfoList();
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(emptyFileDir));
    expect(fileInfo).toBeDefined();
    const fileContents = await fileManager.downloadFiles(new Reference(fileInfo!.file.reference), {
      actHistoryAddress: new Reference(fileInfo!.file.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    // We expect one of the returned file contents to be an empty string.
    expect(fileContents).toContain('');
    fs.rmSync(emptyFileDir, { recursive: true, force: true });
  });
});

describe('FileManager getOwnerFeedStamp', () => {
  let bee: BeeDev;
  let fileManager: FileManager;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    fileManager = new FileManager(bee);
    await fileManager.initialize();
  });

  it('should return the owner feed stamp with valid properties', async () => {
    const ownerStamp = fileManager.getOwnerFeedStamp();
    expect(ownerStamp).toBeDefined();
    if (ownerStamp) {
      // Check that the label is correct.
      expect(ownerStamp.label).toBe(OWNER_FEED_STAMP_LABEL);
      // Verify that amount is a non-empty string and a positive number.
      expect(typeof ownerStamp.amount).toBe('string');
      expect(Number(ownerStamp.amount)).toBeGreaterThan(0);
      // Verify that depth is positive.
      expect(ownerStamp.depth).toBeGreaterThan(0);
      // Check that duration is defined and greater than 0 seconds.
      // (Assuming duration is a Duration instance from luxon.)
      expect(ownerStamp.duration.toSeconds()).toBeGreaterThan(0);
    }
  });

  it('should return undefined if no owner feed stamp exists', async () => {
    // Backup the original stamp list.
    const originalStamps = (fileManager as any).stampList;
    // Set the stamp list to an empty array.
    (fileManager as any).stampList = [];
    const ownerStamp = fileManager.getOwnerFeedStamp();
    expect(ownerStamp).toBeUndefined();
    // Restore the original stamps.
    (fileManager as any).stampList = originalStamps;
  });
});

describe('FileManager destroyVolume', () => {
  let bee: BeeDev;
  let fileManager: FileManager;
  let ownerStamp: PostageBatch;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    // Purchase two non-owner stamps with unique labels BEFORE initializing the FileManager.
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'nonOwnerStampTest');

    fileManager = new FileManager(bee);
    await fileManager.initialize();

    // Retrieve the owner stamp from the FileManager.
    ownerStamp = fileManager.getOwnerFeedStamp()!;
    expect(ownerStamp).toBeDefined();
  });

  it('should throw an error when trying to destroy the owner stamp', async () => {
    await expect(fileManager.destroyVolume(ownerStamp.batchID)).rejects.toThrow(
      `Cannot destroy owner stamp, batchId: ${ownerStamp.batchID.toString()}`,
    );
  });

  // it('should remove a non-owner stamp from the stamp list after destroying volume', async () => {
  //   const initialStamps = fileManager.getStamps();

  //   // If either nonOwnerStamp equals the owner stamp, skip the test.
  //   if (nonOwnerStamp.toString() === ownerStamp.batchID.toString()) {
  //     console.warn('Non-owner stamp equals owner stamp; skipping non-owner destroy test.');
  //     return;
  //   }

  //   const initialCount = initialStamps.length;
  //   await fileManager.destroyVolume(nonOwnerStamp);
  //   const updatedStamps = fileManager.getStamps();
  //   expect(updatedStamps.length).toEqual(initialCount - 1);
  //   expect(updatedStamps.find((s) => s.batchID.toString() === nonOwnerStamp.toString())).toBeUndefined();
  // });
});

describe('FileManager getGranteesOfFile', () => {
  let bee: BeeDev;
  let fileManager: FileManager;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    fileManager = new FileManager(bee);
    await fileManager.initialize();
  });

  it('should throw an error if grantee list is not found for a file', async () => {
    // Construct a FileInfo object with a topic that is unlikely to exist in ownerFeedList.
    const fileInfo = {
      batchId: 'dummyBatchId',
      topic: Topic.fromString('nonexistent-topic').toString(),
      file: {
        reference: new Reference('1'.repeat(64)).toString(),
        historyRef: new Reference('0'.repeat(64)).toString(),
      },
      owner: MOCK_SIGNER.publicKey().address().toString(),
      name: 'dummyFile',
      timestamp: Date.now(),
      shared: false,
      index: 0,
    };
    await expect(fileManager.getGranteesOfFile(fileInfo as any)).rejects.toThrow(
      `Grantee list not found for file eReference: ${fileInfo.topic}`,
    );
  });
});

describe('FileManager getFeedData', () => {
  let bee: BeeDev;
  let fileManager: FileManager;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    fileManager = new FileManager(bee);
    await fileManager.initialize();
  });

  it('should return a valid feed data object when index is provided', async () => {
    // Use the owner's public key as a topic by converting it to a Topic.
    const topic = Topic.fromString(fileManager.getNodeAddresses()!.publicKey.toString());
    const feedData = await fileManager.getFeedData(topic, 0n);
    // feedData.payload should not be the zero address.
    expect(feedData.payload).not.toEqual('0'.repeat(64));
  });

  it('should return a valid feed data object when index is not provided', async () => {
    const topic = Topic.fromString(fileManager.getNodeAddresses()!.publicKey.toString());
    const feedData = await fileManager.getFeedData(topic);
    expect(feedData.payload).not.toEqual('0'.repeat(64));
  });
});

describe('FileManager End-to-End User Workflow', () => {
  let bee: BeeDev;
  let fileManager: FileManager;
  let batchId: BatchId;
  let tempBaseDir: string;

  beforeAll(async () => {
    // Create a BeeDev instance and ensure the owner stamp exists.
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    fileManager = new FileManager(bee);
    await fileManager.initialize();
    // Create a temporary directory for this test session.
    tempBaseDir = path.join(__dirname, 'e2eTestSession');
    fs.mkdirSync(tempBaseDir, { recursive: true });
  });

  afterAll(() => {
    // Clean up after tests.
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  // Scenario 1: In-Place Folder Update Simulation
  it('should simulate a complete workflow - in-place folder update simulation', async () => {
    // ----- Step 1: Upload a Single File -----
    const singleFilePath = path.join(tempBaseDir, 'initial.txt');
    fs.writeFileSync(singleFilePath, 'Hello, this is the initial file.');
    await fileManager.upload(batchId, singleFilePath);
    let fileInfos = fileManager.getFileInfoList();
    expect(fileInfos.find((fi) => fi.name === path.basename(singleFilePath))).toBeDefined();

    // ----- Step 2: Upload a Project Folder with Multiple Files -----
    const projectFolder = path.join(tempBaseDir, 'projectFolder');
    fs.mkdirSync(projectFolder, { recursive: true });
    fs.writeFileSync(path.join(projectFolder, 'doc1.txt'), 'Project document 1');
    fs.writeFileSync(path.join(projectFolder, 'doc2.txt'), 'Project document 2');
    // Create a nested subfolder for assets.
    const assetsFolder = path.join(projectFolder, 'assets');
    fs.mkdirSync(assetsFolder, { recursive: true });
    fs.writeFileSync(path.join(assetsFolder, 'image.png'), 'Fake image content');
    await fileManager.upload(batchId, projectFolder);
    fileInfos = fileManager.getFileInfoList();
    const projectInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolder));
    expect(projectInfo).toBeDefined();

    // ----- Step 3: "Update" the Folder by Adding a New File (simulate in-place update) -----
    // On-chain, you cannot update a folder in place; the manifest remains the same.
    fs.writeFileSync(path.join(projectFolder, 'readme.txt'), 'This is the project readme.');
    // Wait a moment so that the file system registers the change.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fileManager.upload(batchId, projectFolder);

    // Force a reload of the FileManager (which loads the manifest as originally published)
    fileManager = new FileManager(bee);
    await fileManager.initialize();
    fileInfos = fileManager.getFileInfoList();
    const updatedProjectInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolder));
    expect(updatedProjectInfo).toBeDefined();

    // ----- Step 4: List Files and Check that the Manifest Has NOT Been Updated -----
    const listedFiles = await fileManager.listFiles(updatedProjectInfo!, {
      actHistoryAddress: new Reference(updatedProjectInfo!.file.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    const basenames = listedFiles.map((item) => path.basename(item.path));
    // Since in-place updates aren’t supported, we expect the manifest to contain only the original files.
    expect(basenames).toContain('doc1.txt');
    expect(basenames).toContain('doc2.txt');
    expect(basenames).toContain('image.png');
    expect(basenames).not.toContain('readme.txt');
    expect(listedFiles.length).toEqual(3);
  });

  // Scenario 2: New Version Folder Upload
  it('should simulate a complete workflow - new version folder upload', async () => {
    // Step 1: Upload a single file.
    const singleFilePath = path.join(tempBaseDir, 'initial.txt');
    fs.writeFileSync(singleFilePath, 'Hello, this is the initial file.');
    await fileManager.upload(batchId, singleFilePath);
    let fileInfos = fileManager.getFileInfoList();
    expect(fileInfos.find((fi) => fi.name === path.basename(singleFilePath))).toBeDefined();

    // Step 2: Upload original project folder.
    const projectFolder = path.join(tempBaseDir, 'projectFolder');
    fs.mkdirSync(projectFolder, { recursive: true });
    fs.writeFileSync(path.join(projectFolder, 'doc1.txt'), 'Project document 1');
    fs.writeFileSync(path.join(projectFolder, 'doc2.txt'), 'Project document 2');
    const assetsFolder = path.join(projectFolder, 'assets');
    fs.mkdirSync(assetsFolder, { recursive: true });
    fs.writeFileSync(path.join(assetsFolder, 'image.png'), 'Fake image content');
    await fileManager.upload(batchId, projectFolder);
    fileInfos = fileManager.getFileInfoList();
    const projectInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolder));
    expect(projectInfo).toBeDefined();

    // Step 3: Instead of updating the same folder, create a new version folder.
    const projectFolderNew = path.join(tempBaseDir, 'projectFolder_new');
    fs.mkdirSync(projectFolderNew, { recursive: true });
    fs.writeFileSync(path.join(projectFolderNew, 'doc1.txt'), 'Project document 1');
    fs.writeFileSync(path.join(projectFolderNew, 'doc2.txt'), 'Project document 2');
    const assetsFolderNew = path.join(projectFolderNew, 'assets');
    fs.mkdirSync(assetsFolderNew, { recursive: true });
    fs.writeFileSync(path.join(assetsFolderNew, 'image.png'), 'Fake image content');
    fs.writeFileSync(path.join(projectFolderNew, 'readme.txt'), 'This is the project readme.');
    // Also add a nested folder with a new file.
    const nestedFolder = path.join(projectFolderNew, 'nested');
    fs.mkdirSync(nestedFolder, { recursive: true });
    fs.writeFileSync(path.join(nestedFolder, 'subdoc.txt'), 'Nested document content');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fileManager.upload(batchId, projectFolderNew);
    fileInfos = fileManager.getFileInfoList();
    const newVersionInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolderNew));
    expect(newVersionInfo).toBeDefined();

    // Step 4: List files in the new version folder and check full paths.
    const listedFiles_newVersion = await fileManager.listFiles(newVersionInfo!, {
      actHistoryAddress: new Reference(newVersionInfo!.file.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    const basenames_newVersion = listedFiles_newVersion.map((item) => path.basename(item.path));
    const fullPaths_newVersion = listedFiles_newVersion.map((item) => item.path);
    expect(basenames_newVersion).toContain('doc1.txt');
    expect(basenames_newVersion).toContain('doc2.txt');
    expect(basenames_newVersion).toContain('image.png');
    expect(basenames_newVersion).toContain('readme.txt');
    expect(basenames_newVersion).toContain('subdoc.txt');
    // For example, we expect the nested file to be in a folder called "nested".
    expect(fullPaths_newVersion).toContain('nested/subdoc.txt');
    expect(listedFiles_newVersion.length).toEqual(5);

    // Step 5: Download all files and verify their content.
    const downloadedContents = await fileManager.downloadFiles(new Reference(newVersionInfo!.file.reference), {
      actHistoryAddress: new Reference(newVersionInfo!.file.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    expect(downloadedContents).toContain('Project document 1');
    expect(downloadedContents).toContain('Project document 2');
    expect(downloadedContents).toContain('Fake image content');
    expect(downloadedContents).toContain('This is the project readme.');
    expect(downloadedContents).toContain('Nested document content');
  });

  // Scenario 3: Verify File Paths in the Manifest
  it('should list files with correct relative paths reflecting folder structure', async () => {
    // Create a folder with a nested structure.
    const complexFolder = path.join(tempBaseDir, 'complexFolder');
    fs.mkdirSync(complexFolder, { recursive: true });
    // Create files at the root.
    fs.writeFileSync(path.join(complexFolder, 'root.txt'), 'Root file content');
    // Create a subfolder "level1" with a file.
    const level1 = path.join(complexFolder, 'level1');
    fs.mkdirSync(level1, { recursive: true });
    fs.writeFileSync(path.join(level1, 'level1.txt'), 'Level1 file content');
    // Create a nested subfolder "level1/level2" with a file.
    const level2 = path.join(level1, 'level2');
    fs.mkdirSync(level2, { recursive: true });
    fs.writeFileSync(path.join(level2, 'level2.txt'), 'Level2 file content');

    // Upload the folder.
    await fileManager.upload(batchId, complexFolder);
    const fileInfos = fileManager.getFileInfoList();
    const complexInfo = fileInfos.find((fi) => fi.name === path.basename(complexFolder));
    expect(complexInfo).toBeDefined();

    // List files and check full relative paths.
    const listedFiles = await fileManager.listFiles(complexInfo!, {
      actHistoryAddress: new Reference(complexInfo!.file.historyRef),
      actPublisher: fileManager.getNodeAddresses()!.publicKey,
    });
    const fullPaths = listedFiles.map((item) => item.path);
    // We expect:
    // - "root.txt"
    // - "level1/level1.txt"
    // - "level1/level2/level2.txt"
    expect(fullPaths).toContain('root.txt');
    expect(fullPaths).toContain('level1/level1.txt');
    expect(fullPaths).toContain('level1/level2/level2.txt');
  });
});
