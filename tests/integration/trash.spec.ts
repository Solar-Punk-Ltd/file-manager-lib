import { BatchId, Bee, Identifier } from '@ethersphere/bee-js';

import { createInitializedFileManager } from '../utils';

import { setupUserDrive, tempFileRegistry } from './setup/utils';

import { FileManagerBase } from '@/fileManager';
import { DriveInfo, FileRecord, NodeStatus } from '@/types';
import { ROOT_PATH } from '@/utils/constants';

// TODO: missing recoverFolder
describe('Lifecycle management', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let adminBatch: string | BatchId;
  let testFi: FileRecord;
  let drive: DriveInfo;
  const TEST_NAME = 'trash-restore-forget.txt';
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({
      bee,
      fileManager,
      drive,
      ownerStamp: adminBatch,
    } = await setupUserDrive('fileoperations', { stampLabel: 'fileOpsIntegration' }));

    // Flat, cwd-relative name: upload()'s `path` doubles as both the on-disk source and the
    // top-level drive manifest fork name, so it must resolve with zero intermediate segments.
    writeTempFile(TEST_NAME, 'file ops content');
    await fileManager.uploadFile(drive.id, { path: TEST_NAME, sourcePath: TEST_NAME });

    testFi = fileManager.recordList.find((fr) => fr.path === TEST_NAME)!;
    expect(testFi).toBeDefined();
    expect(testFi.status).toBe(NodeStatus.Active);
  });

  afterAll(cleanup);

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
