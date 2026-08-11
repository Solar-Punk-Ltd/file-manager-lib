import path from 'path';

import { retryOnPropagationDelay, streamToUint8Array } from '../utils';

import { setupUserDrive, tempFileRegistry } from './setup/utils';

import { type FileManagerBase } from '@/fileManager';
import { type DriveInfo, ListDepth, NodeType } from '@/types';

describe('End-to-End User Workflow', () => {
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, writeTempDir, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ fileManager, drive } = await setupUserDrive('e2e-workflow', { stampLabel: 'e2eWorkflowIntegration' }));
  });

  afterAll(cleanup);

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

    // Update just one file in place: rewrite the on-disk source and point the update at it. The
    // manifest fork identity comes from reportFi; the disk source is independent of the drive path.
    const projectDir = writeTempDir('it-e2e-project', { 'report.txt': 'Report V2' });

    await fileManager.updateFile(drive.id, reportFi, { item: { sourcePath: path.join(projectDir, 'report.txt') } });

    const projectEntries = await retryOnPropagationDelay(() =>
      fileManager.listFolder(drive.id, 'it-e2e-project', ListDepth.Shallow),
    );
    expect(projectEntries.filter((e) => e.type === NodeType.File)).toHaveLength(2);

    const downloadResults = await retryOnPropagationDelay(async () => {
      const results = await fileManager.downloadFolder(drive.id, 'it-e2e-project');
      if (results.succeeded.length < 2) {
        throw new Error(`Expected 2 download results, got ${results.succeeded.length}`);
      }
      return results;
    });
    expect(downloadResults.failed).toEqual([]);
    const downloadedReport = downloadResults.succeeded.find((d) => d.path === 'it-e2e-project/report.txt');
    const downloadedNote = downloadResults.succeeded.find((d) => d.path === 'it-e2e-project/note.txt');
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
    expect(downloadResults.failed).toEqual([]);
    expect(downloadResults.succeeded).toHaveLength(3);
    const contents = Object.fromEntries(
      await Promise.all(
        downloadResults.succeeded.map(async (d) => [
          d.path,
          Buffer.from(await streamToUint8Array(d.result)).toString('utf-8'),
        ]),
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
