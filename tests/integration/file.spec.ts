import { Bee, FeedIndex } from '@ethersphere/bee-js';
import path from 'path';

import {
  buyStamp,
  createInitializedFileManager,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  retryOnPropagationDelay,
  streamToUint8Array,
} from '../utils';

import { ensureUniqueSignerWithStamp, setupUserDrive, tempFileRegistry } from './setup/utils';

import { FileManagerBase } from '@/fileManager';
import { BeeClient } from '@/swarm';
import { DriveInfo, ListDepth, NodeType } from '@/types';
import { FileManagerEvents } from '@/utils';
import { FEED_INDEX_ZERO, ROOT_PATH } from '@/utils/constants';

describe('uploadFile', () => {
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, writeTempDir, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ fileManager, drive } = await setupUserDrive('upload', { stampLabel: 'uploadIntegrationStamp' }));
  });

  afterAll(cleanup);

  it('uploads a new file and adds it to the file record list at version 0', async () => {
    const name = writeTempFile('it-upload-new.txt', 'New Content');
    await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
    const record = fileManager.recordList.find((fr) => fr.path === name);
    expect(record).toBeDefined();
    expect(record!.version).toEqual(FEED_INDEX_ZERO.toString());
  });

  it('throws when uploading a directory — directories must go through uploadFiles', async () => {
    const dirPath = writeTempDir('it-upload-integration-dir', { 'inner.txt': 'Inner Content' });

    await expect(fileManager.uploadFile(drive.id, { path: dirPath, sourcePath: dirPath })).rejects.toThrow(
      'Cannot upload a directory - use uploadFiles',
    );
    expect(fileManager.recordList.some((fr) => fr.path === dirPath)).toBe(false);
  });
});

describe('uploadFiles', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, writeTempDir, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    const {
      bee: beeDev,
      fileManager: fm,
      drive: d,
    } = await setupUserDrive('uploadmany', { stampLabel: 'uploadManyIntegration' });

    bee = beeDev;
    fileManager = fm;
    drive = d;
  });

  afterAll(cleanup);

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

  it('uploads a nested folder with files and fetches them back', async () => {
    const rootFile = writeTempFile('it-init-nested-root.txt', 'Init nested root content');
    const nestedDir = 'it-init-nested-docs';
    const nestedFile = path.join(nestedDir, 'note.txt');
    writeTempDir(nestedDir, { 'note.txt': 'Init nested docs content' });

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

    const rootEntries = await retryOnPropagationDelay(() => fileManager.listFolder(drive.id, '', ListDepth.Shallow));
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
  });
});

describe('updateFile', () => {
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, writeTempDir, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ fileManager, drive } = await setupUserDrive('upload', { stampLabel: 'uploadIntegrationStamp' }));
  });

  afterAll(cleanup);

  it('re-versions a file with new bytes via update(), keeping the topic and advancing the version', async () => {
    const name = writeTempFile('it-upload-versions.txt', 'v0');
    await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
    const firstInfo = fileManager.recordList.find((fr) => fr.path === name)!;
    expect(firstInfo).toBeDefined();

    writeTempFile(name, 'v1');
    await fileManager.updateFile(drive.id, firstInfo, { item: { sourcePath: name } });
    const secondInfo = fileManager.recordList.find((fr) => fr.topic.toString() === firstInfo.topic.toString())!;
    expect(secondInfo.topic.toString()).toEqual(firstInfo.topic.toString());
    expect(secondInfo.version).toEqual(new FeedIndex(firstInfo.version!).next().toString());

    writeTempFile(name, 'v2');
    await fileManager.updateFile(drive.id, secondInfo, { item: { sourcePath: name } });
    const thirdInfo = fileManager.recordList.find((fr) => fr.topic.toString() === firstInfo.topic.toString())!;
    expect(thirdInfo.version).toEqual(new FeedIndex(secondInfo.version!).next().toString());
  });

  it('metadata-only update() keeps the same content ref across versions', async () => {
    const name = writeTempFile('it-upload-metadata.txt', 'Metadata Content');
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
  });

  it('should upload a single file and update the file record list', async () => {
    const tempFile = writeTempFile('it-upload-single-file.txt', 'Single File Content');
    await fileManager.uploadFile(drive.id, {
      path: tempFile,
      sourcePath: tempFile,
    });
    const recordList = fileManager.recordList;
    const uploadedInfo = recordList.find((fr) => fr.path === tempFile);
    expect(uploadedInfo).toBeDefined();
  });

  it('does not create a second record when bumping to a new version', async () => {
    const name = writeTempFile('it-upload-bump.txt', 'Bump Content');
    await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
    const original = fileManager.recordList.find((fr) => fr.path === name)!;
    expect(original).toBeDefined();

    await fileManager.updateFile(drive.id, original, { item: { sourcePath: name } });

    const entries = fileManager.recordList.filter((fr) => fr.topic.toString() === original.topic.toString());
    expect(entries).toHaveLength(1);
    expect(BigInt(entries[0].version!.toString())).toBeGreaterThan(BigInt(original.version?.toString() || '0'));
  });

  it('rejects a directory as the update() content source', async () => {
    const name = writeTempFile('it-update-dir-src.txt', 'Src Content');
    const dirPath = writeTempDir('it-update-dir-src', {});
    await fileManager.uploadFile(drive.id, { path: name, sourcePath: name });
    const record = fileManager.recordList.find((fr) => fr.path === name)!;

    await expect(fileManager.updateFile(drive.id, record, { item: { sourcePath: dirPath } })).rejects.toThrow(
      'Cannot upload a directory - use uploadFiles',
    );
  });
});

describe('downloadFile and downloadFiles', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    const {
      bee: beeDev,
      fileManager: fm,
      drive: d,
    } = await setupUserDrive('downloaddrive', { stampLabel: 'downloadIntegration' });

    bee = beeDev;
    fileManager = fm;
    drive = d;
  });

  afterAll(cleanup);

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

describe('move', () => {
  let client: BeeClient;
  let bee: Bee;
  let fileManager: FileManagerBase;
  let driveA: DriveInfo;
  let driveB: DriveInfo;
  const { writeTempFile, writeTempDir, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    const { client: bc, bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    client = bc;
    bee = beeDev;
    const batchIdA = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'moveIntegrationA');
    const batchIdB = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'moveIntegrationB');
    fileManager = await createInitializedFileManager(client, ownerStamp);

    await fileManager.createDrive(batchIdA, 'move-a');
    const tmpDriveA = fileManager.driveList.find((d) => d.name === 'move-a');
    expect(tmpDriveA).toBeDefined();
    driveA = tmpDriveA!;

    await fileManager.createDrive(batchIdB, 'move-b');
    const tmpDriveB = fileManager.driveList.find((d) => d.name === 'move-b');
    expect(tmpDriveB).toBeDefined();
    driveB = tmpDriveB!;
  });

  afterAll(cleanup);

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

    writeTempDir(folderName, { 'note.txt': 'Inbox Note' });
    const inboxFilePath = path.join(folderName, 'note.txt');

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
