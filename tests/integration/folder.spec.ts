import { type BatchId, Identifier, Reference, Topic } from '@ethersphere/bee-js';

import {
  buyStampSerialized,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  retryOnPropagationDelay,
  streamToUint8Array,
} from '../utils';

import { ensureUniqueSignerWithStamp, setupUserDrive, tempFileRegistry } from './setup/utils';

import { type FileManagerBase } from '@/fileManager';
import { type DriveInfo, ListDepth, NodeType } from '@/types';
import { MANIFEST_METADATA_NODE_TOPIC, MANIFEST_METADATA_NODE_TYPE, ROOT_PATH } from '@/utils/constants';
import { generateRandomBytes } from '@/utils/crypto';

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
        fileManager.listFolder(drive.id, 'gallery', ListDepth.Shallow).then((r) => r.entries),
      );
      const fileEntries = entries.filter((e) => e.type === NodeType.File);
      expect(fileEntries.map((e) => e.path).sort()).toEqual(['gallery/a.txt', 'gallery/b.txt']);
    });

    it('returns an empty array for an empty folder', async () => {
      await fileManager.createFolder(drive.id, ROOT_PATH, 'empty-folder');

      const entries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, 'empty-folder', ListDepth.Shallow).then((r) => r.entries),
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

      const entries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, 'level1', ListDepth.Deep).then((r) => r.entries),
      );
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
        fileManager.listFolder(drive.id, 'guarded', ListDepth.Shallow).then((r) => r.entries),
      );
      const fileEntries = entries.filter((e) => e.type === NodeType.File);
      expect(fileEntries.map((e) => e.path)).toEqual(['guarded/good.txt']);
    });
  });

  describe('createFolder', () => {
    it('rejects a duplicate folder name and leaves exactly one folder in the listing', async () => {
      const first = await fileManager.createFolder(drive.id, ROOT_PATH, 'dupfolder');

      await expect(fileManager.createFolder(drive.id, ROOT_PATH, 'dupfolder')).rejects.toThrow(/already exists/i);

      const entries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, ROOT_PATH, ListDepth.Shallow).then((r) => r.entries),
      );
      const matches = entries.filter((e) => e.type === NodeType.Folder && e.path === 'dupfolder');
      expect(matches).toHaveLength(1);
      expect(matches[0].topic.toString()).toBe(first.topic.toString());
    });

    it('rejects a folder name already taken by a file', async () => {
      const srcFile = writeTempFile('it-createfolder-collide.txt', 'collide content');
      await fileManager.uploadFile(drive.id, { path: 'collide', sourcePath: srcFile });

      await expect(fileManager.createFolder(drive.id, ROOT_PATH, 'collide')).rejects.toThrow(/already exists/i);
    });

    it('rejects a duplicate nested folder without disturbing the existing subtree', async () => {
      const srcFile = writeTempFile('it-createfolder-nested.txt', 'nested content');
      const seed = await fileManager.uploadFiles(drive.id, [{ path: 'outer/inner/keep.txt', sourcePath: srcFile }], '');
      expect(seed.failed).toHaveLength(0);

      await expect(fileManager.createFolder(drive.id, 'outer', 'inner')).rejects.toThrow(/already exists/i);

      const entries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, 'outer/inner', ListDepth.Shallow).then((r) => r.entries),
      );
      expect(entries.some((e) => e.type === NodeType.File && e.path === 'outer/inner/keep.txt')).toBe(true);
    });
  });

  describe('downloadFolder', () => {
    it('reports a file it could not list, instead of returning a partial download as complete', async () => {
      const folderName = 'it-fold-listing-failure';
      const goodPath = `${folderName}/present.txt`;
      const src = writeTempFile('it-fold-present.txt', 'Present Content');

      await fileManager.createFolder(drive.id, ROOT_PATH, folderName);
      await fileManager.uploadFile(drive.id, { path: goodPath, sourcePath: src });

      // A genuine orphan: a file fork whose record feed was never written. No public write path can
      // produce this — every one of them writes the record before the fork that references it.
      const orphanTopic = new Topic(generateRandomBytes(Topic.LENGTH)).toString();
      const store = (fileManager as any).store;
      const publisher = (fileManager as any).publisher.toCompressedHex();
      const { host, node } = await store.resolveHostMantaray(drive, folderName, publisher);

      node.addFork('missing.txt', new Reference(orphanTopic), {
        [MANIFEST_METADATA_NODE_TOPIC]: orphanTopic,
        [MANIFEST_METADATA_NODE_TYPE]: NodeType.File,
      });
      await store.saveMantarayNode(node, host);

      const downloads = await retryOnPropagationDelay(async () => {
        const res = await fileManager.downloadFolder(drive.id, folderName);
        if (!res.succeeded.some((d) => d.path === goodPath)) {
          throw new Error('upload not yet propagated');
        }
        return res;
      });

      // The healthy file still downloads...
      const got = downloads.succeeded.find((d) => d.path === goodPath);
      expect(Buffer.from(await streamToUint8Array(got!.result)).toString('utf-8')).toBe('Present Content');

      // ...and the unlistable one is reported rather than silently missing.
      const missing = downloads.failed.find((f) => f.path === `${folderName}/missing.txt`);
      expect(missing).toBeDefined();
      expect(missing!.error).toContain('Could not list');

      node.removeFork('missing.txt');
      await store.saveMantarayNode(node, host);
    });

    it('defaults to the whole drive when path is omitted', async () => {
      const src = writeTempFile('it-downloadFolder-defaultpath.txt', 'default path content');
      const up = await fileManager.uploadFiles(drive.id, [{ path: 'defaultpath/deep/y.txt', sourcePath: src }], '');
      expect(up.failed).toHaveLength(0);

      const downloads = await retryOnPropagationDelay(async () => {
        const res = await fileManager.downloadFolder(drive.id);
        if (!res.succeeded.some((d) => d.path === 'defaultpath/deep/y.txt')) {
          throw new Error('nested upload not yet propagated');
        }
        return res;
      });

      const got = downloads.succeeded.find((d) => d.path === 'defaultpath/deep/y.txt');
      expect(Buffer.from(await streamToUint8Array(got!.result)).toString('utf-8')).toBe('default path content');
    });

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

      const entries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(drive.id, 'inbox', ListDepth.Deep).then((r) => r.entries),
      );
      const filePaths = entries.filter((e) => e.type === NodeType.File).map((e) => e.path);
      expect(filePaths).toContain('inbox/reports/q1.txt');
      expect(filePaths).not.toContain('reports/q1.txt');
      expect(filePaths).not.toContain('it-downloadFolder-dest-src.txt');

      const downloads = await retryOnPropagationDelay(() => fileManager.downloadFolder(drive.id, '/'));
      const got = downloads.succeeded.find((d) => d.path === 'inbox/reports/q1.txt');
      expect(downloads.failed).toEqual([]);
      expect(got).toBeDefined();
      expect(Buffer.from(await streamToUint8Array(got!.result)).toString('utf-8')).toBe('destination compose content');
    });
  });

  describe('move', () => {
    let moveBatchId: BatchId;

    beforeAll(async () => {
      const { bee: beeDev } = await ensureUniqueSignerWithStamp();

      moveBatchId = await buyStampSerialized(beeDev, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'movestamp');
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

      const rootEntries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(driveA.id, '', ListDepth.Shallow).then((r) => r.entries),
      );
      expect(rootEntries.some((e) => e.type === NodeType.Folder && e.path.replace(/^\//, '') === 'src')).toBe(false);

      const backupEntries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(driveA.id, 'backup', ListDepth.Shallow).then((r) => r.entries),
      );
      expect(backupEntries.some((e) => e.type === NodeType.Folder && e.path === 'backup/src')).toBe(true);

      const srcEntries = await retryOnPropagationDelay(() =>
        fileManager.listFolder(driveA.id, 'backup/src', ListDepth.Shallow).then((r) => r.entries),
      );
      const innerEntry = srcEntries.find((e) => e.type === NodeType.File);
      expect(innerEntry).toBeDefined();
      expect(innerEntry!.topic).toBe(originalTopic);
      expect(innerEntry!.path).toBe('backup/src/inner.txt');

      const movedFi = fileManager.recordList.find((fr) => fr.topic.toString() === originalTopic)!;
      expect(movedFi).toBeDefined();
      expect(movedFi.path).toBe('backup/src/inner.txt');

      const downloadResults = await retryOnPropagationDelay(() => fileManager.downloadFolder(driveA.id, 'backup/src'));
      expect(downloadResults.failed).toEqual([]);
      const downloaded = downloadResults.succeeded.find((d) => d.path === 'backup/src/inner.txt');
      expect(downloaded).toBeDefined();
      expect(Buffer.from(await streamToUint8Array(downloaded!.result)).toString('utf-8')).toBe('Inner File Content');
    });
  });
});
