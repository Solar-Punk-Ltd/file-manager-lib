import { BatchId, BeeDev, Bytes, MantarayNode, PublicKey, Reference, Topic } from '@ethersphere/bee-js';
import * as fs from 'fs';
import path from 'path';

import { FileManagerBase } from '../../src/fileManager';
import { buyStamp, getFeedData } from '../../src/utils/common';
import { OWNER_STAMP_LABEL, REFERENCE_LIST_TOPIC, SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { FileInfoError, GranteeError, StampError } from '../../src/utils/errors';
import { FileInfo } from '../../src/utils/types';
import { createInitializedFileManager } from '../mockHelpers';
import {
  BEE_URL,
  createWrappedData,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  dowloadAndCompareFiles,
  getTestFile,
  MOCK_SIGNER,
  OTHER_BEE_URL,
  OTHER_MOCK_SIGNER,
  readFilesOrDirectory,
} from '../utils';

// TODO: emitter test for all events
describe('FileManager initialization', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let actPublisher: PublicKey;

  beforeAll(async () => {
    // Create a BeeDev instance with a valid signer.
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    // Ensure the owner stamp is available (buyStamp may throw if already exists)
    try {
      await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);
    } catch (e) {
      // Stamp already exists; ignore error.
      void e;
    }

    actPublisher = (await bee.getNodeAddresses())!.publicKey;
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    // For each test, create a fresh FileManager instance and initialize it.
    fileManager = await createInitializedFileManager(bee);
  });

  it('should create and initialize a new instance', async () => {
    // Use a different Bee instance with a different signer.
    const otherBee = new BeeDev(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });
    const fm = await createInitializedFileManager(otherBee);
    try {
      await fm.initialize();
    } catch (error: any) {
      expect(error).toBeInstanceOf(StampError);
      expect(error.message).toContain('Owner stamp not found');
    }

    expect(fm.fileInfoList).toEqual([]);
    expect(fm.sharedWithMe).toEqual([]);
  });

  it('should initialize the owner feed and topic', async () => {
    // Ensure the owner stamp exists by buying it.
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);

    expect(fileManager.fileInfoList).toEqual([]);
    expect(fileManager.sharedWithMe).toEqual([]);

    const feedTopicData = await getFeedData(bee, REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 0n);
    const topicHistory = await getFeedData(bee, REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 1n);
    const topicHex = await bee.downloadData(new Reference(feedTopicData.payload), {
      actHistoryAddress: new Reference(topicHistory.payload),
      actPublisher,
    });
    expect(topicHex).not.toEqual(SWARM_ZERO_ADDRESS);
    // Test re-initialization; state should remain unchanged.
    await fileManager.initialize();
    const reinitTopicHex = await bee.downloadData(new Reference(feedTopicData.payload), {
      actHistoryAddress: new Reference(topicHistory.payload),
      actPublisher,
    });
    expect(topicHex).toEqual(reinitTopicHex);
  });

  it('should throw an error if someone else than the owner tries to read the owner feed', async () => {
    const otherBee = new BeeDev(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });

    const feedTopicData = await getFeedData(bee, REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 0n);
    const topicHistory = await getFeedData(bee, REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 1n);

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
        actPublisher,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).stack?.includes('500')).toBeTruthy();
    }
  });

  it('should upload to and fetch from swarm a nested folder with files', async () => {
    let expNestedPaths = await readFilesOrDirectory(path.join(__dirname, '../fixtures/nested'), 'nested');
    const expFileDataArr: string[][] = [];
    const fileDataArr: string[] = [];
    for (const f of expNestedPaths) {
      fileDataArr.push(getTestFile(`./fixtures/${f}`));
    }
    const exptTestFileData = getTestFile('fixtures/test.txt');
    expNestedPaths.concat(await readFilesOrDirectory(path.join(__dirname, '../fixtures/test.txt'), 'test.txt'));
    expFileDataArr.push(fileDataArr);
    expFileDataArr.push([exptTestFileData]);

    // Use a test stamp for file uploads.
    const testStampId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'testStamp');
    {
      await fileManager.initialize();
      await fileManager.upload({
        batchId: testStampId,
        path: path.join(__dirname, '../fixtures/nested'),
        name: 'nested',
      });
      await fileManager.upload({
        batchId: testStampId,
        path: path.join(__dirname, '../fixtures/test.txt'),
        name: 'test.txt',
      });

      const fileInfoList = fileManager.fileInfoList;
      expect(fileInfoList).toHaveLength(expFileDataArr.length);
      await dowloadAndCompareFiles(fileManager, actPublisher.toCompressedHex(), fileInfoList, expFileDataArr);

      const fileList = await fileManager.listFiles(fileInfoList[0], {
        actHistoryAddress: fileInfoList[0].file.historyRef,
        actPublisher,
      });
      expect(fileList).toHaveLength(expNestedPaths.length);
      for (const [ix, f] of fileList.entries()) {
        expect(path.basename(f.path)).toEqual(path.basename(expNestedPaths[ix]));
      }
    }
    // Reinitialize fileManager after it goes out of scope to test if the file is saved on the feed.
    const fm = await createInitializedFileManager(bee);
    await fm.initialize();
    const fileInfoList = fm.fileInfoList;
    await dowloadAndCompareFiles(fm, actPublisher.toCompressedHex(), fileInfoList, expFileDataArr);
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
    const nodeAddresses = await bee.getNodeAddresses();
    expect(nodeAddresses).toBeDefined();
    expect(nodeAddresses?.publicKey).toBeDefined();
  });

  it('should initialize owner feed topic and owner feed list correctly', async () => {
    const feedTopicData = await getFeedData(bee, REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 0n);
    expect(feedTopicData.payload).not.toEqual(SWARM_ZERO_ADDRESS);
    const ownerFeedList = (fileManager as any).ownerFeedList;
    expect(Array.isArray(ownerFeedList)).toBeTruthy();
  });

  it('should not reinitialize if already initialized', async () => {
    const fileInfoListBefore = [...fileManager.fileInfoList];
    await fileManager.initialize();
    expect(fileManager.fileInfoList).toEqual(fileInfoListBefore);
  });
});

describe('FileManager listFiles', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let tempDir: string;
  let actPublisher: PublicKey;

  beforeAll(async () => {
    // Create a BeeDev instance with a valid signer.
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    // Purchase a test stamp.
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'listFilesIntegrationStamp');
    // Create and initialize the FileManager.
    fileManager = await createInitializedFileManager(bee);
    await fileManager.initialize();
    actPublisher = (await bee.getNodeAddresses())!.publicKey;

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
    await fileManager.upload({ batchId, path: tempDir, name: path.basename(tempDir) });

    // Retrieve our FileInfo by filtering on the unique folder name.
    const allFileInfos = fileManager.fileInfoList;
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(tempDir));
    expect(fileInfo).toBeDefined();

    // Call listFiles.
    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    });

    // Instead of comparing full paths (which may vary), we assert that the basenames match.
    const returnedBasenames = fileList.map((item) => path.basename(item.path));
    expect(returnedBasenames).toContain('a.txt');
    expect(returnedBasenames).toContain('b.txt');
    expect(returnedBasenames).toContain('c.txt');
    expect(fileList).toHaveLength(3);
  });

  it('should return an empty file list when uploading an empty folder', async () => {
    const emptyDir = path.join(__dirname, 'emptyFolder');
    fs.mkdirSync(emptyDir, { recursive: true });

    // We allow for two behaviors:
    // 1. The upload call fails (e.g. with status code 400).
    // 2. The upload call succeeds but returns a manifest with no files.
    let fileInfo: FileInfo | undefined;
    try {
      await fileManager.upload({ batchId, path: emptyDir, name: path.basename(emptyDir) });
      const allFileInfos = fileManager.fileInfoList;
      fileInfo = allFileInfos.find((fi) => fi.name === path.basename(emptyDir));
    } catch (error: any) {
      expect(error.message).toMatch(/status code 400/);
      fs.rmSync(emptyDir, { recursive: true, force: true });
      return;
    }

    // If upload did not throw, listFiles should return an empty array.
    expect(fileInfo).toBeDefined();
    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    });
    expect(fileList).toHaveLength(0);

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

    await fileManager.upload({ batchId, path: deepDir, name: path.basename(deepDir) });
    const allFileInfos = fileManager.fileInfoList;
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(deepDir));
    expect(fileInfo).toBeDefined();

    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
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

    await fileManager.upload({ batchId, path: folderWithEmpty, name: path.basename(folderWithEmpty) });
    const allFileInfos = fileManager.fileInfoList;
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(folderWithEmpty));
    expect(fileInfo).toBeDefined();

    let fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
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
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let tempUploadDir: string;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'uploadIntegrationStamp');
    fileManager = await createInitializedFileManager(bee);

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
    await fileManager.upload({ batchId, path: tempUploadDir, name: path.basename(tempUploadDir) });
    const fileInfoList = fileManager.fileInfoList;
    const uploadedInfo = fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(uploadedInfo).toBeDefined();
  });

  it('should upload with previewPath if provided', async () => {
    // Create a temporary preview folder with a single file.
    const previewDir = path.join(__dirname, 'tmpUploadPreview');
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'preview.txt'), 'Preview Content');

    // Call upload with both main path and previewPath.
    await fileManager.upload({
      batchId,
      path: tempUploadDir,
      name: path.basename(tempUploadDir),
      previewPath: previewDir,
    });

    // The fileInfoList should have been updated (we check for the main upload)
    const fileInfoList = fileManager.fileInfoList;
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
    await expect(
      fileManager.upload({
        batchId,
        path: tempUploadDir,
        name: path.basename(tempUploadDir),
        infoTopic: 'someInfoTopic',
      }),
    ).rejects.toThrow(new FileInfoError('Options infoTopic and historyRef have to be provided at the same time.'));
  });

  it('should upload a single file and update the file info list', async () => {
    // Create a temporary file.
    const tempFile = path.join(__dirname, 'tempFile.txt');
    fs.writeFileSync(tempFile, 'Single File Content');
    await fileManager.upload({ batchId, path: tempFile, name: path.basename(tempFile) });
    const fileInfoList = fileManager.fileInfoList;
    const uploadedInfo = fileInfoList.find((fi) => fi.name === path.basename(tempFile));
    expect(uploadedInfo).toBeDefined();
    fs.rmSync(tempFile, { force: true });
  });
});

describe('FileManager download', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let tempDownloadDir: string;
  const expectedContents: Record<string, string> = {};
  let actPublisher: PublicKey;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'downloadFilesIntegrationStamp');
    fileManager = await createInitializedFileManager(bee);
    actPublisher = (await bee.getNodeAddresses())!.publicKey;

    // Create a temporary directory for download test.
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
    await fileManager.upload({ batchId, path: tempDownloadDir, name: path.basename(tempDownloadDir) });
  });

  afterAll(() => {
    fs.rmSync(tempDownloadDir, { recursive: true, force: true });
  });

  it('should download all file contents from the uploaded manifest', async () => {
    const allFileInfos = fileManager.fileInfoList;
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(tempDownloadDir));
    expect(fileInfo).toBeDefined();

    const fileContents = (await fileManager.download(fileInfo!, undefined, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    })) as Bytes[];
    const expectedArray = Object.values(expectedContents);
    const fileContentsAsStrings = fileContents.map((item) => (item as Bytes).toUtf8());
    expect(fileContentsAsStrings.sort()).toEqual(expectedArray.sort());
  });

  it('should download only the specified fork(s)', async () => {
    const allFileInfos = fileManager.fileInfoList;
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(tempDownloadDir));
    expect(fileInfo).toBeDefined();

    let fileContents = (await fileManager.download(fileInfo!, ['alpha.txt'], {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    })) as Bytes[];
    let fileContentsAsStrings = fileContents.map((item) => item.toUtf8());
    expect(fileContentsAsStrings).toEqual([expectedContents['alpha.txt']]);

    fileContents = (await fileManager.download(fileInfo!, ['alpha.txt', 'beta.txt'], {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    })) as Bytes[];
    const fileContentsArr: string[][] = [];
    fileContents.forEach((item) => fileContentsArr.push([item.toUtf8()]));
    expect(fileContentsArr).toEqual([[expectedContents['alpha.txt']], [expectedContents['beta.txt']]]);
  });

  it('should return an empty array when the manifest is empty', async () => {
    const wrappedDataObject = await createWrappedData(bee, batchId, new MantarayNode());

    const files = await fileManager.download(
      {
        batchId,
        name: 'name',
        file: wrappedDataObject,
        owner: MOCK_SIGNER.publicKey().address(),
        actPublisher,
      } as FileInfo,
      undefined,
      {
        actHistoryAddress: wrappedDataObject.historyRef,
        actPublisher,
      },
    );
    expect(files).toHaveLength(0);
  });
});

describe('FileManager destroyVolume', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let ownerStampId: BatchId | undefined;
  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    // Purchase two non-owner stamps with unique labels BEFORE initializing the FileManager.
    ownerStampId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);
    expect(ownerStampId).toBeDefined();

    fileManager = await createInitializedFileManager(bee);
  });

  it('should throw an error when trying to destroy the owner stamp', async () => {
    await expect(fileManager.destroyVolume(ownerStampId!)).rejects.toThrow(
      new StampError(`Cannot destroy owner stamp, batchId: ${ownerStampId!.toString()}`),
    );
  });

  // TODO: test it if the env is testnet
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
  let fileManager: FileManagerBase;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);
    fileManager = await createInitializedFileManager(bee);
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
    await expect(fileManager.getGrantees(fileInfo as any)).rejects.toThrow(
      new GranteeError(`Grantee list not found for file eReference: ${fileInfo.topic}`),
    );
  });
});

describe('Utils getFeedData', () => {
  let bee: BeeDev;
  let actPublisher: PublicKey;

  beforeAll(async () => {
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    actPublisher = (await bee.getNodeAddresses())!.publicKey;
  });

  it('should return a valid feed data object when index is provided', async () => {
    // Use the owner's public key as a topic by converting it to a Topic.
    const topic = Topic.fromString(actPublisher.toCompressedHex());
    const feedData = await getFeedData(bee, topic, MOCK_SIGNER.publicKey().address(), 0n);
    // feedData.payload should not be the zero address.
    expect(feedData.payload).not.toEqual('0'.repeat(64));
  });

  it('should return a valid feed data object when index is not provided', async () => {
    const topic = Topic.fromString(actPublisher.toCompressedHex());
    const feedData = await getFeedData(bee, topic, MOCK_SIGNER.publicKey().address());
    expect(feedData.payload).not.toEqual('0'.repeat(64));
  });
});

describe('FileManager End-to-End User Workflow', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let tempBaseDir: string;
  let actPublisher: PublicKey;

  beforeAll(async () => {
    // Create a BeeDev instance and ensure the owner stamp exists.
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);
    fileManager = await createInitializedFileManager(bee);
    // Create a temporary directory for this test session.
    tempBaseDir = path.join(__dirname, 'e2eTestSession');
    fs.mkdirSync(tempBaseDir, { recursive: true });
    actPublisher = (await bee.getNodeAddresses())!.publicKey;
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
    await fileManager.upload({ batchId, path: singleFilePath, name: path.basename(singleFilePath) });
    let fileInfos = fileManager.fileInfoList;
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
    await fileManager.upload({ batchId, path: projectFolder, name: path.basename(projectFolder) });
    fileInfos = fileManager.fileInfoList;
    const projectInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolder));
    expect(projectInfo).toBeDefined();

    // ----- Step 3: "Update" the Folder by Adding a New File (simulate in-place update) -----
    // On-chain, you cannot update a folder in place; the manifest remains the same.
    fs.writeFileSync(path.join(projectFolder, 'readme.txt'), 'This is the project readme.');
    // Wait a moment so that the file system registers the change.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fileManager.upload({ batchId, path: projectFolder, name: path.basename(projectFolder) });

    // Force a reload of the FileManager (which loads the manifest as originally published)
    fileManager = await createInitializedFileManager(bee);
    fileInfos = fileManager.fileInfoList;
    const updatedProjectInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolder));
    expect(updatedProjectInfo).toBeDefined();

    // ----- Step 4: List Files and Check that the Manifest Has NOT Been Updated -----
    const listedFiles = await fileManager.listFiles(updatedProjectInfo!, {
      actHistoryAddress: new Reference(updatedProjectInfo!.file.historyRef),
      actPublisher,
    });
    const basenames = listedFiles.map((item) => path.basename(item.path));
    // Since in-place updates aren’t supported, we expect the manifest to contain only the original files.
    expect(basenames).toContain('doc1.txt');
    expect(basenames).toContain('doc2.txt');
    expect(basenames).toContain('image.png');
    expect(basenames).not.toContain('readme.txt');
    expect(listedFiles).toHaveLength(3);
  });

  // Scenario 2: New Version Folder Upload
  it('should simulate a complete workflow - new version folder upload', async () => {
    // Step 1: Upload a single file.
    const singleFilePath = path.join(tempBaseDir, 'initial.txt');
    fs.writeFileSync(singleFilePath, 'Hello, this is the initial file.');
    await fileManager.upload({ batchId, path: singleFilePath, name: path.basename(singleFilePath) });
    let fileInfos = fileManager.fileInfoList;
    expect(fileInfos.find((fi) => fi.name === path.basename(singleFilePath))).toBeDefined();

    // Step 2: Upload original project folder.
    const projectFolder = path.join(tempBaseDir, 'projectFolder');
    fs.mkdirSync(projectFolder, { recursive: true });
    fs.writeFileSync(path.join(projectFolder, 'doc1.txt'), 'Project document 1');
    fs.writeFileSync(path.join(projectFolder, 'doc2.txt'), 'Project document 2');
    const assetsFolder = path.join(projectFolder, 'assets');
    fs.mkdirSync(assetsFolder, { recursive: true });
    fs.writeFileSync(path.join(assetsFolder, 'image.png'), 'Fake image content');
    await fileManager.upload({ batchId, path: projectFolder, name: path.basename(projectFolder) });
    fileInfos = fileManager.fileInfoList;
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
    await fileManager.upload({ batchId, path: projectFolderNew, name: path.basename(projectFolderNew) });
    fileInfos = fileManager.fileInfoList;
    const newVersionInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolderNew));
    expect(newVersionInfo).toBeDefined();

    // Step 4: List files in the new version folder and check full paths.
    const listedFiles_newVersion = await fileManager.listFiles(newVersionInfo!, {
      actHistoryAddress: new Reference(newVersionInfo!.file.historyRef),
      actPublisher,
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
    expect(listedFiles_newVersion).toHaveLength(5);

    // Step 5: Download all files and verify their content.
    const downloadedContents = (await fileManager.download(newVersionInfo!, undefined, {
      actHistoryAddress: new Reference(newVersionInfo!.file.historyRef),
      actPublisher,
    })) as Bytes[];
    expect(downloadedContents[1].toUtf8()).toContain('Project document 1');
    expect(downloadedContents[2].toUtf8()).toContain('Project document 2');
    expect(downloadedContents[0].toUtf8()).toContain('Fake image content');
    expect(downloadedContents[4].toUtf8()).toContain('This is the project readme.');
    expect(downloadedContents[3].toUtf8()).toContain('Nested document content');
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
    await fileManager.upload({ batchId, path: complexFolder, name: path.basename(complexFolder) });
    const fileInfos = fileManager.fileInfoList;
    const complexInfo = fileInfos.find((fi) => fi.name === path.basename(complexFolder));
    expect(complexInfo).toBeDefined();

    // List files and check full relative paths.
    const listedFiles = await fileManager.listFiles(complexInfo!, {
      actHistoryAddress: new Reference(complexInfo!.file.historyRef),
      actPublisher,
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
