import { type BatchId, Identifier } from '@ethersphere/bee-js';

import { createInitializedFileManager, retryOnPropagationDelay } from '../utils';

import { setupUserDrive, tempFileRegistry } from './setup/utils';

import { FileManagerBase } from '@/fileManager';
import type { BeeClient } from '@/swarm';
import { type DriveInfo, type FileRecord, ListDepth, NodeStatus, NodeType } from '@/types';
import { ROOT_PATH, TRASH_FOLDER_NAME } from '@/utils/constants';

describe('Lifecycle management', () => {
  let client: BeeClient;
  let fileManager: FileManagerBase;
  let adminBatch: string | BatchId;
  let testFi: FileRecord;
  let drive: DriveInfo;
  const TEST_NAME = 'trash-restore-forget.txt';
  let testSrc: string;
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({
      client,
      fileManager,
      drive,
      ownerStamp: adminBatch,
    } = await setupUserDrive('fileoperations', { stampLabel: 'fileOpsIntegration' }));

    testSrc = writeTempFile(TEST_NAME, 'file ops content');
    await fileManager.uploadFile(drive.id, { path: TEST_NAME, sourcePath: testSrc });

    testFi = fileManager.recordList.find((fr) => fr.path === TEST_NAME)!;
    expect(testFi).toBeDefined();
    expect(testFi.status).toBe(NodeStatus.Active);
  });

  afterAll(cleanup);

  const freshInstance = async (): Promise<FileManagerBase> => await createInitializedFileManager(client, adminBatch);

  it('trashes a file: a fresh instance stops listing it and finds it in the trash instead', async () => {
    const initial = fileManager.recordList.find((fr) => fr.path === TEST_NAME)!;
    const beforeVersion = BigInt((initial.version ?? '0').toString());

    await fileManager.trash(drive.id, TEST_NAME);

    expect(initial.status).toBe(NodeStatus.Trashed);
    expect(initial.path).toBe(`${TRASH_FOLDER_NAME}/${initial.topic}`);
    expect(initial.trashedFrom).toBe(TEST_NAME);

    const fm2 = await freshInstance();
    const listed = (await fm2.listFolder(new Identifier(drive.id), ROOT_PATH, ListDepth.Deep)).entries;

    expect(listed.some((e) => e.path === TEST_NAME)).toBe(false);
    expect(listed.some((e) => e.path === TRASH_FOLDER_NAME)).toBe(false);

    const trashed = (await fm2.listTrash(drive.id)).entries;
    const found = trashed.find((e) => e.topic === initial.topic)!;

    expect(found).toBeDefined();
    expect(found.status).toBe(NodeStatus.Trashed);
    expect(found.trashedFrom).toBe(TEST_NAME);
    expect(BigInt(found.version!.toString())).toBe(beforeVersion);
  });

  it('recovers the file back to its origin without touching its version', async () => {
    const beforeVersion = BigInt(testFi.version!.toString());

    const restoredPath = await fileManager.recover(drive.id, `${TRASH_FOLDER_NAME}/${testFi.topic}`);

    expect(restoredPath).toBe(TEST_NAME);
    expect(testFi.status).toBe(NodeStatus.Active);
    expect(testFi.path).toBe(TEST_NAME);

    const fi2 = await retryOnPropagationDelay(async () => {
      const fm2 = await freshInstance();
      await fm2.listFolder(drive.id, ROOT_PATH);
      const recovered = fm2.recordList.find((fr) => fr.path === TEST_NAME);
      if (!recovered) {
        throw new Error('recover not yet propagated to a fresh instance');
      }
      return recovered;
    });

    expect(fi2.status).toBe(NodeStatus.Active);
    expect(BigInt(fi2.version!.toString())).toBe(beforeVersion);
  });

  it('trashes a folder and its subtree in two manifest writes, and recovers it whole', async () => {
    const FOLDER_NAME = 'trash-recover-folder';
    const src = writeTempFile('folder-child.txt', 'child content');
    const folder = await fileManager.createFolder(drive.id, ROOT_PATH, FOLDER_NAME);
    await fileManager.uploadFile(drive.id, { path: `${FOLDER_NAME}/child.txt`, sourcePath: src });

    await fileManager.trash(drive.id, FOLDER_NAME);

    const trashedRoots = await retryOnPropagationDelay(async () => {
      const fm2 = await freshInstance();
      const entries = (await fm2.listFolder(drive.id, ROOT_PATH, ListDepth.Deep)).entries;
      if (entries.some((e) => e.path.startsWith(FOLDER_NAME))) {
        throw new Error('folder trash not yet propagated to a fresh instance');
      }
      return (await fm2.listTrash(drive.id, ListDepth.Deep)).entries;
    });

    const child = trashedRoots.find((e) => e.path === `${TRASH_FOLDER_NAME}/${folder.topic}/child.txt`)!;
    expect(child).toBeDefined();
    expect(child.trashedFrom).toBe(`${FOLDER_NAME}/child.txt`);

    const restoredPath = await fileManager.recover(drive.id, `${TRASH_FOLDER_NAME}/${folder.topic}`);
    expect(restoredPath).toBe(FOLDER_NAME);

    const recovered = await retryOnPropagationDelay(async () => {
      const fm2 = await freshInstance();
      const entries = (await fm2.listFolder(drive.id, ROOT_PATH, ListDepth.Deep)).entries;
      const found = entries.find((e) => e.path === `${FOLDER_NAME}/child.txt`);
      if (!found) {
        throw new Error('folder recover not yet propagated to a fresh instance');
      }
      return found;
    });

    expect(recovered.status).toBe(NodeStatus.Active);
  });

  it('keeps two same-named files apart in the trash and restores each to its own folder', async () => {
    const src = writeTempFile('it-trash-dup.txt', 'dup content');
    const up = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'ta/dup.txt', sourcePath: src },
        { path: 'tb/dup.txt', sourcePath: src },
      ],
      '',
    );
    expect(up.failed).toHaveLength(0);

    const inA = fileManager.recordList.find((fr) => fr.path === 'ta/dup.txt')!;
    const inB = fileManager.recordList.find((fr) => fr.path === 'tb/dup.txt')!;

    await fileManager.trash(drive.id, 'ta/dup.txt');
    await fileManager.trash(drive.id, 'tb/dup.txt');

    const trashed = await retryOnPropagationDelay(async () => {
      const fm2 = await freshInstance();
      const entries = (await fm2.listTrash(drive.id)).entries;
      if (entries.filter((e) => e.trashedFrom?.endsWith('dup.txt')).length !== 2) {
        throw new Error('both trashed nodes not yet propagated to a fresh instance');
      }
      return entries;
    });

    expect(trashed.find((e) => e.topic === inA.topic)!.trashedFrom).toBe('ta/dup.txt');
    expect(trashed.find((e) => e.topic === inB.topic)!.trashedFrom).toBe('tb/dup.txt');

    expect(await fileManager.recover(drive.id, `${TRASH_FOLDER_NAME}/${inA.topic}`)).toBe('ta/dup.txt');
    expect(await fileManager.recover(drive.id, `${TRASH_FOLDER_NAME}/${inB.topic}`)).toBe('tb/dup.txt');
  });

  it('recovers to an explicit destination when the origin folder is gone', async () => {
    const src = writeTempFile('it-orphan.txt', 'orphan content');
    await fileManager.uploadFiles(drive.id, [{ path: 'doomed/orphan.txt', sourcePath: src }], '');

    const record = fileManager.recordList.find((fr) => fr.path === 'doomed/orphan.txt')!;
    await fileManager.trash(drive.id, 'doomed/orphan.txt');
    await fileManager.forget(drive.id, 'doomed');

    const trashedPath = `${TRASH_FOLDER_NAME}/${record.topic}`;
    await expect(fileManager.recover(drive.id, trashedPath)).rejects.toThrow(/Path not found/);

    expect(await fileManager.recover(drive.id, trashedPath, 'orphan.txt')).toBe('orphan.txt');

    const listed = await retryOnPropagationDelay(async () => {
      const fm2 = await freshInstance();
      const entries = (await fm2.listFolder(drive.id, ROOT_PATH)).entries;
      if (!entries.some((e) => e.path === 'orphan.txt')) {
        throw new Error('explicit recover not yet propagated to a fresh instance');
      }
      return entries;
    });

    expect(listed.some((e) => e.path === 'orphan.txt')).toBe(true);
  });

  it('refuses to update a trashed file, and refuses the trash folder as a write destination', async () => {
    const src = writeTempFile('it-guarded.txt', 'guarded content');
    await fileManager.uploadFile(drive.id, { path: 'guarded.txt', sourcePath: src });
    const record = fileManager.recordList.find((fr) => fr.path === 'guarded.txt')!;

    await fileManager.trash(drive.id, 'guarded.txt');

    await expect(fileManager.updateFile(drive.id, record, { customMetadata: { a: 'b' } })).rejects.toThrow(
      /Cannot update a trashed file/,
    );
    await expect(
      fileManager.uploadFile(drive.id, { path: `${TRASH_FOLDER_NAME}/sneaky.txt`, sourcePath: src }),
    ).rejects.toThrow(/reserved/);
    await expect(fileManager.createFolder(drive.id, ROOT_PATH, TRASH_FOLDER_NAME)).rejects.toThrow(/reserved/);
    await expect(fileManager.move('guarded.txt', `${TRASH_FOLDER_NAME}/x.txt`, drive.id)).rejects.toThrow(/reserved/);
  });

  it('empties the trash in one write and leaves the active tree untouched', async () => {
    const src = writeTempFile('it-empty.txt', 'empty me');
    await fileManager.uploadFile(drive.id, { path: 'keep.txt', sourcePath: src });
    await fileManager.uploadFile(drive.id, { path: 'discard.txt', sourcePath: src });
    await fileManager.trash(drive.id, 'discard.txt');

    const count = await fileManager.emptyTrash(drive.id);
    expect(count).toBeGreaterThan(0);
    expect((await fileManager.listTrash(drive.id)).entries).toEqual([]);

    const listed = await retryOnPropagationDelay(async () => {
      const fm2 = await freshInstance();
      const entries = (await fm2.listTrash(drive.id)).entries;
      if (entries.length > 0) {
        throw new Error('emptied trash not yet propagated to a fresh instance');
      }
      return (await fm2.listFolder(drive.id, ROOT_PATH)).entries;
    });

    expect(listed.some((e) => e.path === 'keep.txt')).toBe(true);
    expect(listed.some((e) => e.path === 'discard.txt')).toBe(false);
  });

  it('should forget (hard-delete) a file', async () => {
    await fileManager.forget(drive.id, TEST_NAME);
    expect(fileManager.recordList.find((fr) => fr.path === TEST_NAME)).toBeUndefined();

    const fm2 = new FileManagerBase(client);
    await fm2.initialize();

    expect(fm2.recordList.find((fr) => fr.path === TEST_NAME)).toBeUndefined();
  });

  it('forgets only the targeted file, leaving the same-named file in the other folder', async () => {
    const src = writeTempFile('it-forget-dup.txt', 'dup content');
    const up = await fileManager.uploadFiles(
      drive.id,
      [
        { path: 'fa/dup.txt', sourcePath: src },
        { path: 'fb/dup.txt', sourcePath: src },
      ],
      '',
    );
    expect(up.failed).toHaveLength(0);

    await fileManager.forget(drive.id, 'fa/dup.txt');

    expect(fileManager.recordList.find((fr) => fr.path === 'fa/dup.txt')).toBeUndefined();
    expect(fileManager.recordList.find((fr) => fr.path === 'fb/dup.txt')).toBeDefined();

    const faEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(drive.id, 'fa', ListDepth.Shallow).then((r) => r.entries),
    );
    expect(faEntries.some((e) => e.type === NodeType.File)).toBe(false);

    const fbEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(drive.id, 'fb', ListDepth.Shallow).then((r) => r.entries),
    );
    expect(fbEntries.some((e) => e.type === NodeType.File && e.path === 'fb/dup.txt')).toBe(true);
  });
});
