import {
  BatchId,
  BeeDev,
  Bytes,
  FeedIndex,
  Identifier,
  MantarayNode,
  PostageBatch,
  PrivateKey,
  PublicKey,
  RedundancyLevel,
  Reference,
  Topic,
} from '@ethersphere/bee-js';
import * as fs from 'fs';
import path from 'path';

import { FileManagerBase } from '../../src/fileManager';
import { buyStamp, getFeedData } from '../../src/utils/common';
import { FEED_INDEX_ZERO, FILEMANAGER_STATE_TOPIC, SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { DriveError, FileError, FileInfoError, GranteeError, StampError } from '../../src/utils/errors';
import { FileManagerEvents } from '../../src/utils/events';
import { DriveInfo, FileInfo, FileStatus } from '../../src/utils/types';
import { createInitializedFileManager, MOCK_BATCH_ID } from '../mockHelpers';
import {
  createWrappedData,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  dowloadAndCompareFiles,
  getTestFile,
  OTHER_BEE_URL,
  OTHER_MOCK_SIGNER,
  readFilesOrDirectory,
} from '../utils';

import { ensureUniqueSignerWithStamp } from './testSetupHelpers';

// TODO: emitter test for all events
// TODO: separate IT cases into different files
describe('FileManager initialization', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let actPublisher: PublicKey;
  let drive: DriveInfo;
  let adminBatchId: BatchId;
  let signer: PrivateKey;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp, signer: newSigner } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    adminBatchId = ownerStamp;
    signer = newSigner;
    fileManager = await createInitializedFileManager(bee, adminBatchId);
    actPublisher = (await bee.getNodeAddresses()).publicKey;
  });

  beforeEach(async () => {
    jest.resetAllMocks();
  });

  it('should create and initialize a new instance and check if admin stamp is not found', async () => {
    expect(fileManager.fileInfoList).toEqual([]);
    expect(fileManager.sharedWithMe).toEqual([]);

    const otherBee = new BeeDev(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });
    const fm2 = new FileManagerBase(otherBee);
    try {
      fm2.emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, (e) => {
        expect(e).toBeTruthy();
      });
      await fm2.initialize();
      await fm2.createDrive(MOCK_BATCH_ID, 'Admin Drive', true, RedundancyLevel.OFF);
    } catch (error: any) {
      expect(error).toBeInstanceOf(StampError);
      expect(error.message).toContain(`Admin stamp with batchId: ${MOCK_BATCH_ID.toString().slice(0, 6)}... not found`);
    }

    expect(fm2.fileInfoList).toEqual([]);
    expect(fm2.sharedWithMe).toEqual([]);
  });

  it('should initialize the admin feed and topic', async () => {
    expect(fileManager.fileInfoList).toEqual([]);
    expect(fileManager.sharedWithMe).toEqual([]);

    const feedTopicData = await getFeedData(bee, FILEMANAGER_STATE_TOPIC, signer.publicKey().address(), 0n);
    const topicHistory = await getFeedData(bee, FILEMANAGER_STATE_TOPIC, signer.publicKey().address(), 1n);
    const topicHex = await bee.downloadData(new Reference(feedTopicData.payload), {
      actHistoryAddress: new Reference(topicHistory.payload),
      actPublisher,
    });
    expect(topicHex).not.toEqual(SWARM_ZERO_ADDRESS);

    await fileManager.initialize();
    const reinitTopicHex = await bee.downloadData(new Reference(feedTopicData.payload), {
      actHistoryAddress: new Reference(topicHistory.payload),
      actPublisher,
    });
    expect(topicHex).toEqual(reinitTopicHex);
  });
  // TODO: review this case
  it('should throw an error if someone else than the admin tries to read the admin feed', async () => {
    const otherBee = new BeeDev(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });

    const feedTopicData = await getFeedData(bee, FILEMANAGER_STATE_TOPIC, signer.publicKey().address(), 0n);
    const topicHistory = await getFeedData(bee, FILEMANAGER_STATE_TOPIC, signer.publicKey().address(), 1n);

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

    const batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'initstamp');

    await fileManager.createDrive(batchId, 'initialization', false);
    const tmpDrive = fileManager.getDrives().find((d) => d.name === 'initialization');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;

    {
      await fileManager.upload(drive, { name: 'nested', path: path.join(__dirname, '../fixtures/nested') });

      await fileManager.upload(drive, {
        name: 'test.txt',
        path: path.join(__dirname, '../fixtures/test.txt'),
      });

      const fileInfoList = fileManager.fileInfoList;
      expect(fileInfoList).toHaveLength(expFileDataArr.length);
      await dowloadAndCompareFiles(fileManager, actPublisher.toCompressedHex(), fileInfoList, expFileDataArr);

      const fileList = await fileManager.listFiles(fileInfoList[0], {
        actHistoryAddress: fileInfoList[0].file.historyRef,
        actPublisher,
      });
      expect(Object.keys(fileList)).toHaveLength(expNestedPaths.length);
      Object.keys(fileList).forEach((key, ix) => {
        expect(path.basename(key)).toEqual(path.basename(expNestedPaths[ix]));
      });
    }

    const fm2 = new FileManagerBase(bee);
    await fm2.initialize();
    const fileInfoList = fm2.fileInfoList;
    await dowloadAndCompareFiles(fm2, actPublisher.toCompressedHex(), fileInfoList, expFileDataArr);
  });

  it('should verify Bee versions and supported API', async () => {
    const versions = await bee.getVersions();
    expect(versions.beeVersion).toBeDefined();
    expect(versions.beeApiVersion).toBeDefined();
    const supported = await bee.isSupportedApiVersion();
    expect(supported).toBeTruthy();
  });
  // TODO: test failure: create = true but it exists
  it('should not reinitialize if already initialized', async () => {
    const fileInfoListBefore = [...fileManager.fileInfoList];
    fileManager.emitter.on(FileManagerEvents.FILEMANAGER_INITIALIZED, (e) => {
      expect(e).toEqual(true);
    });
    await fileManager.initialize();
    expect(fileManager.fileInfoList).toEqual(fileInfoListBefore);
  });
});

describe('FileManager drive handling', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let ownerBatch: PostageBatch;
  let tempDir: string;
  let signer: PrivateKey;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp, signer: newSigner } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    signer = newSigner;
    const stamp = (await bee.getPostageBatches()).find((s) => s.batchID.toString() === ownerStamp.toString());

    expect(stamp).toBeDefined();
    expect(stamp?.batchID.toString() === ownerStamp.toString()).toBeTruthy();
    ownerBatch = stamp!;

    fileManager = await createInitializedFileManager(bee, ownerStamp);

    tempDir = path.join(__dirname, 'tmpDriveFolder');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'Content A');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create a drive and retrieve it', async () => {
    const batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'createDriveStamp');

    let driveId: string | undefined;
    fileManager.emitter.on(FileManagerEvents.DRIVE_CREATED, ({ driveInfo }) => {
      expect(driveInfo).toBeDefined();
      expect(new Identifier(driveInfo.id)).toHaveLength(Identifier.LENGTH);
      expect(driveInfo.batchId).toBe(batchId.toString());
      expect(driveInfo.name).toBe('Test Drive');
      expect(driveInfo.owner).toBe(signer.publicKey().address().toHex());
      expect(driveInfo.redundancyLevel).toBe(RedundancyLevel.OFF);
      expect(driveInfo.infoFeedList).toStrictEqual([]);

      driveId = driveInfo.id.toString();
    });

    await fileManager.createDrive(batchId, 'Test Drive', false);
    const drives = fileManager.getDrives();
    expect(drives.length).toBeGreaterThanOrEqual(1);
    const testDrive = drives.find((d) => d.name === 'Test Drive');
    expect(testDrive).toBeDefined();
    expect(driveId).toBeDefined();
    expect(testDrive?.id).toBe(driveId);
    expect(fileManager.fileInfoList.filter((fi) => fi.driveId === driveId)).toHaveLength(0);
  });

  it('should throw an error when trying to destroy the admin drive/ stamp', async () => {
    await expect(
      fileManager.destroyDrive(
        {
          batchId: ownerBatch.batchID.toString(),
          id: 'mockID',
          name: 'Admin Drive',
          owner: signer.publicKey().address().toString(),
          redundancyLevel: RedundancyLevel.OFF,
          isAdmin: false,
        },
        ownerBatch,
      ),
    ).rejects.toThrow(new DriveError(`Cannot destroy admin drive / stamp, batchId: ${ownerBatch.batchID.toString()}`));

    await expect(
      fileManager.destroyDrive(
        {
          batchId: new BatchId('6789'.repeat(16)).toString(),
          id: 'mockID',
          name: 'Admin Drive',
          owner: signer.publicKey().address().toString(),
          redundancyLevel: RedundancyLevel.OFF,
          isAdmin: true,
        },
        ownerBatch,
      ),
    ).rejects.toThrow(new DriveError(`Stamp does not match drive stamp`));
    // isAdmin true
    await expect(
      fileManager.destroyDrive(
        {
          batchId: ownerBatch.batchID.toString(),
          id: 'mockID',
          name: 'Admin Drive',
          owner: signer.publicKey().address().toString(),
          redundancyLevel: RedundancyLevel.OFF,
          isAdmin: true,
        },
        ownerBatch,
      ),
    ).rejects.toThrow(new DriveError(`Cannot destroy admin drive / stamp, batchId: ${ownerBatch.batchID.toString()}`));
  });

  // todo: not possible to test with devnode: gives 501
  // it('should destroy the given drive', async () => {
  //   const batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'toDestroyBatch');
  //   await fileManager.createDrive(batchId, 'Drive to destroy', false);
  //   const initialDrivesLength = fileManager.getDrives().length;

  //   const driveToDestroy = fileManager.getDrives().find((d) => d.name === 'Drive to destroy');
  //   expect(driveToDestroy).toBeDefined();

  //   fileManager.emitter.on(FileManagerEvents.DRIVE_DESTROYED, (drive: DriveInfo) => {
  //     expect(drive).toBe(driveToDestroy);
  //   });

  //  await fileManager.destroyDrive(driveToDestroy!);

  //   const finalDrives = fileManager.getDrives();
  //   expect(finalDrives).toHaveLength(initialDrivesLength - 1);

  //   const drive = finalDrives.find((d) => d.name === 'Drive to destroy');
  //   expect(drive).toBeUndefined();

  //   // TODO: what else flag is set after dilute ?
  //   const stamp = (await bee.getPostageBatches()).find((b) => b.label === 'toDestroyBatch');
  //   expect(stamp?.usable).toBe(false);
  // });
});

describe('FileManager listFiles', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let tempDir: string;
  let actPublisher: PublicKey;
  let drive: DriveInfo;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;

    tempDir = path.join(__dirname, 'tmpIntegrationListFiles');
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'listFilesIntegrationStamp');

    fileManager = await createInitializedFileManager(bee, ownerStamp);
    actPublisher = (await bee.getNodeAddresses()).publicKey;

    await fileManager.createDrive(batchId, 'listFiles', false);
    const tmpDrive = fileManager.getDrives().find((d) => d.name === 'listFiles');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;

    fs.mkdirSync(tempDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'Content A');
    fs.writeFileSync(path.join(tempDir, 'b.txt'), 'Content B');

    const subfolder = path.join(tempDir, 'subfolder');
    fs.mkdirSync(subfolder, { recursive: true });
    fs.writeFileSync(path.join(subfolder, 'c.txt'), 'Content C');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return a list of files for the uploaded folder', async () => {
    await fileManager.upload(drive, { name: path.basename(tempDir), path: tempDir });

    const allFileInfos = fileManager.fileInfoList;
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(tempDir));
    expect(fileInfo).toBeDefined();

    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    });

    const returnedBasenames = Object.keys(fileList).map((filePath) => path.basename(filePath));
    expect(returnedBasenames).toContain('a.txt');
    expect(returnedBasenames).toContain('b.txt');
    expect(returnedBasenames).toContain('c.txt');
    expect(Object.keys(fileList)).toHaveLength(3);
  });

  it('should throw and return an empty file list when uploading an empty folder', async () => {
    const emptyDir = path.join(__dirname, 'emptyFolder');
    fs.mkdirSync(emptyDir, { recursive: true });

    let fileInfo: FileInfo | undefined;
    try {
      await fileManager.upload(drive, {
        name: path.basename(emptyDir),
        path: emptyDir,
      });
      const allFileInfos = fileManager.fileInfoList;
      fileInfo = allFileInfos.find((fi) => fi.name === path.basename(emptyDir));
    } catch (error: any) {
      expect(error).toBeInstanceOf(FileError);
      expect(error.message).toMatch(/status code 400/);
      fs.rmSync(emptyDir, { recursive: true, force: true });
      return;
    }

    expect(fileInfo).toBeDefined();
    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    });
    expect(Object.keys(fileList)).toHaveLength(0);

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('should correctly return nested file paths in a deeply nested folder structure', async () => {
    const deepDir = path.join(__dirname, 'deepNestedFolder');
    const level1 = path.join(deepDir, 'level1');
    const level2 = path.join(level1, 'level2');
    const level3 = path.join(level2, 'level3');
    fs.mkdirSync(level3, { recursive: true });
    fs.writeFileSync(path.join(level3, 'd.txt'), 'Content D');

    await fileManager.upload(drive, {
      name: path.basename(deepDir),
      path: deepDir,
    });
    const allFileInfos = fileManager.fileInfoList;
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(deepDir));
    expect(fileInfo).toBeDefined();

    const fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    });

    const returnedBasenames = Object.keys(fileList).map((filePath) => path.basename(filePath));
    expect(returnedBasenames).toContain('d.txt');

    const expectedFullPath = path.join('level1', 'level2', 'level3', 'd.txt');
    const foundPath = Object.keys(fileList).find((filePath) => filePath === expectedFullPath);
    expect(foundPath).toBeDefined();

    fs.rmSync(deepDir, { recursive: true, force: true });
  });

  it('should ignore entries with empty paths', async () => {
    const folderWithEmpty = path.join(__dirname, 'folderWithEmpty');
    fs.mkdirSync(folderWithEmpty, { recursive: true });
    fs.writeFileSync(path.join(folderWithEmpty, 'valid.txt'), 'Valid Content');
    fs.writeFileSync(path.join(folderWithEmpty, 'empty.txt'), 'Should be ignored');

    await fileManager.upload(drive, {
      name: path.basename(folderWithEmpty),
      path: folderWithEmpty,
    });
    const allFileInfos = fileManager.fileInfoList;
    const fileInfo = allFileInfos.find((fi) => fi.name === path.basename(folderWithEmpty));
    expect(fileInfo).toBeDefined();

    let fileList = await fileManager.listFiles(fileInfo!, {
      actHistoryAddress: fileInfo!.file.historyRef,
      actPublisher,
    });

    const modifiedFileList: Record<string, string> = {};
    Object.entries(fileList).forEach(([filePath, reference]) => {
      if (path.basename(filePath) === 'empty.txt') {
        modifiedFileList[''] = reference;
      } else {
        modifiedFileList[filePath] = reference;
      }
    });

    const filteredEntries = Object.entries(modifiedFileList).filter(([filePath]) => filePath !== '');
    const returnedBasenames = filteredEntries.map(([filePath]) => path.basename(filePath));
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
  let drive: DriveInfo;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;

    tempUploadDir = path.join(__dirname, 'tmpUploadIntegration');
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'uploadIntegrationStamp');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'upload', false);
    const tmpDrive = fileManager.getDrives().find((d) => d.name === 'upload');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;

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

  it('should upload a directory and update the file info list with different versions', async () => {
    await fileManager.upload(drive, { name: path.basename(tempUploadDir), path: tempUploadDir });
    const firstInfo = fileManager.fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(firstInfo).toBeDefined();

    await fileManager.upload(
      drive,
      {
        name: path.basename(tempUploadDir),
        topic: firstInfo?.topic,
        path: tempUploadDir,
      },
      {
        actHistoryAddress: new Reference(firstInfo!.file.historyRef),
      },
    );
    const secondInfo = fileManager.fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    const secondVersion = new FeedIndex(firstInfo!.version!).next();
    expect(secondInfo).toBeDefined();
    expect(secondInfo?.topic).toEqual(firstInfo?.topic);
    expect(secondInfo?.version).toEqual(secondVersion.toString());

    const thirdVersion = secondVersion.next().toString();
    await fileManager.upload(
      drive,
      {
        name: path.basename(tempUploadDir),
        topic: firstInfo?.topic,
        version: thirdVersion,
        path: tempUploadDir,
      },
      {
        actHistoryAddress: new Reference(firstInfo!.file.historyRef),
      },
    );
    const thirdInfo = fileManager.fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(thirdInfo).toBeDefined();
    expect(thirdInfo?.topic).toEqual(firstInfo?.topic);
    expect(thirdInfo?.version).toEqual(thirdVersion);
  });

  it('should NOT re-upload the same file but update the metadata', async () => {
    await fileManager.upload(drive, { name: path.basename(tempUploadDir), path: tempUploadDir });
    const firstInfo = fileManager.fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(firstInfo).toBeDefined();

    await fileManager.upload(
      drive,
      {
        name: path.basename(tempUploadDir),
        topic: firstInfo?.topic,
        file: firstInfo?.file,
        path: tempUploadDir,
      },
      {
        actHistoryAddress: new Reference(firstInfo!.file.historyRef),
      },
    );
    const secondInfo = fileManager.fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(secondInfo).toBeDefined();
    expect(secondInfo?.file).toEqual(firstInfo?.file);

    await fileManager.upload(
      drive,
      {
        name: path.basename(tempUploadDir),
        topic: firstInfo?.topic,
        file: firstInfo?.file,
        path: tempUploadDir,
      },
      {
        actHistoryAddress: new Reference(firstInfo!.file.historyRef),
      },
    );
    const thirdInfo = fileManager.fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(thirdInfo).toBeDefined();
    expect(thirdInfo?.file).toEqual(firstInfo?.file);
  });

  it('should upload with previewPath if provided', async () => {
    const previewDir = path.join(__dirname, 'tmpUploadPreview');
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'preview.txt'), 'Preview Content');

    await fileManager.upload(drive, {
      name: path.basename(tempUploadDir),
      path: tempUploadDir,
      previewPath: previewDir,
    });

    const fileInfoList = fileManager.fileInfoList;
    const uploadedInfo = fileInfoList.find((fi) => fi.name === path.basename(tempUploadDir));
    expect(uploadedInfo).toBeDefined();

    if (uploadedInfo!.preview !== undefined) {
      expect(uploadedInfo!.preview).toBeDefined();
    } else {
      console.warn('Preview property is not defined. Your implementation may not store preview info.');
    }

    fs.rmSync(previewDir, { recursive: true, force: true });
  });

  it('should throw an error if topic and historyRef are not provided together', async () => {
    await expect(
      fileManager.upload(drive, {
        name: path.basename(tempUploadDir),
        topic: 'someInfoTopic',
        path: tempUploadDir,
      }),
    ).rejects.toThrow(new FileInfoError('Options topic and historyRef have to be provided at the same time.'));
  });

  it('should upload a single file and update the file info list', async () => {
    const tempFile = path.join(__dirname, 'tempFile.txt');
    fs.writeFileSync(tempFile, 'Single File Content');
    await fileManager.upload(drive, {
      name: path.basename(tempFile),
      path: tempFile,
    });
    const fileInfoList = fileManager.fileInfoList;
    const uploadedInfo = fileInfoList.find((fi) => fi.name === path.basename(tempFile));
    expect(uploadedInfo).toBeDefined();
    fs.rmSync(tempFile, { force: true });
  });

  it('does not create a second fileInfo when bumping to a new version', async () => {
    const dirName = path.basename(tempUploadDir);

    await fileManager.upload(drive, { name: dirName, path: tempUploadDir });
    const original = fileManager.fileInfoList.find((fi) => fi.name === dirName)!;
    expect(original).toBeDefined();

    await fileManager.upload(
      drive,
      {
        name: dirName,
        topic: original.topic,
        path: tempUploadDir,
      },
      {
        actHistoryAddress: new Reference(original.file.historyRef),
      },
    );

    const entries = fileManager.fileInfoList.filter((fi) => fi.name === dirName && fi.topic === original.topic);
    expect(entries).toHaveLength(1);

    const bumped = entries[0];
    expect(BigInt(bumped.version!)).toBeGreaterThan(BigInt(original.version! || '0'));
  });
});

describe('FileManager download', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let tempDownloadDir: string;
  const expectedContents: Record<string, string> = {};
  let actPublisher: PublicKey;
  let drive: DriveInfo;
  let signer: PrivateKey;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp, signer: newSigner } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    tempDownloadDir = path.join(__dirname, 'tmpDownloadIntegration');
    signer = newSigner;
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'downloadFilesIntegrationStamp');
    fileManager = await createInitializedFileManager(bee, ownerStamp);
    actPublisher = (await bee.getNodeAddresses()).publicKey;

    await fileManager.createDrive(batchId, 'download', false);
    const tmpDrive = fileManager.getDrives().find((d) => d.name === 'download');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;

    fs.mkdirSync(tempDownloadDir, { recursive: true });

    const file1Path = path.join(tempDownloadDir, 'alpha.txt');
    const file2Path = path.join(tempDownloadDir, 'beta.txt');
    fs.writeFileSync(file1Path, 'Download Content Alpha');
    fs.writeFileSync(file2Path, 'Download Content Beta');
    expectedContents['alpha.txt'] = 'Download Content Alpha';
    expectedContents['beta.txt'] = 'Download Content Beta';

    const subfolder = path.join(tempDownloadDir, 'subfolder');
    fs.mkdirSync(subfolder, { recursive: true });
    const file3Path = path.join(subfolder, 'gamma.txt');
    fs.writeFileSync(file3Path, 'Download Content Gamma');
    expectedContents['gamma.txt'] = 'Download Content Gamma';

    await fileManager.upload(drive, {
      name: path.basename(tempDownloadDir),
      path: tempDownloadDir,
    });
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
        owner: signer.publicKey().address(),
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

describe('FileManager file operations', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let testFi: FileInfo;
  let drive: DriveInfo;
  let testFilePath: string;
  const TEST_NAME = 'trash-restore-forget.txt';

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'fileOpsIntegration');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'fileoperations', false);
    const tmpDrive = fileManager.getDrives().find((d) => d.name === 'fileoperations');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;

    testFilePath = path.join(__dirname, '../fixtures', TEST_NAME);
    fs.writeFileSync(testFilePath, 'file ops content');
    await fileManager.upload(drive, { name: TEST_NAME, path: testFilePath });

    testFi = fileManager.fileInfoList.find((fi) => fi.name === TEST_NAME)!;
    expect(testFi).toBeDefined();
    expect(testFi.status).toBe(FileStatus.Active);
  });

  afterAll(() => {
    fs.rmSync(testFilePath, { force: true });
  });

  it('should trash a file (soft-delete)', async () => {
    const initial = fileManager.fileInfoList.find((fi) => fi.name === TEST_NAME)!;
    const beforeVersion = BigInt(initial.version ?? '0');

    await fileManager.trashFile(initial);
    expect(initial.status).toBe(FileStatus.Trashed);

    const fm2 = new FileManagerBase(bee);
    await fm2.initialize();

    const fi2 = fm2.fileInfoList.find((fi) => fi.name === TEST_NAME)!;
    expect(fi2.status).toBe(FileStatus.Trashed);
    expect(BigInt(fi2.version!)).toBe(beforeVersion + 1n);
  });

  it('should recover a previously trashed file', async () => {
    if (testFi.status !== FileStatus.Trashed) {
      await fileManager.trashFile(testFi);
      expect(testFi.status).toBe(FileStatus.Trashed);
    } else {
      expect(testFi.status).toBe(FileStatus.Trashed);
    }
    const beforeVersion = BigInt(testFi.version!);

    await fileManager.recoverFile(testFi);

    const fm2 = new FileManagerBase(bee);
    await fm2.initialize();

    const fi2 = fm2.fileInfoList.find((fi) => fi.name === TEST_NAME)!;
    expect(fi2.status).toBe(FileStatus.Active);
    expect(BigInt(fi2.version!)).toBe(beforeVersion + 1n);
  });

  it('should forget (hard-delete) a file', async () => {
    await fileManager.forgetFile(testFi);
    expect(fileManager.fileInfoList.find((fi) => fi.name === TEST_NAME)).toBeUndefined();

    const fm2 = new FileManagerBase(bee);
    await fm2.initialize();

    expect(fm2.fileInfoList.find((fi) => fi.name === TEST_NAME)).toBeUndefined();
  });

  it('should never duplicate FileInfo entries when trashing/recovering', async () => {
    const fp = path.join(__dirname, '../fixtures', TEST_NAME);
    await fileManager.upload(drive, { name: TEST_NAME, path: fp });

    const freshFi = fileManager.fileInfoList.find((fi) => fi.name === TEST_NAME)!;
    const topic = freshFi.topic.toString();
    expect(fileManager.fileInfoList.filter((fi) => fi.topic.toString() === topic)).toHaveLength(1);

    await fileManager.trashFile(freshFi);
    expect(freshFi.status).toBe(FileStatus.Trashed);

    await expect(fileManager.trashFile(freshFi)).rejects.toThrow(/File already Thrashed/i);

    await fileManager.recoverFile(freshFi);
    expect(freshFi.status).toBe(FileStatus.Active);

    await expect(fileManager.recoverFile(freshFi)).rejects.toThrow(/Non-Thrashed files cannot be restored/i);

    expect(fileManager.fileInfoList.filter((fi) => fi.topic.toString() === topic)).toHaveLength(1);
  });

  it('fileInfoList should never gain duplicate topics when trash/restoring', async () => {
    const fm = new FileManagerBase(bee);
    await fm.initialize();

    const fi0 = fm.fileInfoList.find((fi) => fi.name === TEST_NAME)!;
    const topic = fi0.topic.toString();
    const beforeVer = BigInt(fi0.version!);

    if (fi0.status !== FileStatus.Trashed) {
      await fm.trashFile(fi0);
    }
    await fm.recoverFile(fi0);

    const fm2 = new FileManagerBase(bee);
    await fm2.initialize();
    const fi2 = fm2.fileInfoList.find((fi) => fi.topic.toString() === topic)!;

    expect(BigInt(fi2.version!)).toBe(beforeVer + 2n);
  });
});

describe('FileManager version control', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let drive: DriveInfo;
  let signer: PrivateKey;

  // helper to ensure at least one base FileInfo exists
  const ensureBase = async (name = `versioned-file-${Date.now()}`, di: DriveInfo = drive): Promise<FileInfo> => {
    const existing = fileManager.fileInfoList.find((f) => f.name === name);
    if (existing) return existing;
    const tmp = path.join(__dirname, 'seed.txt');
    fs.writeFileSync(tmp, 'seed');
    await fileManager.upload(di, { name, path: tmp });
    fs.unlinkSync(tmp);
    return fileManager.fileInfoList.at(-1)!;
  };

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp, signer: newSigner } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    signer = newSigner;

    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'versioningStamp');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'versioncontrol', false);
    const tmpDrive = fileManager.getDrives().find((d) => d.name === 'versioncontrol');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  it('throws on invalid version index', async () => {
    const base = await ensureBase();
    await expect(fileManager.getVersion(base, BigInt(999).toString())).rejects.toThrow();
    await expect(fileManager.getVersion(base, BigInt(-1).toString())).rejects.toThrow();
  });

  it('handles sequential uploads with proper slot indices', async () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'par-'));
    try {
      const name = `parallel-${Date.now()}`;
      const p0 = path.join(tmpDir, 'f0.txt');
      fs.writeFileSync(p0, 'v0');
      await fileManager.upload(drive, { name, path: p0 });
      const base = fileManager.fileInfoList.at(-1)!;

      let latestVersion = BigInt(base.version!);
      let latest = await fileManager.getVersion(base, FeedIndex.fromBigInt(latestVersion));

      for (const i of [1, 2, 3]) {
        const fn = path.join(tmpDir, `f${i}.txt`);
        fs.writeFileSync(fn, `v${i}`);
        await fileManager.upload(
          drive,
          { name, topic: base.topic.toString(), path: fn },
          {
            actHistoryAddress: new Reference(latest.file.historyRef),
          },
        );

        latestVersion = BigInt(i);
      }

      expect(latestVersion).toBe(BigInt(base.version!) + 3n);

      for (let i = 0n; i < latestVersion; i++) {
        const fi = await fileManager.getVersion(base, FeedIndex.fromBigInt(i));
        expect(fi.version).toBe(FeedIndex.fromBigInt(i).toString());
      }

      // Fetch the current head without specifying an index
      const newLatest = await fileManager.getVersion(base);
      expect(newLatest.version).toBe(FeedIndex.fromBigInt(latestVersion).toString());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('getVersion + download returns the correct bytes subset', async () => {
    const dir = path.join(__dirname, 'coll');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'B');

      const name = `coll-${Date.now()}`;
      await fileManager.upload(drive, { name, path: dir });
      const base = fileManager.fileInfoList.at(-1)!;

      const versionedFi = await fileManager.getVersion(base, FEED_INDEX_ZERO.toString());
      const dl = await fileManager.download(versionedFi, ['a.txt']);
      expect((dl as Bytes[])[0].toUtf8()).toBe('A');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the cached FileInfo for the current head without refetching', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const spyGetFeedData = jest.spyOn(require('../../src/utils/common'), 'getFeedData');

    const base = await ensureBase('cache-test');

    const cached = fileManager.fileInfoList.find((f) => f.topic === base.topic)!;
    expect(cached).toBeDefined();

    spyGetFeedData.mockClear();

    const headSlot = FeedIndex.fromBigInt(BigInt(base.version!));
    const result = await fileManager.getVersion(base, headSlot);

    expect(result).toBe(cached);

    expect(spyGetFeedData).not.toHaveBeenCalled();
  });

  it('uploads multiple versions, counts them, fetches an old version and downloads it', async () => {
    const tmpDir = path.join(__dirname, 'versioningTmp');
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, 'file.txt');
      const NAME = `versioned-file-${Date.now()}`;

      const content = 'Version 0 content';
      fs.writeFileSync(filePath, content);
      await fileManager.upload(drive, { name: NAME, path: filePath });
      const v0Fi = fileManager.fileInfoList.at(-1)!;
      const topic = v0Fi.topic.toString();
      const hist0 = v0Fi.file.historyRef;

      fs.writeFileSync(filePath, 'Version 1 content');
      await fileManager.upload(
        drive,
        { name: NAME, topic: topic, path: filePath },
        {
          actHistoryAddress: new Reference(hist0),
        },
      );

      const countAfterV1 = await getFeedData(bee, new Topic(v0Fi.topic), signer.publicKey().address().toString());
      const latestFi = await fileManager.getVersion(v0Fi, countAfterV1.feedIndex);
      fs.writeFileSync(filePath, 'Version 2 content');
      await fileManager.upload(
        drive,
        { name: NAME, topic: topic, path: filePath },
        {
          actHistoryAddress: new Reference(latestFi.file.historyRef),
        },
      );

      const count = await getFeedData(bee, new Topic(v0Fi.topic), signer.publicKey().address().toString());
      expect(count.feedIndexNext.toBigInt()).toBeGreaterThanOrEqual(3n);

      const v0 = await fileManager.getVersion(v0Fi, FEED_INDEX_ZERO);
      expect(v0.version).toBeDefined();
      expect(v0.version).toBe(FEED_INDEX_ZERO.toString());

      const actPublisher = (await bee.getNodeAddresses()).publicKey.toCompressedHex();
      const dl0 = (await fileManager.download(v0, undefined, {
        actHistoryAddress: v0.file.historyRef,
        actPublisher,
      })) as Bytes[];
      expect(dl0[0].toUtf8()).toBe(content);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('can restore a prior version and make it the new head', async () => {
    const tmp = path.join(__dirname, 'restore.txt');
    try {
      fs.writeFileSync(tmp, 'first');

      const base = await ensureBase('restore-file');
      const initialVersion = BigInt(base.version!);
      const firstRef = base.file.reference;

      fs.writeFileSync(tmp, 'second');
      await fileManager.upload(
        drive,
        { name: base.name, topic: base.topic.toString(), path: tmp },
        {
          actHistoryAddress: new Reference(base.file.historyRef),
        },
      );

      await fileManager.restoreVersion(base);

      const { feedIndex: current } = await getFeedData(
        bee,
        new Topic(base.topic),
        signer.publicKey().address().toString(),
      );

      expect(BigInt(current.toBigInt())).toBe(initialVersion + 2n);

      const restored = await fileManager.getVersion(base, current);

      expect(restored.file.reference).toBe(firstRef);
      expect(BigInt(restored.version!)).toBe(initialVersion + 2n);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('restoring the current head does nothing', async () => {
    const tmp = path.join(__dirname, 'noop-restore.txt');
    try {
      fs.writeFileSync(tmp, 'A');
      const base = await ensureBase('noop-restore');
      fs.writeFileSync(tmp, 'B');
      await fileManager.upload(
        drive,
        { name: base.name, topic: base.topic.toString(), path: tmp },
        {
          actHistoryAddress: new Reference(base.file.historyRef),
        },
      );

      const currentHead = await fileManager.getVersion(base, base.version!);

      await fileManager.restoreVersion(currentHead);

      const reHead = await fileManager.getVersion(base, base.version!);
      expect(reHead.version).toBe(currentHead.version);
      expect(reHead.file.reference).toBe(currentHead.file.reference);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('restoreVersion() on a single version file reaffirms the head', async () => {
    const base = await ensureBase('noop-default');
    const headIdx = FeedIndex.fromBigInt(BigInt(base.version!));
    const before = await fileManager.getVersion(base, headIdx);

    await fileManager.restoreVersion(before);

    const after = await fileManager.getVersion(base, headIdx);
    expect(after.version).toBe(before.version);
    expect(after.file.reference).toBe(before.file.reference);
  });
});

describe('FileManager getGranteesOfFile', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let signer: PrivateKey;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp, signer: newSigner } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    fileManager = await createInitializedFileManager(bee, ownerStamp);
    signer = newSigner;
  });

  it('should throw an error if grantee list is not found for a file', async () => {
    const fileInfo: FileInfo = {
      batchId: 'dummyBatchId',
      topic: Topic.fromString('nonexistent-topic').toString(),
      file: {
        reference: new Reference('1'.repeat(64)).toString(),
        historyRef: new Reference('0'.repeat(64)).toString(),
      },
      owner: signer.publicKey().address().toString(),
      name: 'dummyFile',
      timestamp: Date.now(),
      shared: false,
      version: FEED_INDEX_ZERO.toString(),
      driveId: 'dummyDriveId',
      actPublisher: 'dummyActPublisher',
    };
    await expect(fileManager.getGrantees(fileInfo)).rejects.toThrow(
      new GranteeError(`Drive not found for file: ${fileInfo.name}`),
    );
  });
});

describe('FileManager End-to-End User Workflow', () => {
  let bee: BeeDev;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let tempBaseDir: string;
  let actPublisher: PublicKey;
  let drive: DriveInfo;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    tempBaseDir = path.join(__dirname, 'e2eTestSession');
    fileManager = await createInitializedFileManager(bee, ownerStamp);
    fs.mkdirSync(tempBaseDir, { recursive: true });
    actPublisher = (await bee.getNodeAddresses()).publicKey;

    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'e2eStamp');
    await fileManager.createDrive(batchId, 'e2e', false);
    const tmpDrive = fileManager.getDrives().find((d) => d.name === 'e2e');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  afterAll(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  it('should simulate a complete workflow - in-place folder update simulation', async () => {
    const singleFilePath = path.join(tempBaseDir, 'initial.txt');
    fs.writeFileSync(singleFilePath, 'Hello, this is the initial file.');
    await fileManager.upload(drive, { name: path.basename(singleFilePath), path: singleFilePath });
    let fileInfos = fileManager.fileInfoList.filter((fi) => fi.driveId === drive.id.toString());
    expect(fileInfos.find((fi) => fi.name === path.basename(singleFilePath))).toBeDefined();

    fileInfos.forEach((fi) => {
      expect(fi.driveId).toBe(drive.id.toString());
      expect(fi.batchId).toBe(drive.batchId.toString());
      expect(fi.redundancyLevel).toBe(drive.redundancyLevel);
    });

    const projectFolder = path.join(tempBaseDir, 'projectFolder');
    fs.mkdirSync(projectFolder, { recursive: true });
    fs.writeFileSync(path.join(projectFolder, 'doc1.txt'), 'Project document 1');
    fs.writeFileSync(path.join(projectFolder, 'doc2.txt'), 'Project document 2');
    const assetsFolder = path.join(projectFolder, 'assets');
    fs.mkdirSync(assetsFolder, { recursive: true });
    fs.writeFileSync(path.join(assetsFolder, 'image.png'), 'Fake image content');
    await fileManager.upload(drive, { name: path.basename(projectFolder), path: projectFolder });
    fileInfos = fileManager.fileInfoList.filter((fi) => fi.driveId === drive.id.toString());
    const projectInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolder))!;
    expect(projectInfo).toBeDefined();

    fileInfos.forEach((fi) => {
      expect(fi.driveId).toBe(drive.id.toString());
      expect(fi.batchId).toBe(drive.batchId.toString());
      expect(fi.redundancyLevel).toBe(drive.redundancyLevel);
    });

    fs.writeFileSync(path.join(projectFolder, 'readme.txt'), 'This is the project readme.');
    await new Promise((r) => setTimeout(r, 1000));
    await fileManager.upload(drive, { name: path.basename(projectFolder), path: projectFolder });

    const listedFiles = await fileManager.listFiles(projectInfo, {
      actHistoryAddress: new Reference(projectInfo.file.historyRef),
      actPublisher,
    });
    const basenames = Object.keys(listedFiles).map((filePath) => path.basename(filePath));
    // Since in-place updates aren’t supported, we expect the manifest to contain only the original files.
    expect(basenames).toContain('doc1.txt');
    expect(basenames).toContain('doc2.txt');
    expect(basenames).toContain('image.png');
    expect(basenames).not.toContain('readme.txt');
    expect(Object.keys(listedFiles)).toHaveLength(3);
  });

  it('should simulate a complete workflow - new version folder upload', async () => {
    const singleFilePath = path.join(tempBaseDir, 'initial.txt');
    fs.writeFileSync(singleFilePath, 'Hello, this is the initial file.');
    await fileManager.upload(drive, { name: path.basename(singleFilePath), path: singleFilePath });
    let fileInfos = fileManager.fileInfoList.filter((fi) => fi.driveId === drive.id.toString());
    expect(fileInfos.find((fi) => fi.name === path.basename(singleFilePath))).toBeDefined();

    const projectFolder = path.join(tempBaseDir, 'projectFolder');
    fs.mkdirSync(projectFolder, { recursive: true });
    fs.writeFileSync(path.join(projectFolder, 'doc1.txt'), 'Project document 1');
    fs.writeFileSync(path.join(projectFolder, 'doc2.txt'), 'Project document 2');
    const assetsFolder = path.join(projectFolder, 'assets');
    fs.mkdirSync(assetsFolder, { recursive: true });
    fs.writeFileSync(path.join(assetsFolder, 'image.png'), 'Fake image content');
    await fileManager.upload(drive, { name: path.basename(projectFolder), path: projectFolder });
    fileInfos = fileManager.fileInfoList.filter((fi) => fi.driveId === drive.id.toString());
    const projectInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolder));
    expect(projectInfo).toBeDefined();

    fileInfos.forEach((fi) => {
      expect(fi.driveId).toBe(drive.id.toString());
      expect(fi.batchId).toBe(drive.batchId.toString());
      expect(fi.redundancyLevel).toBe(drive.redundancyLevel);
    });

    const projectFolderNew = path.join(tempBaseDir, 'projectFolder_new');
    fs.mkdirSync(projectFolderNew, { recursive: true });
    fs.writeFileSync(path.join(projectFolderNew, 'doc1.txt'), 'Project document 1');
    fs.writeFileSync(path.join(projectFolderNew, 'doc2.txt'), 'Project document 2');
    const assetsFolderNew = path.join(projectFolderNew, 'assets');
    fs.mkdirSync(assetsFolderNew, { recursive: true });
    fs.writeFileSync(path.join(assetsFolderNew, 'image.png'), 'Fake image content');
    fs.writeFileSync(path.join(projectFolderNew, 'readme.txt'), 'This is the project readme.');

    const nestedFolder = path.join(projectFolderNew, 'nested');
    fs.mkdirSync(nestedFolder, { recursive: true });
    fs.writeFileSync(path.join(nestedFolder, 'subdoc.txt'), 'Nested document content');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fileManager.upload(drive, { name: path.basename(projectFolderNew), path: projectFolderNew });
    fileInfos = fileManager.fileInfoList.filter((fi) => fi.driveId === drive.id.toString());
    const newVersionInfo = fileInfos.find((fi) => fi.name === path.basename(projectFolderNew));
    expect(newVersionInfo).toBeDefined();

    fileInfos.forEach((fi) => {
      expect(fi.driveId).toBe(drive.id.toString());
      expect(fi.batchId).toBe(drive.batchId.toString());
      expect(fi.redundancyLevel).toBe(drive.redundancyLevel);
    });

    const listedFiles_newVersion = await fileManager.listFiles(newVersionInfo!, {
      actHistoryAddress: new Reference(newVersionInfo!.file.historyRef),
      actPublisher,
    });
    const basenames_newVersion = Object.keys(listedFiles_newVersion).map((filePath) => path.basename(filePath));
    const fullPaths_newVersion = Object.keys(listedFiles_newVersion);
    expect(basenames_newVersion).toContain('doc1.txt');
    expect(basenames_newVersion).toContain('doc2.txt');
    expect(basenames_newVersion).toContain('image.png');
    expect(basenames_newVersion).toContain('readme.txt');
    expect(basenames_newVersion).toContain('subdoc.txt');
    expect(fullPaths_newVersion).toContain('nested/subdoc.txt');
    expect(Object.keys(listedFiles_newVersion)).toHaveLength(5);

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

  it('should list files with correct relative paths reflecting folder structure', async () => {
    const complexFolder = path.join(tempBaseDir, 'complexFolder');
    fs.mkdirSync(complexFolder, { recursive: true });
    fs.writeFileSync(path.join(complexFolder, 'root.txt'), 'Root file content');
    const level1 = path.join(complexFolder, 'level1');
    fs.mkdirSync(level1, { recursive: true });
    fs.writeFileSync(path.join(level1, 'level1.txt'), 'Level1 file content');
    const level2 = path.join(level1, 'level2');
    fs.mkdirSync(level2, { recursive: true });
    fs.writeFileSync(path.join(level2, 'level2.txt'), 'Level2 file content');

    await fileManager.upload(drive, { name: path.basename(complexFolder), path: complexFolder });
    const fileInfos = fileManager.fileInfoList;
    const complexInfo = fileInfos.find((fi) => fi.name === path.basename(complexFolder));
    expect(complexInfo).toBeDefined();

    const listedFiles = await fileManager.listFiles(complexInfo!, {
      actHistoryAddress: new Reference(complexInfo!.file.historyRef),
      actPublisher,
    });
    const fullPaths = Object.keys(listedFiles);
    expect(fullPaths).toContain('root.txt');
    expect(fullPaths).toContain('level1/level1.txt');
    expect(fullPaths).toContain('level1/level2/level2.txt');
  });
});
