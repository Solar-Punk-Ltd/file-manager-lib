import {
  BatchId,
  Bee,
  Bytes,
  FeedIndex,
  Identifier,
  type MantarayNode,
  RedundancyLevel,
  Topic,
} from '@ethersphere/bee-js';

import { createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { applyDefaultMocks, createMockDriveInfo, createMockNodeAddresses, seedDummyFile, seedRecords } from './mock';

import { ListDepth, type NodeHeader, NodeType } from '@/types';
import { FileManagerEvents } from '@/utils';
import { getFeedData } from '@/utils/bee';
import { SWARM_ZERO_ADDRESS } from '@/utils/constants';

describe('Folder operations', () => {
  const otherMockBatchId = new BatchId('4'.repeat(64));
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();
  const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();

  beforeEach(async () => {
    applyDefaultMocks();
  });

  describe('downloadFolder', () => {
    it('downloadFolder downloads every hydrated file belonging to the drive', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      seedRecords(
        fm,
        seedDummyFile(drive, 'a.txt', '1'.repeat(64), owner, actPublisher),
        seedDummyFile(drive, 'b.txt', '2'.repeat(64), owner, actPublisher),
      );

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');

      const results = await fm.downloadFolder(drive.id, '/');

      expect(downloadReadableDataSpy).toHaveBeenCalledWith(
        '1'.repeat(64),
        { actHistoryAddress: SWARM_ZERO_ADDRESS.toString(), actPublisher },
        undefined,
      );
      expect(downloadReadableDataSpy).toHaveBeenCalledWith(
        '2'.repeat(64),
        { actHistoryAddress: SWARM_ZERO_ADDRESS.toString(), actPublisher },
        undefined,
      );

      expect(downloadReadableDataSpy).toHaveBeenCalledTimes(2);
      expect(results.succeeded.map((r) => r.path).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('downloadFolder does not download files belonging to a different drive', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const otherDrive = createMockDriveInfo(actPublisher, { id: Identifier.fromString('other-drive').toString() });
      seedRecords(fm, seedDummyFile(drive, 'mine.txt', '1'.repeat(64), owner, actPublisher));
      seedRecords(fm, seedDummyFile(otherDrive, 'not-mine.txt', '2'.repeat(64), owner, actPublisher));

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');

      const downloadResults = await fm.downloadFolder(drive.id, '/');

      expect(downloadReadableDataSpy).toHaveBeenCalledTimes(1);
      expect(downloadResults.failed).toEqual([]);
      expect(downloadResults.succeeded).toHaveLength(1);
      expect(downloadResults.succeeded[0].path).toBe('mine.txt');
    });
  });

  describe('listFolder', () => {
    it('returns shallow entries and hydrates newly discovered files exactly once', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      const topicA = Topic.fromString('list-a').toString();
      const topicB = Topic.fromString('list-b').toString();
      const entryA: NodeHeader = { path: 'a.txt', type: NodeType.File, topic: topicA, rawMetadata: {} };
      const entryB: NodeHeader = { path: 'b.txt', type: NodeType.File, topic: topicB, rawMetadata: {} };

      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      const { getAllNodeEntries } = require('@/utils/mantaray');
      getAllNodeEntries.mockReturnValue([entryA, entryB]);

      // b.txt is already hydrated -> must be skipped during this call
      seedRecords(fm, {
        type: NodeType.File,
        batchId: DUMMY_BATCH_ID,
        owner,
        actPublisher,
        redundancyLevel: RedundancyLevel.OFF,
        topic: topicB,
        driveId: drive.id,
        path: 'b.txt',
        content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
      });

      // Clear the calls made by createInitializedFileManager()'s own bootstrap so the count below
      // reflects only this listFolder() invocation.
      (getFeedData as jest.Mock).mockClear();
      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(0n),
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });
      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(
        Bytes.fromUtf8(
          JSON.stringify({
            type: NodeType.File,
            batchId: DUMMY_BATCH_ID,
            owner,
            actPublisher,
            topic: topicA,
            driveId: drive.id,
            path: 'a.txt',
            redundancyLevel: RedundancyLevel.OFF,
            content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
          }),
        ),
      );

      // listFolder now returns hydrated FileRecords (not raw headers): a.txt fetched, b.txt from cache.
      const results = await fm.listFolder(drive.id, '');

      expect(results).toHaveLength(2);
      const byTopic = Object.fromEntries(results.map((r) => [r.topic, r]));
      expect(byTopic[topicA].type).toBe(NodeType.File);
      expect(byTopic[topicA].path).toBe('a.txt');
      expect(byTopic[topicB].path).toBe('b.txt');
      expect(fm.recordList.filter((f) => f.topic === topicA)).toHaveLength(1);
      expect(fm.recordList.filter((f) => f.topic === topicB)).toHaveLength(1);
      // Only a.txt triggers a feed lookup; b.txt is served from the cache.
      expect(getFeedData).toHaveBeenCalledTimes(1);
    });

    it('throws when a segment of the folder path does not exist', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.listFolder(drive.id, 'missing-folder')).rejects.toThrow('Path not found: /missing-folder');
    });

    it('stops expanding after maxDepth levels when depth is Deep', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const folderTopic = Topic.fromString('sub-folder').toString();
      const folderEntry: NodeHeader = { path: 'sub', type: NodeType.Folder, topic: folderTopic, rawMetadata: {} };

      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      const { getAllNodeEntries } = require('@/utils/mantaray');
      getAllNodeEntries.mockReturnValue([folderEntry]);

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(0n),
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });

      const results = await fm.listFolder(drive.id, '', ListDepth.Deep, 1);

      // Resolved into a hydrated FolderInfo; maxDepth=1 stops before recursing into it.
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe(NodeType.Folder);
      expect(results[0].topic).toBe(folderTopic);
      expect(results[0].path).toBe('sub');
    });
  });

  describe('createFolder', () => {
    it('creates a new folder fork under the drive root and updates the drive manifestRef', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      const folderInfo = await fm.createFolder(drive.id, '', 'Documents');

      expect(folderInfo.path).toBe('Documents');
      expect(folderInfo.driveId).toBe(drive.id);

      const updatedDrive = fm.driveList.find((d) => d.id === drive.id)!;
      expect(updatedDrive.manifestRef).toBeDefined();

      const driveMantaray = (fm as any).store.getManifestCache(drive.topic) as MantarayNode;
      expect(driveMantaray.find('Documents')).toBeTruthy();
    });

    it('builds a nested folder path without a leading slash', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await fm.createFolder(drive.id, '', 'Documents');

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(0n),
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });

      const nested = await fm.createFolder(drive.id, 'Documents', 'Reports');

      expect(nested.path).toBe('Documents/Reports');
    });

    it('emits FOLDER_CREATED with the created folder info', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FOLDER_CREATED, handler);

      const folderInfo = await fm.createFolder(drive.id, '', 'Documents');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ folderInfo });
    });

    it('throws on an invalid folder name containing a slash', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.createFolder(drive.id, '', 'a/b')).rejects.toThrow('Invalid folder name');
    });
  });

  describe('move', () => {
    it('refreshes trashed descendants overlay paths on a same-drive folder move', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      await fm.createFolder(drive.id, '', 'Docs');

      const descendantTopic = Topic.fromString('doc-a').toString();
      drive.trashedNodes = [{ topic: descendantTopic, type: NodeType.File, path: 'Docs/a.txt' }];

      await fm.move('Docs', 'Archive', drive.id);

      expect(drive.trashedNodes).toEqual([{ topic: descendantTopic, type: NodeType.File, path: 'Archive/a.txt' }]);
    });

    it('relocates trashed descendants to the target drive on a cross-drive folder move', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Target Drive');
      const source = fm.driveList[0];
      const target = fm.driveList[1];
      await fm.createFolder(source.id, '', 'Docs');

      const descendantTopic = Topic.fromString('doc-a').toString();
      source.trashedNodes = [{ topic: descendantTopic, type: NodeType.File, path: 'Docs/a.txt' }];

      await fm.move('Docs', 'Archive', source.id, target.id);

      expect(source.trashedNodes).toEqual([]);
      expect(target.trashedNodes).toContainEqual({
        topic: descendantTopic,
        type: NodeType.File,
        path: 'Archive/a.txt',
      });
    });

    it('throws when trying to move the drive root', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.move('/', 'x.txt', drive.id)).rejects.toThrow('Cannot move root folder');
    });
  });
});
