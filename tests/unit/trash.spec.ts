import { Bytes, FeedIndex, Identifier, MantarayNode, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import { createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { applyDefaultMocks, createMockNodeAddresses, seedRecords } from './mock';

import { FileManagerBase } from '@/fileManager';
import { DriveInfo, FileRecord, FolderInfo, NodeStatus, NodeType } from '@/types';
import { FileManagerEvents } from '@/utils';
import { getFeedData } from '@/utils/bee';
import { SWARM_ZERO_ADDRESS } from '@/utils/constants';

describe('Lifecycle management', () => {
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();
  const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();

  let fm: FileManagerBase;
  let drive: DriveInfo;
  let fileRecord: FileRecord;

  beforeEach(async () => {
    applyDefaultMocks();

    fm = await createInitializedFileManager();
    drive = fm.driveList[0];
    await fm.uploadFile(drive.id, { path: 'notes.txt', sourcePath: 'package.json' });
    fileRecord = fm.recordList.find((f) => f.path === 'notes.txt')!;
  });

  describe('trashFile', () => {
    it('records the file in the drive trash overlay without a version bump, and emits FILE_TRASHED', async () => {
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_TRASHED, handler);
      const versionBefore = fileRecord.version;

      await fm.trashFile(fileRecord);

      expect(fileRecord.status).toBe(NodeStatus.Trashed);
      expect(fileRecord.version).toBe(versionBefore);
      expect(drive.trashedNodes).toEqual([
        { topic: fileRecord.topic, type: NodeType.File, path: fileRecord.path, version: versionBefore },
      ]);
      expect(handler).toHaveBeenCalledWith({ record: fileRecord });
    });

    it('throws if the file is already trashed', async () => {
      await fm.trashFile(fileRecord);
      await expect(fm.trashFile(fileRecord)).rejects.toThrow(`Already trashed: ${fileRecord.path}`);
    });

    it('trashFile throws when the drive is not found', async () => {
      const ghost: FileRecord = { ...fileRecord, driveId: Identifier.fromString('ghost-drive').toString() };
      await expect(fm.trashFile(ghost)).rejects.toThrow(`Drive with id ${ghost.driveId.slice(0, 6)} not found`);
    });
  });

  describe('recoverFile', () => {
    it('removes the file from the overlay and emits FILE_RECOVERED', async () => {
      await fm.trashFile(fileRecord);
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_RECOVERED, handler);

      await fm.recoverFile(fileRecord);

      expect(fileRecord.status).toBe(NodeStatus.Active);
      expect(drive.trashedNodes).toEqual([]);
      expect(handler).toHaveBeenCalledWith({ record: fileRecord });
    });

    it('throws if the file was never trashed', async () => {
      await expect(fm.recoverFile(fileRecord)).rejects.toThrow(`Not trashed, cannot recover: ${fileRecord.path}`);
    });
  });

  describe('trashFolder', () => {
    it('records a folder in the overlay and emits FOLDER_TRASHED', async () => {
      const folder: FolderInfo = {
        type: NodeType.Folder,
        owner,
        actPublisher,
        topic: Topic.fromString('docs-folder').toString(),
        driveId: drive.id,
        path: 'Docs',
        batchId: DUMMY_BATCH_ID,
        redundancyLevel: RedundancyLevel.OFF,
      };
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FOLDER_TRASHED, handler);

      await fm.trashFolder(folder);

      expect(folder.status).toBe(NodeStatus.Trashed);
      expect(drive.trashedNodes).toContainEqual({ topic: folder.topic, type: NodeType.Folder, path: folder.path });
      expect(handler).toHaveBeenCalledWith({ folder });
    });
  });

  describe('listTrash', () => {
    it('hydrates the overlay into trashed NodeEntries', async () => {
      await fm.trashFile(fileRecord);

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(0n),
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: new Bytes(SWARM_ZERO_ADDRESS.toUint8Array()),
      });
      const spyFetch = jest
        .spyOn((fm as any).store, 'getRecord')
        .mockResolvedValue({ ...fileRecord, status: undefined });

      const trashed = await fm.listTrash(drive.id);

      expect(trashed).toHaveLength(1);
      expect(trashed[0].topic).toBe(fileRecord.topic);
      expect(trashed[0].status).toBe(NodeStatus.Trashed);
      expect(trashed[0].path).toBe(fileRecord.path);

      spyFetch.mockRestore();
    });
  });

  describe('forget', () => {
    it('throws when attempting to forget the drive root', async () => {
      await expect(fm.forget(drive.id, '/')).rejects.toThrow('Cannot forget drive root');
      await expect(fm.forget(drive.id, '')).rejects.toThrow('Cannot forget drive root');
    });

    it('removes a file fork and its recordList entry, emitting FILE_FORGOTTEN', async () => {
      await fm.uploadFile(drive.id, { path: 'package.json', sourcePath: 'package.json' });
      const uploaded = fm.recordList.find((f) => f.path === 'package.json')!;
      expect(uploaded).toBeDefined();

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_FORGOTTEN, handler);

      await fm.forget(drive.id, 'package.json');

      expect(fm.recordList.find((f) => f.path === 'package.json')).toBeUndefined();
      expect(handler).toHaveBeenCalledWith({ record: uploaded, path: 'package.json' });

      const driveMantaray = (fm as any).store.getManifestCache(drive.topic) as MantarayNode;
      expect(driveMantaray.find('package.json')).toBeFalsy();
    });

    it('removes a folder fork and purges all descendant recordList entries', async () => {
      await fm.createFolder(drive.id, '', 'Docs');

      seedRecords(fm, {
        type: NodeType.File,
        batchId: DUMMY_BATCH_ID,
        owner,
        actPublisher,
        topic: Topic.fromString('doc-a').toString(),
        driveId: drive.id,
        path: 'Docs/a.txt',
        content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
        redundancyLevel: RedundancyLevel.OFF,
      });

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FOLDER_FORGOTTEN, handler);

      await fm.forget(drive.id, 'Docs');

      expect(fm.recordList.some((f) => f.path.startsWith('Docs/'))).toBe(false);
      expect(handler).toHaveBeenCalledWith({ driveInfo: drive, path: 'Docs' });
    });
  });
});
