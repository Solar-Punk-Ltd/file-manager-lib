import { BatchId, Identifier } from '@ethersphere/bee-js';

import { DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, retryOnPropagationDelay, streamToUint8Array } from '../utils';

import { ensureUniqueSignerWithStamp, setupUserDrive, tempFileRegistry } from './setup/utils';

import { FileManagerBase } from '@/fileManager';
import { DriveInfo, ListDepth, NodeType } from '@/types';
import { buyStamp } from '@/utils/bee';
import { ROOT_PATH } from '@/utils/constants';

describe('Folder operations', () => {
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ fileManager, drive } = await setupUserDrive('folders', { stampLabel: 'folders' }));
  });

  afterAll(cleanup);

  describe('listFolder', () => {
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

      const entries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, 'gallery', ListDepth.Shallow),
      );
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

    it('rejects an entry with an empty path and leaves the folder listing unaffected', async () => {
      const fileGood = writeTempFile('it-listfolder-guard-good.txt', 'Good content');
      const fileBad = writeTempFile('it-listfolder-guard-bad.txt', 'Should not upload');

      const seed = await fileManager.uploadFiles(drive.id, [{ path: 'guarded/good.txt', sourcePath: fileGood }], '');
      expect(seed.failed).toHaveLength(0);

      await expect(fileManager.uploadFiles(drive.id, [{ path: '', sourcePath: fileBad }], 'guarded')).rejects.toThrow(
        /Invalid path/,
      );

      const entries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, 'guarded', ListDepth.Shallow),
      );
      const fileEntries = entries.filter((e) => e.type === NodeType.File);
      expect(fileEntries.map((e) => e.path)).toEqual(['guarded/good.txt']);
    });
  });

  describe('downloadFolder', () => {
    it('composes destinationPath with a relative item path — placement differs from destination and source', async () => {
      const srcFile = writeTempFile('it-downloadFolder-dest-src.txt', 'destination compose content');

      await fileManager.createFolder(drive.id, '', 'inbox');

      // destinationPath ('inbox') + relative item path ('reports/q1.txt') → placed at
      // 'inbox/reports/q1.txt', which equals neither the destination nor the on-disk source name.
      const result = await fileManager.uploadFiles(
        drive.id,
        [{ path: 'reports/q1.txt', sourcePath: srcFile }],
        'inbox',
      );
      expect(result.failed).toHaveLength(0);

      const entries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, 'inbox', ListDepth.Deep));
      const filePaths = entries.filter((e) => e.type === NodeType.File).map((e) => e.path);
      expect(filePaths).toContain('inbox/reports/q1.txt');
      expect(filePaths).not.toContain('reports/q1.txt');
      expect(filePaths).not.toContain('it-downloadFolder-dest-src.txt');

      const downloads = await retryOnPropagationDelay(() => fileManager.downloadFolder(drive.id, '/'));
      const got = downloads.find((d) => d.path === 'inbox/reports/q1.txt');
      expect(got).toBeDefined();
      expect(Buffer.from(await streamToUint8Array(got!.result)).toString('utf-8')).toBe('destination compose content');
    });
  });

  describe('move', () => {
    let moveBatchId: BatchId;

    beforeAll(async () => {
      const { bee: beeDev } = await ensureUniqueSignerWithStamp();

      moveBatchId = await buyStamp(beeDev, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'movestamp');
    });

    it('moves a folder as a unit, composing correct descendant paths at read time', async () => {
      await fileManager.createDrive(moveBatchId, 'move-folder-a');
      const tmpDriveA = fileManager.driveList.find((d) => d.name === 'move-folder-a');
      expect(tmpDriveA).toBeDefined();
      const driveA = tmpDriveA!;

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
      expect(innerEntry!.path).toBe('backup/src/inner.txt');

      const movedFi = fileManager.recordList.find((fr) => fr.topic.toString() === originalTopic)!;
      expect(movedFi).toBeDefined();
      expect(movedFi.path).toBe('backup/src/inner.txt');

      const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(driveA.id, 'backup/src'));
      const downloaded = downloadResults.find((d) => d.path === 'backup/src/inner.txt');
      expect(downloaded).toBeDefined();
      expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Inner File Content');
    });
  });
});
