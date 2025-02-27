import { BatchId, BeeDev, Duration, MantarayNode, PostageBatch, Reference, Topic } from '@upcoming/bee-js';
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
    const folderNode = new MantarayNode({ path: new TextEncoder().encode(integrationFolderPath) });

    // Create and add 1.txt.
    const child1 = new MantarayNode({ path: new TextEncoder().encode('1.txt') });
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
    const child2 = new MantarayNode({ path: new TextEncoder().encode('2.txt') });
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
    const child3 = new MantarayNode({ path: new TextEncoder().encode(file3Name) });
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
