import {
  BatchId,
  Bee,
  BeeResponseError,
  FeedIndex,
  Identifier,
  PostageBatch,
  PrivateKey,
  PublicKey,
  RedundancyLevel,
  Reference,
  Topic,
} from '@ethersphere/bee-js';
import * as fs from 'fs';
import path from 'path';
import { setTimeout } from 'timers';

import {
  createInitializedFileManager,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  OTHER_BEE_URL,
  OTHER_MOCK_SIGNER,
  retryOnPropagationDelay,
  streamToUint8Array,
} from '../utils';

import { ensureUniqueSignerWithStamp } from './utils/testSetupHelpers';

import { FileManagerBase } from '@/fileManager';
import { ActReferences, DriveInfo, FileRecord, FolderInfo, ListDepth, NodeStatus, NodeType } from '@/types';
import { ADMIN_STAMP_LABEL, DriveError, FILEMANAGER_STATE_TOPIC, FileManagerEvents, StampError } from '@/utils';
import { assertActReferences } from '@/utils/asserts';
import { buyStamp, getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, ROOT_PATH, SWARM_ZERO_ADDRESS } from '@/utils/constants';
import { generateRandomBytes } from '@/utils/crypto';

describe('FileManager initialization', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let actPublisher: PublicKey;
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
    expect(fileManager.recordList).toEqual([]);

    const unpurchasedBatchId = new BatchId(generateRandomBytes(BatchId.LENGTH));
    const otherBee = new Bee(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });
    const fm2 = new FileManagerBase(otherBee);
    try {
      fm2.emitter.on(FileManagerEvents.INITIALIZED, (e) => {
        expect(e).toBeTruthy();
      });
      await fm2.initialize();
      await fm2.createAdminDrive(unpurchasedBatchId, RedundancyLevel.OFF);
    } catch (error: any) {
      expect(error).toBeInstanceOf(StampError);
      expect(error.message).toContain(
        `Stamp with batchId: ${unpurchasedBatchId.toString().slice(0, 6)}... not found OR not usable`,
      );
    }

    expect(fm2.recordList).toEqual([]);
  });

  it('should initialize the admin feed and topic', async () => {
    expect(fileManager.recordList).toEqual([]);

    const { payload } = await retryOnPropagationDelay(() =>
      getFeedData(bee, FILEMANAGER_STATE_TOPIC, signer.publicKey().address(), 0n),
    );
    const feedTopicState = payload.toJSON() as ActReferences;
    assertActReferences(feedTopicState);
    const topicHex = await bee.downloadData(new Reference(feedTopicState.reference), {
      actHistoryAddress: new Reference(feedTopicState.historyRef),
      actPublisher,
    });
    expect(topicHex).not.toEqual(SWARM_ZERO_ADDRESS);

    await fileManager.initialize();
    const reinitTopicHex = await bee.downloadData(new Reference(feedTopicState.reference), {
      actHistoryAddress: new Reference(feedTopicState.historyRef),
      actPublisher,
    });
    expect(topicHex).toEqual(reinitTopicHex);
  });

  it('should throw an error if someone else than the admin tries to read the admin feed', async () => {
    const otherBee = new Bee(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });

    const { payload } = await retryOnPropagationDelay(() =>
      getFeedData(bee, FILEMANAGER_STATE_TOPIC, signer.publicKey().address(), 0n),
    );
    const feedTopicState = payload.toJSON() as ActReferences;

    try {
      await bee.downloadData(new Reference(feedTopicState.reference), {
        actHistoryAddress: new Reference(feedTopicState.historyRef),
        actPublisher: OTHER_MOCK_SIGNER.publicKey(),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BeeResponseError);
      expect((error as BeeResponseError).status).toBe(404);
    }

    try {
      await retryOnPropagationDelay(() =>
        otherBee.downloadData(new Reference(feedTopicState.reference), {
          actHistoryAddress: new Reference(feedTopicState.historyRef),
          actPublisher,
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BeeResponseError);
      expect((error as BeeResponseError).status).toBe(404);
    }
  });

  it('uploads a nested folder with files and fetches them back', async () => {
    const rootFile = 'it-init-nested-root.txt';
    const nestedDir = 'it-init-nested-docs';
    const nestedFile = path.join(nestedDir, 'note.txt');

    fs.writeFileSync(rootFile, 'Init nested root content');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(nestedFile, 'Init nested docs content');

    try {
      const driveBatchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'initNestedFolderStamp');
      await fileManager.createDrive(driveBatchId, 'init-nested-drive');
      const drive = fileManager.driveList.find((d) => d.name === 'init-nested-drive')!;
      expect(drive).toBeDefined();

      const result = await fileManager.uploadFiles(
        drive.id,
        [
          { path: 'root.txt', sourcePath: rootFile },
          { path: 'docs/note.txt', sourcePath: nestedFile },
        ],
        '',
      );
      expect(result.failed).toHaveLength(0);

      const rootEntries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(new Identifier(drive.id), '', ListDepth.Shallow),
      );
      expect(rootEntries.some((e) => e.type === NodeType.File && e.path === 'root.txt')).toBe(true);
      expect(rootEntries.some((e) => e.type === NodeType.Folder && e.path.endsWith('docs'))).toBe(true);

      const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(drive.id, '/'));
      const downloadedRoot = downloadResults.find((d) => d.path === 'root.txt');
      const downloadedNested = downloadResults.find((d) => d.path === 'docs/note.txt');
      expect(downloadedRoot).toBeDefined();
      expect(downloadedNested).toBeDefined();
      expect(Buffer.from(await streamToUint8Array(downloadedRoot!.result)).toString('utf-8')).toBe(
        'Init nested root content',
      );
      expect(Buffer.from(await streamToUint8Array(downloadedNested!.result)).toString('utf-8')).toBe(
        'Init nested docs content',
      );
    } finally {
      fs.rmSync(rootFile, { force: true });
      fs.rmSync(nestedDir, { recursive: true, force: true });
    }
  });

  it('should not reinitialize if already initialized', async () => {
    const recordListBefore = [...fileManager.recordList];
    fileManager.emitter.on(FileManagerEvents.INITIALIZED, (e) => {
      expect(e).toEqual(true);
    });
    await fileManager.initialize();
    expect(fileManager.recordList).toEqual(recordListBefore);
  });

  it('should maintain isInitialized flag after successful reinitialization', async () => {
    expect((fileManager as any).isInitialized).toBe(true);
    await fileManager.initialize();
    expect((fileManager as any).isInitialized).toBe(true);
  });

  it('should not clear drives when reinitializing with valid stamp', async () => {
    const drivesBefore = fileManager.driveList;
    expect(drivesBefore.length).toBeGreaterThan(0);

    await fileManager.initialize();

    const drivesAfter = fileManager.driveList;
    expect(drivesAfter).toEqual(drivesBefore);
  });

  it('should maintain admin stamp reference after reinitialization', async () => {
    const adminStampBefore = fileManager.adminStamp;
    expect(adminStampBefore).toBeDefined();

    await fileManager.initialize();

    const adminStampAfter = fileManager.adminStamp;
    expect(adminStampAfter).toBeDefined();
    expect(adminStampAfter?.batchID.toString()).toBe(adminStampBefore?.batchID.toString());
  });
});

describe('FileManager reinitialization', () => {
  it('should emit STATE_INVALID after expiry', async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    await createInitializedFileManager(beeDev, ownerStamp);

    const originalFn = beeDev.getPostageBatches.bind(beeDev);
    const spy = jest.spyOn(beeDev, 'getPostageBatches');

    spy.mockImplementation(async () => {
      await originalFn();
      return [];
    });

    const newFileManager = new FileManagerBase(beeDev);

    newFileManager.emitter.on(FileManagerEvents.STATE_INVALID, (stateInvalidEmitted) => {
      expect(stateInvalidEmitted).toBe(true);
    });

    newFileManager.emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
      expect(success).toBe(true);
    });

    await newFileManager.initialize();

    expect(newFileManager.driveList).toHaveLength(0);
    expect(newFileManager.recordList).toHaveLength(0);

    spy.mockRestore();
  });

  it('should successfully revalidate when admin stamp is still valid', async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(beeDev, ownerStamp);

    const initialDrives = fileManager.driveList;
    const initialFileCount = fileManager.recordList.length;

    expect(initialDrives.length).toBeGreaterThanOrEqual(1);

    let initEventFired = false;
    let invalidEventFired = false;

    fileManager.emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
      initEventFired = true;
      expect(success).toBe(true);
    });

    fileManager.emitter.on(FileManagerEvents.STATE_INVALID, () => {
      invalidEventFired = true;
    });

    await fileManager.initialize();

    expect(initEventFired).toBe(true);
    expect(invalidEventFired).toBe(false);
    expect(fileManager.driveList).toEqual(initialDrives);
    expect(fileManager.recordList).toHaveLength(initialFileCount);
  });

  it('should preserve user data when creating a new instance with valid stamp', async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(beeDev, ownerStamp);

    const userBatchId = await buyStamp(beeDev, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'userDrive');
    await fileManager.createDrive(userBatchId, 'User Drive');

    const drivesBeforeReinit = fileManager.driveList;
    const userDrive = drivesBeforeReinit.find((d) => d.name === 'User Drive');
    expect(userDrive).toBeDefined();

    const newFileManager = new FileManagerBase(beeDev);
    await newFileManager.initialize();

    const drivesAfterReinit = newFileManager.driveList;
    expect(drivesAfterReinit).toHaveLength(drivesBeforeReinit.length);
    const userDriveAfter = drivesAfterReinit.find((d) => d.name === 'User Drive');
    expect(userDriveAfter).toBeDefined();
    expect(userDriveAfter?.id).toBe(userDrive?.id);
  });

  it('should handle multiple sequential reinitializations with valid stamp', async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(beeDev, ownerStamp);

    const initialDriveCount = fileManager.driveList.length;

    for (let i = 0; i < 3; i++) {
      await fileManager.initialize();
      expect(fileManager.driveList).toHaveLength(initialDriveCount);
    }

    for (let i = 0; i < 2; i++) {
      await retryOnPropagationDelay(async () => {
        const freshManager = new FileManagerBase(beeDev);
        await freshManager.initialize();
        expect(freshManager.driveList).toHaveLength(initialDriveCount);
      });
    }
  });

  it('should allow operations after successful revalidation', async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(beeDev, ownerStamp);

    await fileManager.initialize();

    const newBatchId = await buyStamp(beeDev, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'afterReinit');
    await fileManager.createDrive(newBatchId, 'Post Reinit Drive');

    const drives = fileManager.driveList;
    const newDrive = drives.find((d) => d.name === 'Post Reinit Drive');
    expect(newDrive).toBeDefined();
  });

  it('should emit correct events during revalidation failure', async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    const originalFn = beeDev.getPostageBatches.bind(beeDev);
    const spy = jest.spyOn(beeDev, 'getPostageBatches');

    spy.mockImplementation(async () => {
      const batches = await originalFn();
      return batches.map((b) => ({
        ...b,
        usable: true,
        label: b.label === ADMIN_STAMP_LABEL ? 'admin' : b.label,
      }));
    });

    await createInitializedFileManager(beeDev, ownerStamp);

    spy.mockImplementation(async () => {
      await originalFn();
      return [];
    });

    await retryOnPropagationDelay(async () => {
      const events: string[] = [];

      const newFileManager = new FileManagerBase(beeDev);
      newFileManager.emitter.on(FileManagerEvents.STATE_INVALID, () => {
        events.push('STATE_INVALID');
      });
      newFileManager.emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
        events.push(`INITIALIZED:${success}`);
      });

      await newFileManager.initialize();

      expect(events).toContain('STATE_INVALID');
      expect(events).toContain('INITIALIZED:true');
    });

    spy.mockRestore();
  });

  it('should not affect other drives when revalidating admin stamp', async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(beeDev, ownerStamp);

    const batch1 = await buyStamp(beeDev, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'drive1');
    const batch2 = await buyStamp(beeDev, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'drive2');

    await fileManager.createDrive(batch1, 'Drive 1');
    await fileManager.createDrive(batch2, 'Drive 2');

    const drivesBeforeReinit = fileManager.driveList;
    const drive1 = drivesBeforeReinit.find((d) => d.name === 'Drive 1');
    const drive2 = drivesBeforeReinit.find((d) => d.name === 'Drive 2');

    expect(drive1).toBeDefined();
    expect(drive2).toBeDefined();

    await fileManager.initialize();

    const drivesAfterReinit = fileManager.driveList;
    expect(drivesAfterReinit.find((d) => d.id === drive1?.id)).toBeDefined();
    expect(drivesAfterReinit.find((d) => d.id === drive2?.id)).toBeDefined();
  });
});

describe('FileManager drive handling', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let ownerBatch: PostageBatch;
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
  });

  it('should create a drive and retrieve it', async () => {
    const batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'createDriveStamp');

    await fileManager.createDrive(batchId, 'Test Drive');
    const drives = fileManager.driveList;
    expect(drives.length).toBeGreaterThanOrEqual(1);
    const testDrive = drives.find((d) => d.name === 'Test Drive');
    expect(testDrive).toBeDefined();
    expect(new Identifier(testDrive!.id)).toHaveLength(Identifier.LENGTH);
    expect(testDrive!.batchId).toBe(batchId.toString());
    expect(testDrive!.name).toBe('Test Drive');
    expect(testDrive!.owner).toBe(signer.publicKey().address().toHex());
    expect(testDrive!.redundancyLevel).toBe(RedundancyLevel.OFF);
    expect(fileManager.recordList.filter((fr) => fr.driveId === testDrive!.id)).toHaveLength(0);
  });

  it('should throw an error when trying to destroy the admin drive/ stamp', async () => {
    const adminDrive = fileManager.driveList.find((d) => d.isAdmin);
    expect(adminDrive).toBeDefined();
    expect(adminDrive!.batchId).toBe(ownerBatch.batchID.toString());

    await expect(fileManager.destroyDrive(new Identifier(adminDrive!.id))).rejects.toThrow(
      new DriveError(`Cannot destroy admin drive / stamp, batchId: ${adminDrive!.batchId.slice(0, 6)}`),
    );
  });

  it('should forget a user drive: removes the drive, prunes its files, and persists the change', async () => {
    const forgetBatchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'forgetDriveStamp');
    await fileManager.createDrive(forgetBatchId, 'Drive to forget');

    const created = fileManager.driveList.find((d) => d.name === 'Drive to forget');
    expect(created).toBeDefined();
    const driveId = created!.id.toString();
    const initialDriveCount = fileManager.driveList.length;

    const fileA = 'forget-drive-a.txt';
    const fileB = 'forget-drive-b.txt';
    fs.writeFileSync(fileA, 'forget a content');
    fs.writeFileSync(fileB, 'forget b content');
    try {
      const uploadResult = await fileManager.uploadFiles(
        driveId,
        [
          { path: 'a.txt', sourcePath: fileA },
          { path: 'b.txt', sourcePath: fileB },
        ],
        '',
      );
      expect(uploadResult.failed).toHaveLength(0);
    } finally {
      fs.rmSync(fileA, { force: true });
      fs.rmSync(fileB, { force: true });
    }

    expect(fileManager.recordList.some((fr) => fr.driveId === driveId)).toBe(true);

    const eventPromise = new Promise<void>((resolve) => {
      const handler = ({ driveInfo }: { driveInfo: DriveInfo }): void => {
        try {
          expect(driveInfo.id.toString()).toBe(driveId);
          resolve();
        } finally {
          fileManager.emitter?.off?.(FileManagerEvents.DRIVE_FORGOTTEN, handler);
        }
      };
      fileManager.emitter.on(FileManagerEvents.DRIVE_FORGOTTEN, handler);
    });
    await fileManager.forgetDrive(new Identifier(created!.id));
    await eventPromise;
    const afterForgetDrives = fileManager.driveList;
    expect(afterForgetDrives).toHaveLength(initialDriveCount - 1);
    expect(afterForgetDrives.find((d) => d.id.toString() === driveId)).toBeUndefined();

    expect(fileManager.recordList.some((fr) => fr.driveId === driveId)).toBe(false);

    const fm2 = await createInitializedFileManager(bee, ownerBatch.batchID);
    const drives2 = fm2.driveList;
    expect(drives2.find((d) => d.name === 'Drive to forget')).toBeUndefined();
  });

  it('should throw when trying to forget the admin drive', async () => {
    const adminDrive = fileManager.driveList.find((d) => d.isAdmin);
    expect(adminDrive).toBeDefined();
    await expect(fileManager.forgetDrive(new Identifier(adminDrive!.id))).rejects.toThrow(
      new DriveError('Cannot forget admin drive'),
    );
  });

  it('should throw when trying to forget a non-existent drive', async () => {
    const idBytes = new Uint8Array(Identifier.LENGTH);
    idBytes.fill(1);
    await expect(fileManager.forgetDrive(new Identifier(idBytes))).rejects.toThrow(
      new DriveError(`Drive with id ${new Identifier(idBytes).toString().slice(0, 6)} not found`),
    );
  });
});

describe('FileManager listFolder', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let drive: DriveInfo;
  const cleanupPaths: string[] = [];

  function writeTempFile(name: string, content: string): string {
    fs.writeFileSync(name, content);
    cleanupPaths.push(name);
    return name;
  }

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'listFolderIntegration');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'listfolder');
    const tmpDrive = fileManager.driveList.find((d) => d.name === 'listfolder');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  afterAll(() => {
    for (const p of cleanupPaths) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it('returns entries for every file uploaded into a folder', async () => {
    const fileA = writeTempFile('it-listfolder-a.txt', 'A content');
    const fileB = writeTempFile('it-listfolder-b.txt', 'B content');

    const result = await fileManager.uploadFiles(
      new Identifier(drive.id),
      [
        { path: 'gallery/a.txt', sourcePath: fileA },
        { path: 'gallery/b.txt', sourcePath: fileB },
      ],
      '',
    );
    expect(result.failed).toHaveLength(0);

    const entries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, 'gallery', ListDepth.Shallow));
    const fileEntries = entries.filter((e) => e.type === NodeType.File);
    expect(fileEntries.map((e) => e.path).sort()).toEqual(['gallery/a.txt', 'gallery/b.txt']);
  });

  it('returns an empty array for an empty folder', async () => {
    await fileManager.createFolder(drive.id, ROOT_PATH, 'empty-folder');

    const entries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(drive.id, 'empty-folder', ListDepth.Shallow),
    );
    expect(entries).toEqual([]);
  });

  it('correctly composes nested paths in a deep listing', async () => {
    const fileA = writeTempFile('it-listfolder-deep-a.txt', 'Deep A content');
    const fileB = writeTempFile('it-listfolder-deep-b.txt', 'Deep B content');

    const result = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'level1/level2/a.txt', sourcePath: fileA },
        { path: 'level1/level2/level3/b.txt', sourcePath: fileB },
      ],
      '',
    );
    expect(result.failed).toHaveLength(0);

    const entries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, 'level1', ListDepth.Deep));
    const fileEntries = entries.filter((e) => e.type === NodeType.File);
    expect(fileEntries.map((e) => e.path).sort()).toEqual(['level1/level2/a.txt', 'level1/level2/level3/b.txt']);
  });

  it('composes destinationPath with a relative item path — placement differs from destination and source', async () => {
    const srcFile = writeTempFile('it-listfolder-dest-src.txt', 'destination compose content');

    await fileManager.createFolder(drive.id, '', 'inbox');

    // destinationPath ('inbox') + relative item path ('reports/q1.txt') → placed at
    // 'inbox/reports/q1.txt', which equals neither the destination nor the on-disk source name.
    const result = await fileManager.uploadFiles(drive.id, [{ path: 'reports/q1.txt', sourcePath: srcFile }], 'inbox');
    expect(result.failed).toHaveLength(0);

    const entries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, 'inbox', ListDepth.Deep));
    const filePaths = entries.filter((e) => e.type === NodeType.File).map((e) => e.path);
    expect(filePaths).toContain('inbox/reports/q1.txt');
    expect(filePaths).not.toContain('reports/q1.txt');
    expect(filePaths).not.toContain('it-listfolder-dest-src.txt');

    const downloads = await retryOnPropagationDelay(() => fileManager.downloadFolder(drive.id, '/'));
    const got = downloads.find((d) => d.path === 'inbox/reports/q1.txt');
    expect(got).toBeDefined();
    expect(Buffer.from(await streamToUint8Array(got!.result)).toString('utf-8')).toBe('destination compose content');
  });

  it('rejects an entry with an empty path and leaves the folder listing unaffected', async () => {
    const fileGood = writeTempFile('it-listfolder-guard-good.txt', 'Good content');
    const fileBad = writeTempFile('it-listfolder-guard-bad.txt', 'Should not upload');

    const seed = await fileManager.uploadFiles(drive.id, [{ path: 'guarded/good.txt', sourcePath: fileGood }], '');
    expect(seed.failed).toHaveLength(0);

    await expect(fileManager.uploadFiles(drive.id, [{ path: '', sourcePath: fileBad }], 'guarded')).rejects.toThrow(
      /Invalid path/,
    );

    const entries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, 'guarded', ListDepth.Shallow));
    const fileEntries = entries.filter((e) => e.type === NodeType.File);
    expect(fileEntries.map((e) => e.path)).toEqual(['guarded/good.txt']);
  });
});

describe('FileManager uploadFile', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let drive: DriveInfo;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;

    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'uploadIntegrationStamp');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'upload');
    const tmpDrive = fileManager.driveList.find((d) => d.name === 'upload');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  // Each test uses a unique filename: upload() now always mints a fresh topic + fork, so re-using
  // the same path across tests would leave multiple same-path entries in recordList. Re-versioning
  // is done via update(record, ...), which reuses the topic and writes a new feed slot.

  it('uploads a new file and adds it to the file record list at version 0', async () => {
    const name = 'it-upload-new.txt';
    fs.writeFileSync(name, 'New Content');
    try {
      await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
      const record = fileManager.recordList.find((fr) => fr.path === name);
      expect(record).toBeDefined();
      expect(record!.version).toEqual(FEED_INDEX_ZERO.toString());
    } finally {
      fs.rmSync(name, { force: true });
    }
  });

  it('re-versions a file with new bytes via update(), keeping the topic and advancing the version', async () => {
    const name = 'it-upload-versions.txt';
    fs.writeFileSync(name, 'v0');
    try {
      await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
      const firstInfo = fileManager.recordList.find((fr) => fr.path === name)!;
      expect(firstInfo).toBeDefined();

      fs.writeFileSync(name, 'v1');
      await fileManager.updateFile(drive.id, firstInfo, { item: { sourcePath: name } });
      const secondInfo = fileManager.recordList.find((fr) => fr.topic.toString() === firstInfo.topic.toString())!;
      expect(secondInfo.topic.toString()).toEqual(firstInfo.topic.toString());
      expect(secondInfo.version).toEqual(new FeedIndex(firstInfo.version!).next().toString());

      fs.writeFileSync(name, 'v2');
      await fileManager.updateFile(drive.id, secondInfo, { item: { sourcePath: name } });
      const thirdInfo = fileManager.recordList.find((fr) => fr.topic.toString() === firstInfo.topic.toString())!;
      expect(thirdInfo.version).toEqual(new FeedIndex(secondInfo.version!).next().toString());
    } finally {
      fs.rmSync(name, { force: true });
    }
  });

  it('metadata-only update() keeps the same content ref across versions', async () => {
    const name = 'it-upload-metadata.txt';
    fs.writeFileSync(name, 'Metadata Content');
    try {
      await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
      const firstInfo = fileManager.recordList.find((fr) => fr.path === name)!;
      expect(firstInfo).toBeDefined();

      await fileManager.updateFile(drive.id, firstInfo, { customMetadata: { tag: 'v1' } });
      const secondInfo = fileManager.recordList.find((fr) => fr.topic.toString() === firstInfo.topic.toString())!;
      expect(secondInfo.content).toEqual(firstInfo.content);
      expect(secondInfo.customMetadata).toMatchObject({ tag: 'v1' });

      await fileManager.updateFile(drive.id, secondInfo, { customMetadata: { tag: 'v2' } });
      const thirdInfo = fileManager.recordList.find((fr) => fr.topic.toString() === firstInfo.topic.toString())!;
      expect(thirdInfo.content).toEqual(firstInfo.content);
      expect(thirdInfo.customMetadata).toMatchObject({ tag: 'v2' });
    } finally {
      fs.rmSync(name, { force: true });
    }
  });

  it('should upload a single file and update the file record list', async () => {
    const tempFile = 'it-upload-single-file.txt';
    fs.writeFileSync(tempFile, 'Single File Content');
    await fileManager.uploadFile(drive.id, {
      path: tempFile,
      sourcePath: tempFile,
    });
    const recordList = fileManager.recordList;
    const uploadedInfo = recordList.find((fr) => fr.path === tempFile);
    expect(uploadedInfo).toBeDefined();
    fs.rmSync(tempFile, { force: true });
  });

  it('does not create a second record when bumping to a new version', async () => {
    const name = 'it-upload-bump.txt';
    fs.writeFileSync(name, 'Bump Content');
    try {
      await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
      const original = fileManager.recordList.find((fr) => fr.path === name)!;
      expect(original).toBeDefined();

      await fileManager.updateFile(drive.id, original, { item: { sourcePath: name } });

      const entries = fileManager.recordList.filter((fr) => fr.topic.toString() === original.topic.toString());
      expect(entries).toHaveLength(1);
      expect(BigInt(entries[0].version!.toString())).toBeGreaterThan(BigInt(original.version?.toString() || '0'));
    } finally {
      fs.rmSync(name, { force: true });
    }
  });

  it('throws when uploading a directory — directories must go through uploadFiles', async () => {
    const dirPath = 'it-upload-integration-dir';
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'inner.txt'), 'Inner Content');

    try {
      await expect(fileManager.uploadFile(drive.id, { path: dirPath, sourcePath: dirPath })).rejects.toThrow(
        'Cannot upload a directory - use uploadFiles',
      );
      expect(fileManager.recordList.some((fr) => fr.path === dirPath)).toBe(false);
    } finally {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it('rejects a directory as the update() content source', async () => {
    const name = 'it-update-dir-src.txt';
    const dirPath = 'it-update-dir-src';
    fs.writeFileSync(name, 'Src Content');
    fs.mkdirSync(dirPath, { recursive: true });
    try {
      await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
      const record = fileManager.recordList.find((fr) => fr.path === name)!;

      await expect(fileManager.updateFile(drive.id, record, { item: { sourcePath: dirPath } })).rejects.toThrow(
        'Cannot upload a directory - use uploadFiles',
      );
    } finally {
      fs.rmSync(name, { force: true });
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });
});

describe('FileManager uploadFiles', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let drive: DriveInfo;
  const tempFiles: string[] = [];

  function writeTempFile(name: string, content: string): string {
    fs.writeFileSync(name, content);
    tempFiles.push(name);
    return name;
  }

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'uploadManyIntegration');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'uploadmany');
    const tmpDrive = fileManager.driveList.find((d) => d.name === 'uploadmany');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  afterAll(() => {
    for (const f of tempFiles) {
      fs.rmSync(f, { force: true });
    }
  });

  it('uploads multiple flat files into the drive root, each with its own topic', async () => {
    const fileA = writeTempFile('it-uploadmany-a.txt', 'Content A');
    const fileB = writeTempFile('it-uploadmany-b.txt', 'Content B');
    const fileC = writeTempFile('it-uploadmany-c.txt', 'Content C');

    const result = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'a.txt', sourcePath: fileA },
        { path: 'b.txt', sourcePath: fileB },
        { path: 'c.txt', sourcePath: fileC },
      ],
      '',
    );

    expect(result.succeeded).toHaveLength(3);
    expect(result.failed).toHaveLength(0);

    const entries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, '', ListDepth.Shallow));
    const fileEntries = entries.filter((e) => e.type === NodeType.File);
    expect(fileEntries.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);

    const distinctTopics = new Set(
      fileManager.recordList
        .filter((fr) => ['a.txt', 'b.txt', 'c.txt'].includes(fr.path))
        .map((fr) => fr.topic.toString()),
    );
    expect(distinctTopics.size).toBe(3);
  });

  it('creates missing folders as needed and batches each touched manifest into a single save', async () => {
    const reportFile = writeTempFile('it-uploadmany-report.pdf', 'report content');
    const logoFile = writeTempFile('it-uploadmany-logo.png', 'logo content');
    const readmeFile = writeTempFile('it-uploadmany-readme.md', 'readme content');

    const folderCreatedEvents: unknown[] = [];
    const filesUploadedEvents: unknown[] = [];
    const onFolderCreated = (e: unknown): number => folderCreatedEvents.push(e);
    const onFilesUploaded = (e: unknown): number => filesUploadedEvents.push(e);
    fileManager.emitter.on(FileManagerEvents.FOLDER_CREATED, onFolderCreated);
    fileManager.emitter.on(FileManagerEvents.FILES_UPLOADED, onFilesUploaded);

    try {
      const result = await fileManager.uploadFiles(
        drive.id,
        [
          { path: 'docs/report.pdf', sourcePath: reportFile },
          { path: 'docs/img/logo.png', sourcePath: logoFile },
          { path: 'readme.md', sourcePath: readmeFile },
        ],
        '',
      );

      expect(result.failed).toHaveLength(0);
      expect(result.succeeded).toHaveLength(3);
      expect(folderCreatedEvents).toHaveLength(2);
      expect(filesUploadedEvents).toHaveLength(1);

      const rootEntries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, '', ListDepth.Shallow));
      expect(rootEntries.some((e) => e.type === NodeType.File && e.path === 'readme.md')).toBe(true);
      expect(rootEntries.some((e) => e.type === NodeType.Folder && e.path.endsWith('docs'))).toBe(true);

      const docsEntries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, 'docs', ListDepth.Shallow),
      );
      expect(docsEntries.some((e) => e.type === NodeType.File && e.path === 'docs/report.pdf')).toBe(true);
      expect(docsEntries.some((e) => e.type === NodeType.Folder && e.path.endsWith('img'))).toBe(true);

      const imgEntries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, 'docs/img', ListDepth.Shallow),
      );
      expect(imgEntries.some((e) => e.type === NodeType.File && e.path === 'docs/img/logo.png')).toBe(true);
    } finally {
      fileManager.emitter.off(FileManagerEvents.FOLDER_CREATED, onFolderCreated);
      fileManager.emitter.off(FileManagerEvents.FILES_UPLOADED, onFilesUploaded);
    }
  });

  it('uploads into an existing folder without duplicating it', async () => {
    await fileManager.createFolder(drive.id, ROOT_PATH, 'existing');
    const xFile = writeTempFile('it-uploadmany-x.txt', 'x content');

    const result = await fileManager.uploadFiles(drive.id, [{ path: 'sub/x.txt', sourcePath: xFile }], 'existing');

    expect(result.failed).toHaveLength(0);
    expect(result.succeeded).toHaveLength(1);

    const existingEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(drive.id, 'existing', ListDepth.Shallow),
    );
    const subFolders = existingEntries.filter((e) => e.type === NodeType.Folder && e.path.endsWith('sub'));
    expect(subFolders).toHaveLength(1);

    const subEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(drive.id, 'existing/sub', ListDepth.Shallow),
    );
    expect(subEntries.some((e) => e.type === NodeType.File && e.path === 'existing/sub/x.txt')).toBe(true);

    const rootEntries = await fileManager.listFolder(drive.id, '', ListDepth.Shallow);
    expect(rootEntries.filter((e) => e.type === NodeType.Folder && e.path.endsWith('existing'))).toHaveLength(1);
  });

  it('round-trips file content exactly through the two-hop ACT-unwrap download path', async () => {
    const contentA = 'Round trip content Alpha - '.repeat(50);
    const contentB = 'Round trip content Beta !! - '.repeat(37);
    const fileA = writeTempFile('it-uploadmany-roundtrip-a.txt', contentA);
    const fileB = writeTempFile('it-uploadmany-roundtrip-b.txt', contentB);

    const result = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'roundtrip-a.txt', sourcePath: fileA },
        { path: 'roundtrip-b.txt', sourcePath: fileB },
      ],
      '',
    );
    expect(result.failed).toHaveLength(0);

    const downloadResults = await retryOnPropagationDelay(() =>
      fileManager.downloadFiles([
        result.succeeded.find((fr) => fr.path === 'roundtrip-a.txt')!,
        result.succeeded.find((fr) => fr.path === 'roundtrip-b.txt')!,
      ]),
    );

    const downloadedA = downloadResults.find((d) => d.path === 'roundtrip-a.txt');
    const downloadedB = downloadResults.find((d) => d.path === 'roundtrip-b.txt');
    expect(downloadedA).toBeDefined();
    expect(downloadedB).toBeDefined();

    const bytesA = await streamToUint8Array(downloadedA!.result);
    const bytesB = await streamToUint8Array(downloadedB!.result);
    expect(Buffer.from(bytesA).toString('utf-8')).toBe(contentA);
    expect(Buffer.from(bytesB).toString('utf-8')).toBe(contentB);
  });

  it('fails fast without writing anything when a needed folder path is blocked by an existing file', async () => {
    const blockerPath = 'it-uploadmany-blocker';
    writeTempFile(blockerPath, 'blocker content');
    await fileManager.uploadFile(drive.id, { path: blockerPath, sourcePath: blockerPath });

    const innerFile = writeTempFile('it-uploadmany-inner-src.txt', 'inner content');

    await expect(
      fileManager.uploadFiles(drive.id, [{ path: `${blockerPath}/inner.txt`, sourcePath: innerFile }], ''),
    ).rejects.toThrow(/not a folder/i);

    const rootEntries = await fileManager.listFolder(drive.id, '', ListDepth.Shallow);
    expect(rootEntries.some((e) => e.path === 'inner.txt')).toBe(false);
    expect(rootEntries.some((e) => e.type === NodeType.Folder && e.path.endsWith(blockerPath))).toBe(false);
    expect(fileManager.recordList.some((fr) => fr.path.includes('inner.txt'))).toBe(false);
  });

  it('rejects invalid path and empty entries before doing any work', async () => {
    const srcFile = writeTempFile('it-uploadmany-validation-src.txt', 'validation content');

    await expect(
      fileManager.uploadFiles(drive.id, [{ path: '../escape.txt', sourcePath: srcFile }], ''),
    ).rejects.toThrow(/Invalid path/);

    await expect(fileManager.uploadFiles(drive.id, [], '')).rejects.toThrow(/at least one entry/i);
  });
});

describe('FileManager move', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let driveA: DriveInfo;
  let driveB: DriveInfo;
  const cleanupPaths: string[] = [];

  function writeTempFile(name: string, content: string): string {
    fs.writeFileSync(name, content);
    cleanupPaths.push(name);
    return name;
  }

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    const batchIdA = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'moveIntegrationA');
    const batchIdB = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'moveIntegrationB');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchIdA, 'move-a');
    const tmpDriveA = fileManager.driveList.find((d) => d.name === 'move-a');
    expect(tmpDriveA).toBeDefined();
    driveA = tmpDriveA!;

    await fileManager.createDrive(batchIdB, 'move-b');
    const tmpDriveB = fileManager.driveList.find((d) => d.name === 'move-b');
    expect(tmpDriveB).toBeDefined();
    driveB = tmpDriveB!;
  });

  afterAll(() => {
    for (const p of cleanupPaths) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it('renames a file within the drive root, preserving content and bumping the version', async () => {
    const fileA = writeTempFile('it-move-a.txt', 'Move Content A');
    await fileManager.uploadFile(driveA.id, { path: fileA, sourcePath: fileA });

    const before = fileManager.recordList.find((fr) => fr.path === fileA)!;
    expect(before).toBeDefined();
    const beforeVersion = BigInt((before.version ?? '0').toString());
    const topic = before.topic.toString();

    await fileManager.move(fileA, 'it-move-b.txt', driveA.id);

    const rootEntries = await retryOnPropagationDelay(() => fileManager.listFolder(driveA.id, '', ListDepth.Shallow));
    expect(rootEntries.some((e) => e.path === fileA)).toBe(false);
    expect(rootEntries.some((e) => e.type === NodeType.File && e.path === 'it-move-b.txt')).toBe(true);

    const moved = fileManager.recordList.find((fr) => fr.topic.toString() === topic)!;
    expect(moved).toBeDefined();
    expect(moved.path).toBe('it-move-b.txt');
    expect(BigInt(moved.version!.toString())).toBe(beforeVersion + 1n);

    const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(driveA.id, '/'));
    const downloaded = downloadResults.find((d) => d.path === 'it-move-b.txt');
    expect(downloaded).toBeDefined();
    expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Move Content A');
  });

  it('moves a root file into a newly created folder', async () => {
    const docFile = writeTempFile('it-move-doc.txt', 'Archive Me');
    await fileManager.uploadFile(driveA.id, { path: docFile, sourcePath: docFile });
    await fileManager.createFolder(driveA.id, ROOT_PATH, 'archive');

    await fileManager.move(docFile, 'archive/doc.txt', driveA.id);

    const rootEntries = await retryOnPropagationDelay(() => fileManager.listFolder(driveA.id, '', ListDepth.Shallow));
    expect(rootEntries.some((e) => e.path === docFile)).toBe(false);

    const archiveEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(driveA.id, 'archive', ListDepth.Shallow),
    );
    expect(archiveEntries.some((e) => e.type === NodeType.File && e.path === 'archive/doc.txt')).toBe(true);

    const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(driveA.id, 'archive'));
    const downloaded = downloadResults.find((d) => d.path === 'archive/doc.txt');
    expect(downloaded).toBeDefined();
    expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Archive Me');
  });

  it('moves a nested file back out to the drive root', async () => {
    const folderName = 'it-move-inbox';
    await fileManager.createFolder(driveA.id, ROOT_PATH, folderName);

    fs.mkdirSync(folderName, { recursive: true });
    cleanupPaths.push(folderName);
    const inboxFilePath = path.join(folderName, 'note.txt');
    fs.writeFileSync(inboxFilePath, 'Inbox Note');

    await fileManager.uploadFile(driveA.id, { path: inboxFilePath, sourcePath: inboxFilePath });

    await fileManager.move(inboxFilePath, 'note.txt', driveA.id);

    const rootEntries = await retryOnPropagationDelay(() => fileManager.listFolder(driveA.id, '', ListDepth.Shallow));
    expect(rootEntries.some((e) => e.type === NodeType.File && e.path === 'note.txt')).toBe(true);

    const folderEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(driveA.id, folderName, ListDepth.Shallow),
    );
    expect(folderEntries.some((e) => e.path === inboxFilePath)).toBe(false);

    const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(driveA.id, '/'));
    const downloaded = downloadResults.find((d) => d.path === 'note.txt');
    expect(downloaded).toBeDefined();
    expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Inbox Note');
  });

  it('moves a folder as a unit, composing correct descendant paths at read time', async () => {
    const innerFile = writeTempFile('it-move-src-inner.txt', 'Inner File Content');
    const uploadResult = await fileManager.uploadFiles(
      driveA.id,
      [{ path: 'src/inner.txt', sourcePath: innerFile }],
      '',
    );
    expect(uploadResult.failed).toHaveLength(0);
    const originalTopic = uploadResult.succeeded[0].topic.toString();

    await fileManager.createFolder(driveA.id, ROOT_PATH, 'backup');

    await fileManager.move('src', 'backup/src', driveA.id);

    const rootEntries = await retryOnPropagationDelay(() => fileManager.listFolder(driveA.id, '', ListDepth.Shallow));
    expect(rootEntries.some((e) => e.type === NodeType.Folder && e.path.replace(/^\//, '') === 'src')).toBe(false);

    const backupEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(driveA.id, 'backup', ListDepth.Shallow),
    );
    expect(backupEntries.some((e) => e.type === NodeType.Folder && e.path === 'backup/src')).toBe(true);

    const srcEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(driveA.id, 'backup/src', ListDepth.Shallow),
    );
    const innerEntry = srcEntries.find((e) => e.type === NodeType.File);
    expect(innerEntry).toBeDefined();
    expect(innerEntry!.topic).toBe(originalTopic);
    // Fixed: nothing on Swarm ever claimed an absolute position, so listFolder composes the
    // descendant's path fresh from the current tree — it correctly reflects the new location.
    expect(innerEntry!.path).toBe('backup/src/inner.txt');

    const movedFi = fileManager.recordList.find((fr) => fr.topic.toString() === originalTopic)!;
    expect(movedFi).toBeDefined();
    // move()'s own in-memory prefix rewrite already corrected the cached entry — no fresh
    // listFolder call was needed to get here.
    expect(movedFi.path).toBe('backup/src/inner.txt');

    const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(driveA.id, 'backup/src'));
    const downloaded = downloadResults.find((d) => d.path === 'backup/src/inner.txt');
    expect(downloaded).toBeDefined();
    expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Inner File Content');
  });

  it('moves a file across drives, updating driveId and remaining downloadable from the target', async () => {
    const xFile = writeTempFile('it-move-x.txt', 'Cross Drive Content');
    await fileManager.uploadFile(driveA.id, { path: xFile, sourcePath: xFile });

    await fileManager.move(xFile, xFile, driveA.id, driveB.id);

    const driveAEntries = await retryOnPropagationDelay(() => fileManager.listFolder(driveA.id, '', ListDepth.Shallow));
    expect(driveAEntries.some((e) => e.path === xFile)).toBe(false);

    const driveBEntries = await retryOnPropagationDelay(() => fileManager.listFolder(driveB.id, '', ListDepth.Shallow));
    expect(driveBEntries.some((e) => e.type === NodeType.File && e.path === xFile)).toBe(true);

    const moved = fileManager.recordList.find((fr) => fr.path === xFile && fr.driveId === driveB.id.toString());
    expect(moved).toBeDefined();

    const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(driveB.id, '/'));
    const downloaded = downloadResults.find((d) => d.path === xFile);
    expect(downloaded).toBeDefined();
    expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Cross Drive Content');
  });

  it('rejects invalid move calls', async () => {
    await expect(fileManager.move('it-move-nonexistent.txt', 'dest.txt', driveA.id)).rejects.toThrow(/not found/i);

    const sameFile = writeTempFile('it-move-same.txt', 'Same Path Content');
    await fileManager.uploadFile(driveA.id, { path: sameFile, sourcePath: sameFile });
    await expect(fileManager.move(sameFile, sameFile, driveA.id)).rejects.toThrow(/identical/i);

    await expect(fileManager.move(sameFile, 'nosuchfolder/dest.txt', driveA.id)).rejects.toThrow(/not found/i);
  });
});

describe('FileManager download family', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let drive: DriveInfo;
  const cleanupPaths: string[] = [];

  function writeTempFile(name: string, content: string): string {
    fs.writeFileSync(name, content);
    cleanupPaths.push(name);
    return name;
  }

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'downloadIntegration');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'downloaddrive');
    const tmpDrive = fileManager.driveList.find((d) => d.name === 'downloaddrive');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  afterAll(() => {
    for (const p of cleanupPaths) {
      fs.rmSync(p, { force: true });
    }
  });

  it('downloads all file contents from the drive when no paths are given', async () => {
    const fileA = writeTempFile('it-download-all-a.txt', 'Download All A');
    const fileB = writeTempFile('it-download-all-b.txt', 'Download All B');

    const result = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'all-a.txt', sourcePath: fileA },
        { path: 'all-b.txt', sourcePath: fileB },
      ],
      '',
    );
    expect(result.failed).toHaveLength(0);

    const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(drive.id, '/'));
    expect(downloadResults.map((d) => d.path).sort()).toEqual(['all-a.txt', 'all-b.txt']);

    const downloadedA = downloadResults.find((d) => d.path === 'all-a.txt');
    const downloadedB = downloadResults.find((d) => d.path === 'all-b.txt');
    expect(Buffer.from(await streamToUint8Array(downloadedA!.result)).toString('utf-8')).toBe('Download All A');
    expect(Buffer.from(await streamToUint8Array(downloadedB!.result)).toString('utf-8')).toBe('Download All B');
  });

  it('downloadFile fetches a single file by its record', async () => {
    const fileC = writeTempFile('it-download-only-c.txt', 'Download Only C');
    const fileD = writeTempFile('it-download-only-d.txt', 'Download Only D');

    const result = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'only-c.txt', sourcePath: fileC },
        { path: 'only-d.txt', sourcePath: fileD },
      ],
      '',
    );
    expect(result.failed).toHaveLength(0);

    const recC = result.succeeded.find((fr) => fr.path === 'only-c.txt')!;
    const downloadResult = await retryOnPropagationDelay(() => fileManager.downloadFile(recC));
    expect(downloadResult.path).toBe('only-c.txt');
    expect(Buffer.from(await streamToUint8Array(downloadResult.result)).toString('utf-8')).toBe('Download Only C');
  });

  it('returns an empty array when the drive has no files', async () => {
    const emptyBatchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'downloadEmptyIntegration');
    await fileManager.createDrive(emptyBatchId, 'download-empty-drive');
    const emptyDrive = fileManager.driveList.find((d) => d.name === 'download-empty-drive')!;
    expect(emptyDrive).toBeDefined();

    const downloadResults = await fileManager.downloadFolder(emptyDrive.id, '/');
    expect(downloadResults).toEqual([]);
  });
});

describe('FileManager file operations', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let adminBatch: string | BatchId;
  let testFi: FileRecord;
  let drive: DriveInfo;
  let testFilePath: string;
  const TEST_NAME = 'trash-restore-forget.txt';

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    adminBatch = ownerStamp;
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'fileOpsIntegration');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'fileoperations');
    const tmpDrive = fileManager.driveList.find((d) => d.name === 'fileoperations');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;

    // Flat, cwd-relative name: upload()'s `path` doubles as both the on-disk source and the
    // top-level drive manifest fork name, so it must resolve with zero intermediate segments.
    testFilePath = TEST_NAME;
    fs.writeFileSync(testFilePath, 'file ops content');
    await fileManager.uploadFile(drive.id, { path: testFilePath, sourcePath: testFilePath });

    testFi = fileManager.recordList.find((fr) => fr.path === TEST_NAME)!;
    expect(testFi).toBeDefined();
    expect(testFi.status).toBe(NodeStatus.Active);
  });

  afterAll(() => {
    fs.rmSync(testFilePath, { force: true });
  });

  it('should trash a file (soft-delete)', async () => {
    const initial = fileManager.recordList.find((fr) => fr.path === TEST_NAME)!;
    const beforeVersion = BigInt((initial.version ?? '0').toString());

    await fileManager.trashFile(initial);
    expect(initial.status).toBe(NodeStatus.Trashed);

    const fm2 = await createInitializedFileManager(bee, adminBatch);
    await fm2.listFolder(new Identifier(drive.id), ROOT_PATH);

    const fi2 = fm2.recordList.find((fr) => fr.path === TEST_NAME)!;
    // Trash state round-trips through the owner-private admin overlay, so a fresh instance derives
    // it on listFolder. It is overlay-only: the file's own feed/version is never touched.
    expect(fi2.status).toBe(NodeStatus.Trashed);
    expect(BigInt(fi2.version!.toString())).toBe(beforeVersion);
  });

  it('should recover a previously trashed file', async () => {
    if (testFi.status !== NodeStatus.Trashed) {
      await fileManager.trashFile(testFi);
      expect(testFi.status).toBe(NodeStatus.Trashed);
    } else {
      expect(testFi.status).toBe(NodeStatus.Trashed);
    }
    const beforeVersion = BigInt(testFi.version!.toString());

    await fileManager.recoverFile(testFi);

    const fm2 = await createInitializedFileManager(bee, adminBatch);
    await fm2.listFolder(drive.id, ROOT_PATH);

    const fi2 = fm2.recordList.find((fr) => fr.path === TEST_NAME)!;
    // Recover is overlay-only too: status flips back to Active without a version bump.
    expect(fi2.status).toBe(NodeStatus.Active);
    expect(BigInt(fi2.version!.toString())).toBe(beforeVersion);
  });

  it('should forget (hard-delete) a file', async () => {
    await fileManager.forget(drive.id, TEST_NAME);
    expect(fileManager.recordList.find((fr) => fr.path === TEST_NAME)).toBeUndefined();

    const fm2 = new FileManagerBase(bee);
    await fm2.initialize();

    expect(fm2.recordList.find((fr) => fr.path === TEST_NAME)).toBeUndefined();
  });

  it('should never duplicate FileRecord entries when trashing/recovering', async () => {
    await fileManager.uploadFile(drive.id, { path: TEST_NAME, sourcePath: TEST_NAME });

    const freshFi = fileManager.recordList.find((fr) => fr.path === TEST_NAME)!;
    const topic = freshFi.topic.toString();
    expect(fileManager.recordList.filter((fr) => fr.topic.toString() === topic)).toHaveLength(1);

    await fileManager.trashFile(freshFi);
    expect(freshFi.status).toBe(NodeStatus.Trashed);

    await expect(fileManager.trashFile(freshFi)).rejects.toThrow(/Already trashed/i);

    await fileManager.recoverFile(freshFi);
    expect(freshFi.status).toBe(NodeStatus.Active);

    await expect(fileManager.recoverFile(freshFi)).rejects.toThrow(/Not trashed, cannot recover/i);

    expect(fileManager.recordList.filter((fr) => fr.topic.toString() === topic)).toHaveLength(1);
  });

  it('recordList should never gain duplicate topics when trash/restoring', async () => {
    await fileManager.listFolder(drive.id, ROOT_PATH);

    const fi0 = fileManager.recordList.find((fr) => fr.path === TEST_NAME)!;
    const topic = fi0.topic.toString();
    const beforeVer = BigInt(fi0.version!.toString());

    if (fi0.status !== NodeStatus.Trashed) {
      await fileManager.trashFile(fi0);
    }
    await fileManager.recoverFile(fi0);

    const fm2 = await createInitializedFileManager(bee, adminBatch);
    await fm2.listFolder(drive.id, ROOT_PATH);
    const fi2 = fm2.recordList.find((fr) => fr.topic.toString() === topic)!;

    // Trash + recover are overlay-only round-trips — the file's own version never advances.
    expect(BigInt(fi2.version!.toString())).toBe(beforeVer);
  });
});

describe('FileManager version control', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let drive: DriveInfo;
  let signer: PrivateKey;

  // helper to ensure at least one base FileRecord exists.
  // Flat, cwd-relative name: upload()'s `path` doubles as both the on-disk source and the
  // top-level drive manifest fork name, so it must resolve with zero intermediate segments.
  const ensureBase = async (name = `versioned-file-${Date.now()}`, di: DriveInfo = drive): Promise<FileRecord> => {
    const existing = fileManager.recordList.find((f) => f.path === name);
    if (existing) return existing;
    fs.writeFileSync(name, 'seed');
    try {
      await fileManager.uploadFile(di.id, { path: name, sourcePath: name });
    } finally {
      fs.unlinkSync(name);
    }
    return fileManager.recordList.at(-1)!;
  };

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp, signer: newSigner } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    signer = newSigner;

    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'versioningStamp');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'versioncontrol');
    const tmpDrive = fileManager.driveList.find((d) => d.name === 'versioncontrol');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  it('throws on invalid version index', async () => {
    const base = await ensureBase();
    await expect(fileManager.getFileVersion(base, BigInt(999).toString())).rejects.toThrow();
    await expect(fileManager.getFileVersion(base, BigInt(-1).toString())).rejects.toThrow();
  });

  it('handles sequential uploads with proper slot indices', async () => {
    const name = `parallel-${Date.now()}`;
    try {
      fs.writeFileSync(name, 'v0');
      await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
      const base = fileManager.recordList.at(-1)!;

      let latestVersion = BigInt(base.version!.toString());

      for (const i of [1, 2, 3]) {
        fs.writeFileSync(name, `v${i}`);
        await fileManager.updateFile(drive.id, base, { item: { sourcePath: name } });

        latestVersion = BigInt(i);
      }

      expect(latestVersion).toBe(BigInt(base.version!.toString()) + 3n);

      for (let i = 0n; i < latestVersion; i++) {
        const fr = await fileManager.getFileVersion(base, FeedIndex.fromBigInt(i));
        expect(fr.version).toBe(FeedIndex.fromBigInt(i).toString());
      }

      // Fetch the current head without specifying an index
      const newLatest = await fileManager.getFileVersion(base);
      expect(newLatest.version).toBe(FeedIndex.fromBigInt(latestVersion).toString());
    } finally {
      fs.unlinkSync(name);
    }
  });

  it('updateFile lazy-loads the record on a cold cache (fresh instance, no prior listing)', async () => {
    const NAME = `cold-update-${Date.now()}`;
    try {
      fs.writeFileSync(NAME, 'cold v0');
      await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: NAME });
      const base = fileManager.recordList.find((fr) => fr.path === NAME)!;
      expect(base.version).toBe(FEED_INDEX_ZERO.toString());

      // Fresh instance shares the signer/state but never listed the folder — its record cache is empty.
      const fm2 = new FileManagerBase(bee);
      await fm2.initialize();
      expect(fm2.recordList.find((fr) => fr.topic === base.topic)).toBeUndefined();

      fs.writeFileSync(NAME, 'cold v1');
      const updated = await fm2.updateFile(drive.id, base, { item: { sourcePath: NAME } });

      // Re-versioned via lazy hydration; the record is now present in the fresh instance's cache.
      expect(updated.version).toBe(FeedIndex.fromBigInt(1n).toString());
      expect(updated.driveId).toBe(drive.id);
      expect(fm2.recordList.filter((fr) => fr.topic === base.topic)).toHaveLength(1);
    } finally {
      fs.rmSync(NAME, { force: true });
    }
  });

  it('updateFile throws when the record belongs to a different drive', async () => {
    const base = await ensureBase();

    const otherBatch = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, `mismatchStamp-${Date.now()}`);
    await fileManager.createDrive(otherBatch, `other-drive-${Date.now()}`);
    const otherDrive = fileManager.driveList.at(-1)!;

    // base was uploaded into `drive`, not `otherDrive`.
    await expect(fileManager.updateFile(otherDrive.id, base, { customMetadata: { x: '1' } })).rejects.toThrow(
      /does not belong to drive/,
    );
  });

  it('getFileVersion returns independently downloadable, version-correct bytes', async () => {
    const NAME = `version-bytes-${Date.now()}`;
    try {
      fs.writeFileSync(NAME, 'Version bytes v0');
      await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: NAME });
      const v0Fi = fileManager.recordList.at(-1)!;

      fs.writeFileSync(NAME, 'Version bytes v1');
      await fileManager.updateFile(drive.id, v0Fi, { item: { sourcePath: NAME } });

      const v0 = await fileManager.getFileVersion(v0Fi, FEED_INDEX_ZERO);
      const head = await fileManager.getFileVersion(v0Fi);

      expect(v0.content.reference).not.toBe(head.content.reference);

      const v0Bytes = await retryOnPropagationDelay(async () => {
        return streamToUint8Array(await bee.downloadReadableData(v0.content.reference));
      });
      expect(Buffer.from(v0Bytes).toString('utf-8')).toBe('Version bytes v0');

      const headBytes = await retryOnPropagationDelay(async () => {
        return streamToUint8Array(await bee.downloadReadableData(head.content.reference));
      });
      expect(Buffer.from(headBytes).toString('utf-8')).toBe('Version bytes v1');
    } finally {
      fs.rmSync(NAME, { force: true });
    }
  });

  it('returns the cached FileRecord for the current head without refetching', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const spyGetFeedData = jest.spyOn(require('@/utils/bee'), 'getFeedData');

    const base = await ensureBase('cache-test');

    const cached = fileManager.recordList.find((f) => f.topic === base.topic)!;
    expect(cached).toBeDefined();

    spyGetFeedData.mockClear();

    const headSlot = FeedIndex.fromBigInt(BigInt(base.version!.toString()));
    const result = await fileManager.getFileVersion(base, headSlot);

    expect(result).toBe(cached);

    expect(spyGetFeedData).not.toHaveBeenCalled();
  });

  it('uploads multiple versions, counts them, fetches an old version and downloads it', async () => {
    const NAME = `versioned-file-${Date.now()}`;
    try {
      const content = 'Version 0 content';
      fs.writeFileSync(NAME, content);
      await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: NAME });
      const v0Fi = fileManager.recordList.at(-1)!;

      fs.writeFileSync(NAME, 'Version 1 content');
      await fileManager.updateFile(drive.id, v0Fi, { item: { sourcePath: NAME } });

      const countAfterV1 = await getFeedData(bee, new Topic(v0Fi.topic), signer.publicKey().address().toString());
      const latestFi = await fileManager.getFileVersion(v0Fi, countAfterV1.feedIndex);
      fs.writeFileSync(NAME, 'Version 2 content');
      await fileManager.updateFile(drive.id, latestFi, { item: { sourcePath: NAME } });

      const count = await getFeedData(bee, new Topic(v0Fi.topic), signer.publicKey().address().toString());
      expect(count.feedIndexNext.toBigInt()).toBeGreaterThanOrEqual(3n);

      const v0 = await fileManager.getFileVersion(v0Fi, FEED_INDEX_ZERO);
      expect(v0.version).toBeDefined();
      expect(v0.version).toBe(FEED_INDEX_ZERO.toString());
    } finally {
      fs.rmSync(NAME, { force: true });
    }
  });

  it('can restore a prior version and make it the new head', async () => {
    // Re-upload must reuse the exact path ensureBase() uploaded with — see ensureBase() comment above.
    const NAME = 'restore-file';
    try {
      const base = await ensureBase(NAME);
      const initialVersion = BigInt(base.version!.toString());
      const firstRef = base.content.reference;

      fs.writeFileSync(NAME, 'second');
      await fileManager.updateFile(drive.id, base, { item: { sourcePath: NAME } });

      await fileManager.restoreFileVersion(base);

      const { feedIndex: current } = await getFeedData(
        bee,
        new Topic(base.topic),
        signer.publicKey().address().toString(),
      );

      expect(BigInt(current.toBigInt())).toBe(initialVersion + 2n);

      const restored = await fileManager.getFileVersion(base, current);

      expect(restored.content.reference).toBe(firstRef);
      expect(BigInt(restored.version!.toString())).toBe(initialVersion + 2n);
    } finally {
      fs.unlinkSync(NAME);
    }
  });

  // TODO: review this TC -> the description might me swapped with the next one
  it('restoring the current head does nothing', async () => {
    const NAME = 'noop-restore';
    try {
      const base = await ensureBase(NAME);
      fs.writeFileSync(NAME, 'B');
      await fileManager.updateFile(drive.id, base, { item: { sourcePath: NAME } });

      const currentHead = await fileManager.getFileVersion(base, base.version);

      await fileManager.restoreFileVersion(currentHead);

      const reHead = await fileManager.getFileVersion(base, base.version!);
      expect(reHead.version).toBe(currentHead.version);
      expect(reHead.content.reference).toBe(currentHead.content.reference);
    } finally {
      fs.unlinkSync(NAME);
    }
  });

  it('restoreFileVersion on a single version file reaffirms the head', async () => {
    const base = await ensureBase('noop-default');
    const headIdx = FeedIndex.fromBigInt(BigInt(base.version!.toString()));
    const before = await fileManager.getFileVersion(base, headIdx);

    await expect(fileManager.restoreFileVersion(before)).rejects.toThrow(
      `Head Slot cannot be restored. Please select a version lesser than: ${before.version?.toString()}`,
    );

    const after = await fileManager.getFileVersion(base, headIdx);
    expect(after.version).toBe(before.version);
    expect(after.content.reference).toBe(before.content.reference);
  });

  it("restoring an old version keeps the current (post-move) location, not the version's recorded path", async () => {
    const NAME = 'restore-move-file.txt';
    try {
      fs.writeFileSync(NAME, 'Restore Move V0 Content');
      await fileManager.uploadFile(drive.id, { path: NAME, sourcePath: NAME });
      const base = fileManager.recordList.at(-1)!;
      const topic = base.topic.toString();

      fs.writeFileSync(NAME, 'Restore Move V1 Content');
      await fileManager.updateFile(drive.id, base, { item: { sourcePath: NAME } });

      await fileManager.createFolder(drive.id, ROOT_PATH, 'restore-move-dest');
      const destPath = 'restore-move-dest/restore-move-file.txt';
      await fileManager.move(NAME, destPath, drive.id);

      const v0 = await fileManager.getFileVersion(base, FEED_INDEX_ZERO);
      expect(v0.version).toBe(FEED_INDEX_ZERO.toString());

      const { feedIndex: headBeforeRestore } = await getFeedData(
        bee,
        new Topic(topic),
        signer.publicKey().address().toString(),
      );

      await fileManager.restoreFileVersion(v0);

      const cached = fileManager.recordList.find((f) => f.topic.toString() === topic)!;
      expect(cached).toBeDefined();
      // Restoring content must not regress the tree position back to v0's own recorded path.
      expect(cached.path).toBe(destPath);

      const { feedIndex: headAfterRestore } = await retryOnPropagationDelay(async () => {
        const result = await getFeedData(bee, new Topic(topic), signer.publicKey().address().toString());
        if (!(result.feedIndex.toBigInt() > headBeforeRestore.toBigInt())) {
          throw new Error('feed head has not advanced yet');
        }
        return result;
      });
      expect(headAfterRestore.toBigInt()).toBeGreaterThan(headBeforeRestore.toBigInt());

      const downloadResults = await retryOnPropagationDelay(() =>
        fileManager.downloadFolder(drive.id, 'restore-move-dest'),
      );
      const downloaded = downloadResults.find((d) => d.path === destPath);
      expect(downloaded).toBeDefined();
      expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe(
        'Restore Move V0 Content',
      );
    } finally {
      fs.rmSync(NAME, { force: true });
    }
  });
});

describe('FileManager End-to-End User Workflow', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let drive: DriveInfo;
  const cleanupPaths: string[] = [];

  function writeTempFile(name: string, content: string): string {
    fs.writeFileSync(name, content);
    cleanupPaths.push(name);
    return name;
  }

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'e2eWorkflowIntegration');
    fileManager = await createInitializedFileManager(bee, ownerStamp);

    await fileManager.createDrive(batchId, 'e2e-workflow');
    const tmpDrive = fileManager.driveList.find((d) => d.name === 'e2e-workflow');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  afterAll(() => {
    for (const p of cleanupPaths) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it('simulates an in-place folder update: one file changes, siblings are untouched', async () => {
    const reportFileFlat = writeTempFile('it-e2e-inplace-report-src.txt', 'Report V1');
    const noteFileFlat = writeTempFile('it-e2e-inplace-note-src.txt', 'Note V1');

    const initial = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'it-e2e-project/report.txt', sourcePath: reportFileFlat },
        { path: 'it-e2e-project/note.txt', sourcePath: noteFileFlat },
      ],
      '',
    );
    expect(initial.failed).toHaveLength(0);
    const reportFi = initial.succeeded.find((fr) => fr.path === 'it-e2e-project/report.txt')!;
    const noteFi = initial.succeeded.find((fr) => fr.path === 'it-e2e-project/note.txt')!;
    expect(reportFi).toBeDefined();
    expect(noteFi).toBeDefined();

    // Update just one file in place — mirror the manifest path on disk since Node's upload()
    // re-upload path doubles as both the fs source and the manifest fork identity.
    const projectDir = 'it-e2e-project';
    fs.mkdirSync(projectDir, { recursive: true });
    cleanupPaths.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'report.txt'), 'Report V2');

    await fileManager.updateFile(drive.id, reportFi, { item: { sourcePath: 'it-e2e-project/report.txt' } });

    const projectEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(drive.id, 'it-e2e-project', ListDepth.Shallow),
    );
    expect(projectEntries.filter((e) => e.type === NodeType.File)).toHaveLength(2);

    const downloadResults = await retryOnPropagationDelay(async () => {
      const results = await fileManager.downloadFolder(drive.id, 'it-e2e-project');
      if (results.length < 2) {
        throw new Error(`Expected 2 download results, got ${results.length}`);
      }
      return results;
    });
    const downloadedReport = downloadResults.find((d) => d.path === 'it-e2e-project/report.txt');
    const downloadedNote = downloadResults.find((d) => d.path === 'it-e2e-project/note.txt');
    expect(downloadedReport).toBeDefined();
    expect(downloadedNote).toBeDefined();
    expect(Buffer.from(await streamToUint8Array(downloadedReport!.result)).toString('utf-8')).toBe('Report V2');
    expect(Buffer.from(await streamToUint8Array(downloadedNote!.result)).toString('utf-8')).toBe('Note V1');
  });

  it('simulates uploading a new version of a folder — new files join without disturbing old ones', async () => {
    const v1FileA = writeTempFile('it-e2e-newversion-v1-a.txt', 'V1 File A');
    const v1FileB = writeTempFile('it-e2e-newversion-v1-b.txt', 'V1 File B');

    const v1Result = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'gallery-v2/a.txt', sourcePath: v1FileA },
        { path: 'gallery-v2/b.txt', sourcePath: v1FileB },
      ],
      '',
    );
    expect(v1Result.failed).toHaveLength(0);

    const v2FileC = writeTempFile('it-e2e-newversion-v2-c.txt', 'V2 File C');
    const v2Result = await fileManager.uploadFiles(drive.id, [{ path: 'c.txt', sourcePath: v2FileC }], 'gallery-v2');
    expect(v2Result.failed).toHaveLength(0);

    const entries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(drive.id, 'gallery-v2', ListDepth.Shallow),
    );
    const fileEntries = entries.filter((e) => e.type === NodeType.File);
    expect(fileEntries.map((e) => e.path).sort()).toEqual(['gallery-v2/a.txt', 'gallery-v2/b.txt', 'gallery-v2/c.txt']);

    const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(drive.id, 'gallery-v2'));
    expect(downloadResults).toHaveLength(3);
    const contents = Object.fromEntries(
      await Promise.all(
        downloadResults.map(async (d) => [d.path, Buffer.from(await streamToUint8Array(d.result)).toString('utf-8')]),
      ),
    );
    expect(contents['gallery-v2/a.txt']).toBe('V1 File A');
    expect(contents['gallery-v2/b.txt']).toBe('V1 File B');
    expect(contents['gallery-v2/c.txt']).toBe('V2 File C');
  });

  it('lists files with correct relative paths reflecting a multi-branch folder structure', async () => {
    const readme = writeTempFile('it-e2e-structure-readme.txt', 'Readme');
    const specA = writeTempFile('it-e2e-structure-spec-a.txt', 'Spec A');
    const specB = writeTempFile('it-e2e-structure-spec-b.txt', 'Spec B');
    const asset = writeTempFile('it-e2e-structure-asset.txt', 'Asset');

    const result = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'structure/readme.txt', sourcePath: readme },
        { path: 'structure/specs/a.txt', sourcePath: specA },
        { path: 'structure/specs/b.txt', sourcePath: specB },
        { path: 'structure/assets/images/asset.txt', sourcePath: asset },
      ],
      '',
    );
    expect(result.failed).toHaveLength(0);

    const entries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, 'structure', ListDepth.Deep));
    const filePaths = entries
      .filter((e) => e.type === NodeType.File)
      .map((e) => e.path)
      .sort();
    expect(filePaths).toEqual([
      'structure/assets/images/asset.txt',
      'structure/readme.txt',
      'structure/specs/a.txt',
      'structure/specs/b.txt',
    ]);

    const folderPaths = entries
      .filter((e) => e.type === NodeType.Folder)
      .map((e) => e.path)
      .sort();
    expect(folderPaths).toEqual(['structure/assets', 'structure/assets/images', 'structure/specs']);
  });
});

describe('FileManager AbortController', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let batchId: BatchId;
  let drive: DriveInfo;

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    bee = beeDev;

    fileManager = await createInitializedFileManager(bee, ownerStamp);

    // Create a test drive
    batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'abortControllerStamp');
    await fileManager.createDrive(batchId, 'abort-test');
    const tmpDrive = fileManager.driveList.find((d) => d.name === 'abort-test');
    expect(tmpDrive).toBeDefined();
    drive = tmpDrive!;
  });

  describe('uploadFile', () => {
    // Flat, cwd-relative names: upload()'s `path` doubles as both the on-disk source and the
    // top-level drive manifest fork name, so it must resolve with zero intermediate segments.
    const preAbortFile = 'it-abort-pre-abort.bin';
    const midAbortFile = 'it-abort-mid-flight.bin';
    const successFile = 'it-abort-success.txt';
    const multi1File = 'it-abort-multi-1.txt';
    const multi2File = 'it-abort-multi-2.txt';

    beforeAll(() => {
      // Larger files (1MB) give abort tests enough time to actually cancel mid-flight.
      const largeData = Buffer.alloc(1 * 1024 * 1024, 'x');
      fs.writeFileSync(preAbortFile, largeData);
      fs.writeFileSync(midAbortFile, largeData);
      fs.writeFileSync(successFile, 'This file should upload successfully');
      fs.writeFileSync(multi1File, 'Content 1');
      fs.writeFileSync(multi2File, 'Content 2');
    });

    afterAll(() => {
      for (const f of [preAbortFile, midAbortFile, successFile, multi1File, multi2File]) {
        fs.rmSync(f, { force: true });
      }
    });

    it('should throw an AbortError when upload is aborted with pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort

      const uploadPromise = fileManager.uploadFile(
        drive.id,
        { path: preAbortFile, sourcePath: preAbortFile },
        undefined,
        {
          signal: controller.signal,
        },
      );

      await expect(uploadPromise).rejects.toThrow();

      try {
        await uploadPromise;
      } catch (error: any) {
        expect(error.name === 'AbortError' || error.message.toLowerCase().includes('abort')).toBe(true);
      }
    });

    it('should throw BeeResponseError when upload is cancelled mid-flight', async () => {
      const controller = new AbortController();

      // Start upload and abort after a short delay
      const uploadPromise = fileManager.uploadFile(
        drive.id,
        { path: midAbortFile, sourcePath: midAbortFile },
        undefined,
        {
          signal: controller.signal,
        },
      );

      setTimeout(() => {
        controller.abort();
      }, 50);

      await expect(uploadPromise).rejects.toThrow();

      // Verify the error is related to abort
      try {
        await uploadPromise;
      } catch (error: any) {
        expect(error.statusText === 'ERR_CANCELED' || error.message.includes('aborted')).toBe(true);
      }
    });

    it('should complete upload successfully when signal is not aborted', async () => {
      const controller = new AbortController();

      // Upload with signal that is NOT aborted
      await fileManager.uploadFile(drive.id, { path: successFile, sourcePath: successFile }, undefined, {
        signal: controller.signal,
      });

      // Verify file was uploaded
      const uploadedFile = fileManager.recordList.find((fr) => fr.path === successFile);
      expect(uploadedFile).toBeDefined();
      expect(uploadedFile?.driveId).toBe(drive.id.toString());
    });

    it('should handle multiple uploads with different abort controllers', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      controller1.abort(); // Pre-abort first one

      // First upload should fail (aborted)
      const firstUploadPromise = fileManager.uploadFile(
        drive.id,
        { path: multi1File, sourcePath: multi1File },
        undefined,
        {
          signal: controller1.signal,
        },
      );

      await expect(firstUploadPromise).rejects.toThrow();

      try {
        await firstUploadPromise;
      } catch (error: any) {
        expect(error.name === 'AbortError' || error.message.toLowerCase().includes('abort')).toBe(true);
      }

      // Second upload should succeed (not aborted)
      await fileManager.uploadFile(drive.id, { path: multi2File, sourcePath: multi2File }, undefined, {
        signal: controller2.signal,
      });

      const uploadedFile = fileManager.recordList.find((fr) => fr.path === multi2File);
      expect(uploadedFile).toBeDefined();
    });
  });

  describe('download', () => {
    const downloadTestFile = 'it-abort-large-download.bin';
    let uploadedFileInfo: FileRecord;
    let actPublisher: PublicKey;

    beforeAll(async () => {
      // Upload a 1MB file to download later (large enough for reliable abort timing)
      fs.writeFileSync(downloadTestFile, Buffer.alloc(1 * 1024 * 1024, 'x'));
      await fileManager.uploadFile(drive.id, { path: downloadTestFile, sourcePath: downloadTestFile });
      const fr = fileManager.recordList.find((fr) => fr.path === downloadTestFile);
      expect(fr).toBeDefined();
      uploadedFileInfo = fr!;

      actPublisher = (await bee.getNodeAddresses()).publicKey;
    });

    afterAll(() => {
      fs.rmSync(downloadTestFile, { force: true });
    });

    it('should throw error when download is aborted with pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort

      await expect(
        fileManager.downloadFiles(
          [uploadedFileInfo],
          {
            actHistoryAddress: uploadedFileInfo.content.historyRef,
            actPublisher,
          },
          { signal: controller.signal },
        ),
      ).rejects.toThrow();
    });

    it('should throw error when download is cancelled mid-flight', async () => {
      const controller = new AbortController();

      // Start download and abort after a short delay
      const downloadPromise = fileManager.downloadFiles(
        [uploadedFileInfo],
        {
          actHistoryAddress: uploadedFileInfo.content.historyRef,
          actPublisher,
        },
        { signal: controller.signal },
      );

      setTimeout(() => {
        controller.abort();
      }, 1);

      await expect(downloadPromise).rejects.toThrow();
    });

    it('should complete download successfully when signal is not aborted', async () => {
      const controller = new AbortController();

      const result = await fileManager.downloadFiles(
        [uploadedFileInfo],
        {
          actHistoryAddress: uploadedFileInfo.content.historyRef,
          actPublisher,
        },
        { signal: controller.signal },
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle multiple downloads with different abort controllers', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      controller1.abort(); // Pre-abort first one

      // First download should fail (aborted)
      await expect(
        fileManager.downloadFiles(
          [uploadedFileInfo],
          {
            actHistoryAddress: uploadedFileInfo.content.historyRef,
            actPublisher,
          },
          { signal: controller1.signal },
        ),
      ).rejects.toThrow();

      // Second download should succeed (not aborted)
      const result = await fileManager.downloadFiles(
        [uploadedFileInfo],
        {
          actHistoryAddress: uploadedFileInfo.content.historyRef,
          actPublisher,
        },
        { signal: controller2.signal },
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('listFolder', () => {
    const folderName = 'it-abort-listfolder-folder';
    const fileInFolder = `${folderName}/it-abort-listfolder-file.txt`;
    let folderInfo: FolderInfo;

    beforeAll(async () => {
      folderInfo = await fileManager.createFolder(drive.id, ROOT_PATH, folderName);

      fs.mkdirSync(folderName, { recursive: true });
      fs.writeFileSync(fileInFolder, 'listFolder abort test content');
      await fileManager.uploadFile(drive.id, { path: fileInFolder, sourcePath: fileInFolder });
    });

    afterAll(() => {
      fs.rmSync(folderName, { recursive: true, force: true });
    });

    it('should throw error when listFolder is aborted with pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort

      await expect(
        fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, { signal: controller.signal }),
      ).rejects.toThrow();
    });

    it('should throw error when listFolder is cancelled mid-flight', async () => {
      const controller = new AbortController();

      const listPromise = fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, {
        signal: controller.signal,
      });

      setTimeout(() => {
        controller.abort();
      }, 1);

      await expect(listPromise).rejects.toThrow();
    });

    it('should complete listFolder successfully when signal is not aborted', async () => {
      const controller = new AbortController();

      const result = await fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, {
        signal: controller.signal,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle multiple listFolder calls with different abort controllers', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      controller1.abort(); // Pre-abort first one

      // First call should fail (aborted)
      await expect(
        fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, { signal: controller1.signal }),
      ).rejects.toThrow();

      // Second call should succeed (not aborted)
      const result = await fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, {
        signal: controller2.signal,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
