import { FeedIndex, Identifier, type MantarayNode, Topic } from '@ethersphere/bee-js';

import { createInitializedFileManager, DEFAULT_MOCK_SIGNER, makeUploadSource } from '../utils';

import { applyDefaultMocks, createMockNodeAddresses, seedDummyFile, seedRecords } from './mock';

import { type FileManagerBase } from '@/fileManager';
import { type DriveInfo, type FileRecord, NodeStatus, NodeType } from '@/types';
import { FileManagerEvents } from '@/utils';
import { getFeedData } from '@/utils/bee';
import {
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_TRASHED_FROM,
  SWARM_ZERO_ADDRESS,
  TRASH_FOLDER_NAME,
} from '@/utils/constants';
import { getAllNodeEntries } from '@/utils/mantaray';

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
    await fm.uploadFile(drive.id, { path: 'notes.txt', ...makeUploadSource('package.json') });
    fileRecord = fm.recordList.find((f) => f.path === 'notes.txt')!;
  });

  const validFolderFeed = (): void => {
    (getFeedData as jest.Mock).mockResolvedValue({
      feedIndex: FeedIndex.fromBigInt(0n),
      feedIndexNext: FeedIndex.fromBigInt(1n),
      payload: {
        toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
      },
    });
  };

  const driveRoot = (): MantarayNode => (fm as any).store.getManifestCache(drive.topic) as MantarayNode;
  const trashNode = (): MantarayNode => {
    const trashTopic = driveRoot().find(TRASH_FOLDER_NAME)?.metadata?.[MANIFEST_METADATA_NODE_TOPIC];
    return (fm as any).store.getManifestCache(trashTopic) as MantarayNode;
  };

  describe('trash', () => {
    it('relocates the fork into .trash keyed by topic, stamping the origin path', async () => {
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_TRASHED, handler);
      const versionBefore = fileRecord.version;

      await fm.trash(drive.id, 'notes.txt');

      expect(driveRoot().find('notes.txt')).toBeFalsy();
      const trashedFork = trashNode().find(fileRecord.topic);
      expect(trashedFork).toBeTruthy();
      expect(trashedFork?.metadata?.[MANIFEST_METADATA_TRASHED_FROM]).toBe('notes.txt');

      expect(fileRecord.path).toBe(`${TRASH_FOLDER_NAME}/${fileRecord.topic}`);
      expect(fileRecord.trashedFrom).toBe('notes.txt');
      expect(fileRecord.status).toBe(NodeStatus.Trashed);
      expect(fileRecord.version).toBe(versionBefore);
      expect(handler).toHaveBeenCalledWith({
        driveId: drive.id,
        path: 'notes.txt',
        trashedPath: `${TRASH_FOLDER_NAME}/${fileRecord.topic}`,
        record: fileRecord,
      });
    });

    it('keeps two same-named files apart in the trash', async () => {
      validFolderFeed();
      await fm.createFolder(drive.id, '', 'A');
      await fm.createFolder(drive.id, '', 'B');
      await fm.uploadFile(drive.id, { path: 'A/dup.txt', ...makeUploadSource('package.json') });
      await fm.uploadFile(drive.id, { path: 'B/dup.txt', ...makeUploadSource('package.json') });

      const inA = fm.recordList.find((f) => f.path === 'A/dup.txt')!;
      const inB = fm.recordList.find((f) => f.path === 'B/dup.txt')!;

      await fm.trash(drive.id, 'A/dup.txt');
      await fm.trash(drive.id, 'B/dup.txt');

      expect(trashNode().find(inA.topic)?.metadata?.[MANIFEST_METADATA_TRASHED_FROM]).toBe('A/dup.txt');
      expect(trashNode().find(inB.topic)?.metadata?.[MANIFEST_METADATA_TRASHED_FROM]).toBe('B/dup.txt');
    });

    it('rewrites descendant record paths when a folder is trashed', async () => {
      validFolderFeed();
      const folder = await fm.createFolder(drive.id, '', 'Docs');
      seedRecords(fm, seedDummyFile(drive, 'Docs/a.txt', SWARM_ZERO_ADDRESS.toString(), owner, actPublisher));

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FOLDER_TRASHED, handler);

      await fm.trash(drive.id, 'Docs');

      const descendant = fm.recordList.find((f) => f.topic === Topic.fromString('dl-Docs/a.txt').toString())!;
      expect(descendant.path).toBe(`${TRASH_FOLDER_NAME}/${folder.topic}/a.txt`);
      expect(descendant.status).toBe(NodeStatus.Trashed);
      expect(handler).toHaveBeenCalledWith({
        driveId: drive.id,
        path: 'Docs',
        trashedPath: `${TRASH_FOLDER_NAME}/${folder.topic}`,
      });
    });

    it('refuses the drive root, a reserved path and a missing path', async () => {
      await expect(fm.trash(drive.id, '/')).rejects.toThrow('Cannot trash drive root');
      await expect(fm.trash(drive.id, TRASH_FOLDER_NAME)).rejects.toThrow(/reserved/);
      await expect(fm.trash(drive.id, 'ghost.txt')).rejects.toThrow('Path not found: ghost.txt');
    });

    it('throws when the drive is not found', async () => {
      const ghostDrive = Identifier.fromString('ghost-drive').toString();
      await expect(fm.trash(ghostDrive, 'notes.txt')).rejects.toThrow(
        `Drive with id ${ghostDrive.slice(0, 6)} not found`,
      );
    });

    it('leaves the file unreadable through updateFile until it is recovered', async () => {
      await fm.trash(drive.id, 'notes.txt');

      await expect(fm.updateFile(drive.id, fileRecord, { customMetadata: { a: 'b' } })).rejects.toThrow(
        /Cannot update a trashed file/,
      );
    });
  });

  describe('recover', () => {
    it('restores the fork to its stamped origin and emits FILE_RECOVERED', async () => {
      await fm.trash(drive.id, 'notes.txt');
      const trashedPath = `${TRASH_FOLDER_NAME}/${fileRecord.topic}`;

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_RECOVERED, handler);
      validFolderFeed();

      const restoredPath = await fm.recover(drive.id, trashedPath);

      expect(restoredPath).toBe('notes.txt');
      expect(driveRoot().find('notes.txt')).toBeTruthy();
      expect(trashNode().find(fileRecord.topic)).toBeFalsy();
      expect(driveRoot().find('notes.txt')?.metadata?.[MANIFEST_METADATA_TRASHED_FROM]).toBeUndefined();

      expect(fileRecord.path).toBe('notes.txt');
      expect(fileRecord.trashedFrom).toBeUndefined();
      expect(fileRecord.status).toBe(NodeStatus.Active);
      expect(handler).toHaveBeenCalledWith({
        driveId: drive.id,
        trashedPath,
        restoredPath: 'notes.txt',
        record: fileRecord,
      });
    });

    it('restores to an explicit destination when one is given', async () => {
      validFolderFeed();
      await fm.createFolder(drive.id, '', 'Archive');
      await fm.trash(drive.id, 'notes.txt');

      const restoredPath = await fm.recover(drive.id, `${TRASH_FOLDER_NAME}/${fileRecord.topic}`, 'Archive/notes.txt');

      expect(restoredPath).toBe('Archive/notes.txt');
      expect(fileRecord.path).toBe('Archive/notes.txt');
      expect(driveRoot().find('notes.txt')).toBeFalsy();
    });

    it('refuses an occupied destination instead of overwriting it', async () => {
      await fm.trash(drive.id, 'notes.txt');
      validFolderFeed();
      await fm.uploadFile(drive.id, { path: 'notes.txt', ...makeUploadSource('package.json') });

      await expect(fm.recover(drive.id, `${TRASH_FOLDER_NAME}/${fileRecord.topic}`)).rejects.toThrow(
        'Destination already exists: notes.txt',
      );
      expect(trashNode().find(fileRecord.topic)).toBeTruthy();
    });

    it('rejects a path that is not a trashed node, and a node that is not trashed', async () => {
      await expect(fm.recover(drive.id, 'notes.txt')).rejects.toThrow(/Not a trashed node path/);
      await expect(fm.recover(drive.id, `${TRASH_FOLDER_NAME}/${fileRecord.topic}`)).rejects.toThrow(
        /Not trashed, cannot recover/,
      );
    });
  });

  describe('emptyTrash', () => {
    it('de-references every trashed node in one pass and drops their records', async () => {
      await fm.trash(drive.id, 'notes.txt');
      validFolderFeed();

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.TRASH_EMPTIED, handler);
      (getAllNodeEntries as jest.Mock).mockReturnValue([
        {
          path: fileRecord.topic,
          type: NodeType.File,
          topic: fileRecord.topic,
          rawMetadata: { [MANIFEST_METADATA_TRASHED_FROM]: 'notes.txt' },
        },
      ]);

      const count = await fm.emptyTrash(drive.id);

      expect(count).toBe(1);
      expect(trashNode().find(fileRecord.topic)).toBeFalsy();
      expect(fm.recordList.some((f) => f.topic === fileRecord.topic)).toBe(false);
      expect(handler).toHaveBeenCalledWith({ driveId: drive.id, count: 1 });
    });

    it('is a no-op for a drive that never had a trash folder', async () => {
      expect(await fm.emptyTrash(drive.id)).toBe(0);
    });
  });

  describe('listTrash', () => {
    it('returns [] for a drive that never had anything trashed', async () => {
      expect(await fm.listTrash(drive.id)).toEqual([]);
    });
  });

  describe('forget', () => {
    it('throws when attempting to forget the drive root or the trash folder', async () => {
      await expect(fm.forget(drive.id, '/')).rejects.toThrow('Cannot forget drive root');
      await expect(fm.forget(drive.id, '')).rejects.toThrow('Cannot forget drive root');
      await expect(fm.forget(drive.id, TRASH_FOLDER_NAME)).rejects.toThrow('use emptyTrash');
    });

    it('removes a file fork and its recordList entry, emitting FILE_FORGOTTEN', async () => {
      await fm.uploadFile(drive.id, { path: 'package.json', ...makeUploadSource('package.json') });
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

      seedRecords(fm, seedDummyFile(drive, 'Docs/a.txt', SWARM_ZERO_ADDRESS.toString(), owner, actPublisher));

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FOLDER_FORGOTTEN, handler);

      await fm.forget(drive.id, 'Docs');

      expect(fm.recordList.some((f) => f.path.startsWith('Docs/'))).toBe(false);
      expect(handler).toHaveBeenCalledWith({ driveInfo: drive, path: 'Docs' });
    });

    it('forgets only the targeted file when a same-named file exists in another folder', async () => {
      await fm.createFolder(drive.id, '', 'A');
      await fm.createFolder(drive.id, '', 'B');

      validFolderFeed();

      await fm.uploadFile(drive.id, { path: 'A/dup.txt', ...makeUploadSource('package.json') });
      await fm.uploadFile(drive.id, { path: 'B/dup.txt', ...makeUploadSource('package.json') });

      const inB = fm.recordList.find((f) => f.path === 'B/dup.txt')!;
      expect(fm.recordList.find((f) => f.path === 'A/dup.txt')).toBeDefined();
      expect(inB).toBeDefined();

      await fm.trash(drive.id, 'B/dup.txt');
      expect(inB.path).toBe(`${TRASH_FOLDER_NAME}/${inB.topic}`);

      await fm.forget(drive.id, 'A/dup.txt');

      expect(fm.recordList.find((f) => f.path === 'A/dup.txt')).toBeUndefined();
      expect(fm.recordList.find((f) => f.topic === inB.topic)).toBeDefined();
    });
  });
});
