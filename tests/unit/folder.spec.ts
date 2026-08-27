import { Bee, Bytes, FeedIndex, Identifier, RedundancyLevel, Topic } from '@ethersphere/bee-js';
import { type MantarayNode } from '@ethersphere/core-sdk';

import { createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID, makeUploadSource } from '../utils';

import { applyDefaultMocks, createMockDriveInfo, createMockNodeAddresses, seedDummyFile, seedRecords } from './mock';

import { FailureScope, ListDepth, type NodeHeader, NodeType } from '@/types';
import { FileManagerEvents } from '@/utils';
import { getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, MANIFEST_METADATA_NODE_TOPIC, ROOT_PATH, SWARM_ZERO_ADDRESS } from '@/utils/constants';

describe('Folder operations', () => {
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

      const downloadReadableDataSpy = jest.spyOn(
        Object.getPrototypeOf(new Bee('http://localhost:1633').data),
        'downloadReadable',
      );

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

    it('defaults to the whole drive when path is omitted', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      seedRecords(
        fm,
        seedDummyFile(drive, 'a.txt', '1'.repeat(64), owner, actPublisher),
        seedDummyFile(drive, 'nested/b.txt', '2'.repeat(64), owner, actPublisher),
      );

      const results = await fm.downloadFolder(drive.id);

      expect(results.failed).toEqual([]);
      expect(results.succeeded.map((r) => r.path).sort()).toEqual(['a.txt', 'nested/b.txt']);
    });

    it('downloadFolder does not download files belonging to a different drive', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const otherDrive = createMockDriveInfo(actPublisher, { id: Identifier.fromString('other-drive').toString() });
      seedRecords(fm, seedDummyFile(drive, 'mine.txt', '1'.repeat(64), owner, actPublisher));
      seedRecords(fm, seedDummyFile(otherDrive, 'not-mine.txt', '2'.repeat(64), owner, actPublisher));

      const downloadReadableDataSpy = jest.spyOn(
        Object.getPrototypeOf(new Bee('http://localhost:1633').data),
        'downloadReadable',
      );

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
        name: 'b.txt',
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
      jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').data), 'download').mockResolvedValue(
        Bytes.fromUtf8(
          JSON.stringify({
            type: NodeType.File,
            batchId: DUMMY_BATCH_ID,
            owner,
            actPublisher,
            topic: topicA,
            driveId: drive.id,
            name: 'a.txt',
            path: 'a.txt',
            redundancyLevel: RedundancyLevel.OFF,
            content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
          }),
        ),
      );

      // listFolder now returns hydrated FileRecords (not raw headers): a.txt fetched, b.txt from cache.
      const results = (await fm.listFolder(drive.id, '')).entries;

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

    // A node present in the manifest that cannot be resolved is reported, never dropped: silently
    // omitting it makes a broken entry indistinguishable from one that was never there.
    describe('failure reporting', () => {
      it('reports an unloadable file as an entry-scoped failure and still returns its siblings', async () => {
        const fm = await createInitializedFileManager();
        const drive = fm.driveList[0];

        const goodTopic = Topic.fromString('report-good').toString();
        const badTopic = Topic.fromString('report-bad').toString();

        // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
        const { getAllNodeEntries } = require('@/utils/mantaray');
        getAllNodeEntries.mockReturnValue([
          { path: 'good.txt', type: NodeType.File, topic: goodTopic, rawMetadata: {} },
          { path: 'bad.txt', type: NodeType.File, topic: badTopic, rawMetadata: {} },
        ]);

        seedRecords(fm, {
          type: NodeType.File,
          batchId: DUMMY_BATCH_ID,
          owner,
          actPublisher,
          redundancyLevel: RedundancyLevel.OFF,
          topic: goodTopic,
          driveId: drive.id,
          name: 'good.txt',
          path: 'good.txt',
          content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
        });

        // Only bad.txt reaches the feed: good.txt is served from the cache.
        (getFeedData as jest.Mock).mockRejectedValue(new Error('feed unreachable'));

        const { entries, failed } = await fm.listFolder(drive.id, '');

        expect(entries.map((e) => e.path)).toEqual(['good.txt']);
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({
          path: 'bad.txt',
          scope: FailureScope.Entry,
          type: NodeType.File,
          topic: badTopic,
        });
        expect(failed[0].error).toContain('feed unreachable');
      });

      it('reports an unresolvable folder as a subtree-scoped failure', async () => {
        const fm = await createInitializedFileManager();
        const drive = fm.driveList[0];

        const folderTopic = Topic.fromString('report-folder').toString();

        // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
        const { getAllNodeEntries } = require('@/utils/mantaray');
        getAllNodeEntries.mockReturnValue([
          { path: 'broken', type: NodeType.Folder, topic: folderTopic, rawMetadata: {} },
        ]);

        // A folder whose feed has no update at all — previously a warn-and-skip.
        (getFeedData as jest.Mock).mockResolvedValue({
          feedIndex: FeedIndex.MINUS_ONE,
          feedIndexNext: FEED_INDEX_ZERO,
          payload: {
            toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
          },
        });

        const { entries, failed } = await fm.listFolder(drive.id, '', ListDepth.Deep);

        expect(entries).toEqual([]);
        expect(failed).toHaveLength(1);
        // Its manifest never loaded, so its descendants were never enumerated either.
        expect(failed[0]).toMatchObject({
          path: 'broken',
          scope: FailureScope.Subtree,
          type: NodeType.Folder,
          topic: folderTopic,
        });
      });

      it('reports a folder whose manifest cannot be expanded, keeping the folder itself listed', async () => {
        const fm = await createInitializedFileManager();
        const drive = fm.driveList[0];

        const folderTopic = Topic.fromString('expand-broken').toString();

        // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
        const { getAllNodeEntries, loadMantaray } = require('@/utils/mantaray');
        getAllNodeEntries.mockReturnValue([
          { path: 'readable', type: NodeType.Folder, topic: folderTopic, rawMetadata: {} },
        ]);

        // The folder's feed resolves, so the node itself is listed...
        (getFeedData as jest.Mock).mockResolvedValue({
          feedIndex: FEED_INDEX_ZERO,
          feedIndexNext: FeedIndex.fromBigInt(1n),
          payload: {
            toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
          },
        });
        // ...but its manifest cannot be read, so descending into it fails. The drive root is served
        // from the cache seeded at init, so only the folder's own expansion breaks.
        loadMantaray.mockRejectedValue(new Error('manifest unreadable'));

        const { entries, failed } = await fm.listFolder(drive.id, '', ListDepth.Deep);

        // Distinct from an unresolvable folder: this one exists and is returned, only its contents
        // are unknown.
        expect(entries.map((e) => e.path)).toEqual(['readable']);
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({
          path: 'readable',
          scope: FailureScope.Subtree,
          topic: folderTopic,
        });
        expect(failed[0].error).toContain('manifest unreadable');
      });

      it('folds listing failures into downloadFolder results', async () => {
        const fm = await createInitializedFileManager();
        const drive = fm.driveList[0];

        const badTopic = Topic.fromString('download-bad').toString();

        // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
        const { getAllNodeEntries } = require('@/utils/mantaray');
        getAllNodeEntries.mockReturnValue([{ path: 'bad.txt', type: NodeType.File, topic: badTopic, rawMetadata: {} }]);

        (getFeedData as jest.Mock).mockRejectedValue(new Error('feed unreachable'));

        const result = await fm.downloadFolder(drive.id, ROOT_PATH);

        // A file that never made it into the listing cannot be fetched, so reporting only fetch
        // failures would let the caller read a partial download as a complete one.
        expect(result.succeeded).toEqual([]);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].path).toBe('bad.txt');
        expect(result.failed[0].error).toContain('feed unreachable');
      });
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

      const results = (await fm.listFolder(drive.id, '', ListDepth.Deep, 1)).entries;

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

    it('rejects a duplicate folder name instead of returning a folder absent from the tree', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      const first = await fm.createFolder(drive.id, '', 'Documents');

      await expect(fm.createFolder(drive.id, '', 'Documents')).rejects.toThrow(/Node already exists at "Documents"/);

      const driveMantaray = (fm as any).store.getManifestCache(drive.topic) as MantarayNode;
      expect(driveMantaray.find('Documents')?.metadata?.[MANIFEST_METADATA_NODE_TOPIC]).toBe(first.topic);
    });

    it('does not mint a folder feed for a rejected duplicate', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await fm.createFolder(drive.id, '', 'Documents');

      const uploadDataSpy = jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').data), 'upload');
      uploadDataSpy.mockClear();

      await expect(fm.createFolder(drive.id, '', 'Documents')).rejects.toThrow(/already exists/);

      expect(uploadDataSpy).not.toHaveBeenCalled();
    });

    it('rejects a folder name already taken by a file', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await fm.uploadFile(drive.id, { path: 'notes', ...makeUploadSource('package.json') });

      await expect(fm.createFolder(drive.id, '', 'notes')).rejects.toThrow(/Node already exists at "notes"/);
    });

    it('reports the full path of the conflict for a nested parent', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await fm.createFolder(drive.id, '', 'outer');

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(0n),
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });

      await fm.createFolder(drive.id, 'outer', 'inner');

      await expect(fm.createFolder(drive.id, 'outer', 'inner')).rejects.toThrow(
        /Node already exists at "outer\/inner"/,
      );
    });
  });

  describe('move', () => {
    it('rewrites descendant record paths on a same-drive folder move', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      await fm.createFolder(drive.id, '', 'Docs');
      seedRecords(fm, seedDummyFile(drive, 'Docs/a.txt', SWARM_ZERO_ADDRESS.toString(), owner, actPublisher));

      await fm.move('Docs', 'Archive', drive.id);

      expect(fm.recordList.some((f) => f.path === 'Archive/a.txt')).toBe(true);
      expect(fm.recordList.some((f) => f.path === 'Docs/a.txt')).toBe(false);
    });

    it('throws when trying to move the drive root', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.move('/', 'x.txt', drive.id)).rejects.toThrow('Cannot rename the admin drive');
    });
  });
});
