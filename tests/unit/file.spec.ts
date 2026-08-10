import { BatchId, Bee, Bytes, FeedIndex, MantarayNode, RedundancyLevel, Reference, Topic } from '@ethersphere/bee-js';

import {
  createInitializedFileManager,
  DEFAULT_MOCK_SIGNER,
  DUMMY_BATCH_ID,
  IS_BROWSER,
  makeUploadSource,
} from '../utils';

import {
  applyDefaultMocks,
  createMockDriveInfo,
  createMockNodeAddresses,
  SeedableFm,
  seedDummyFile,
  seedRecords,
} from './mock';

import { FileManagerBase } from '@/fileManager';
import { DriveInfo, FileRecord, NodeStatus, NodeType } from '@/types';
import { FileError, FileManagerEvents, FileRecordError } from '@/utils';
import { getFeedData } from '@/utils/bee';
import {
  FEED_INDEX_ZERO,
  MANIFEST_METADATA_FILE_TOPIC,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  SWARM_ZERO_ADDRESS,
} from '@/utils/constants';

describe('File operations', () => {
  const otherMockBatchId = new BatchId('4'.repeat(64));
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();
  const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();

  const nodeOnly = IS_BROWSER ? it.skip : it;

  beforeEach(async () => {
    applyDefaultMocks();
  });

  describe('downloadFile', () => {
    it('fetches a single held record and returns one result', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const a = seedDummyFile(drive, 'a.txt', '1'.repeat(64), owner, actPublisher);
      seedRecords(fm, a, seedDummyFile(drive, 'b.txt', '2'.repeat(64), owner, actPublisher));

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');
      const result = await fm.downloadFile(a);

      expect(downloadReadableDataSpy).toHaveBeenCalledTimes(1);
      expect(result.path).toBe('a.txt');
    });
  });

  describe('downloadFiles', () => {
    it('fetches exactly the passed records with no drive traversal', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const records: FileRecord[] = [
        {
          type: NodeType.File,
          batchId: DUMMY_BATCH_ID,
          owner,
          actPublisher,
          topic: Topic.fromString('dlf-a.txt').toString(),
          driveId: drive.id,
          path: 'a.txt',
          content: { reference: '1'.repeat(64), historyRef: SWARM_ZERO_ADDRESS.toString() },
          redundancyLevel: RedundancyLevel.OFF,
        },
        {
          type: NodeType.File,
          batchId: DUMMY_BATCH_ID,
          owner,
          actPublisher,
          topic: Topic.fromString('dlf-b.txt').toString(),
          driveId: drive.id,
          path: 'b.txt',
          content: { reference: '2'.repeat(64), historyRef: SWARM_ZERO_ADDRESS.toString() },
          redundancyLevel: RedundancyLevel.OFF,
        },
      ];

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');
      const listFolderSpy = jest.spyOn(fm, 'listFolder');

      const results = await fm.downloadFiles(records);

      expect(downloadReadableDataSpy).toHaveBeenCalledWith(
        '2'.repeat(64),
        { actHistoryAddress: SWARM_ZERO_ADDRESS.toString(), actPublisher },
        undefined,
      );
      expect(downloadReadableDataSpy).toHaveBeenCalledTimes(2);
      expect(results.succeeded.map((r) => r.path).sort()).toEqual(['a.txt', 'b.txt']);

      expect(listFolderSpy).not.toHaveBeenCalled();
    });

    it('returns an empty array without touching Bee when given no records', async () => {
      const fm = await createInitializedFileManager();
      const downloadDataSpy = jest.spyOn(Bee.prototype, 'downloadData');

      const results = await fm.downloadFiles([]);

      expect(results.succeeded).toEqual([]);
      expect(downloadDataSpy).not.toHaveBeenCalled();
    });

    it('splits partial results: fetched records land in succeeded, the failing one in failed', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const good = seedDummyFile(drive, 'good.txt', '1'.repeat(64), owner, actPublisher);
      const bad = seedDummyFile(drive, 'bad.txt', '2'.repeat(64), owner, actPublisher);

      jest.spyOn(Bee.prototype, 'downloadReadableData').mockImplementation(async (ref: unknown) => {
        if (ref === '2'.repeat(64)) {
          throw new Error('boom');
        }
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(SWARM_ZERO_ADDRESS.toUint8Array());
            controller.close();
          },
        });
      });

      const results = await fm.downloadFiles([good, bad]);

      expect(results.succeeded.map((r) => r.path)).toEqual(['good.txt']);
      expect(results.failed).toEqual([{ path: 'bad.txt', error: 'boom' }]);
    });
  });

  describe('uploadFile', () => {
    it('uploads a new file: adds it to recordList at version 0 and forks it into the drive manifest', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      await fm.uploadFile(di.id, { path: 'package.json', ...makeUploadSource('package.json') });

      const entries = fm.recordList.filter((fr) => fr.path === 'package.json');
      expect(entries).toHaveLength(1);
      expect(entries[0].version).toBe(FEED_INDEX_ZERO.toString());
      expect(entries[0].driveId).toBe(di.id);
      expect(entries[0].status).toBe(NodeStatus.Active);

      // Fresh topic is minted (not derived from any input).
      expect(entries[0].topic.length).toBeGreaterThan(0);

      const driveMantaray = (fm as any).store.getManifestCache(di.topic) as MantarayNode;
      expect(driveMantaray.find('package.json')).toBeTruthy();
    });

    it('places the file at `path`, independent of the source (rename on upload)', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      await fm.uploadFile(di.id, { path: 'renamed.json', ...makeUploadSource('package.json') });

      expect(fm.recordList.find((fr) => fr.path === 'renamed.json')).toBeDefined();
      expect(fm.recordList.find((fr) => fr.path === 'package.json')).toBeUndefined();

      const driveMantaray = (fm as any).store.getManifestCache(di.topic) as MantarayNode;
      expect(driveMantaray.find('renamed.json')).toBeTruthy();
      expect(driveMantaray.find('package.json')).toBeFalsy();
    });

    it('uploads into a subfolder: forks the file into the folder manifest, not the drive root', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      await fm.createFolder(di.id, '', 'tests');

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(0n),
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });

      await fm.uploadFile(di.id, { path: 'tests/utils.ts', ...makeUploadSource('tests/utils.ts') });

      expect(fm.recordList.find((fr) => fr.path === 'tests/utils.ts')).toBeDefined();

      // The file fork lives under the folder's own manifest — the drive root manifest carries the
      // 'tests' folder fork but not the file leaf.
      const driveMantaray = (fm as any).store.getManifestCache(di.topic) as MantarayNode;
      expect(driveMantaray.find('tests')).toBeTruthy();
      expect(driveMantaray.find('utils.ts')).toBeFalsy();
    });

    nodeOnly('throws when uploading a directory — directories must go through uploadFiles', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      await expect(fm.uploadFile(di.id, { path: 'tests', sourcePath: 'tests' })).rejects.toThrow(
        'Cannot upload a directory - use uploadFiles',
      );
    });

    nodeOnly('throws a FileError instance for a directory upload', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      await expect(fm.uploadFile(di.id, { path: 'tests', sourcePath: 'tests' })).rejects.toBeInstanceOf(FileError);
    });

    nodeOnly('throws for a nested directory path (not just a top-level one)', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      await expect(fm.uploadFile(di.id, { path: 'tests/unit', sourcePath: 'tests/unit' })).rejects.toThrow(
        'Path not found: /tests',
      );
    });

    nodeOnly('does not add a fork or recordList entry when a directory upload is rejected', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      await expect(fm.uploadFile(di.id, { path: 'tests', sourcePath: 'tests' })).rejects.toThrow();

      expect(fm.recordList.find((fr) => fr.path === 'tests')).toBeUndefined();
      const driveMantaray = (fm as any).store.getManifestCache(di.topic) as MantarayNode;
      expect(driveMantaray.find('tests')).toBeFalsy();
    });

    it('throws when a drive is not found', async () => {
      const fm = await createInitializedFileManager();
      const ghost = createMockDriveInfo(actPublisher, { id: '7'.repeat(64), name: 'ghost' });

      await expect(
        fm.uploadFile(ghost.id, { path: 'package.json', ...makeUploadSource('package.json') }),
      ).rejects.toThrow(`Drive with id ${ghost.id.slice(0, 6)} not found`);
    });
  });

  describe('updateFile', () => {
    // Seed a real, version-0 record via a fresh upload so update() re-versions an actual file.
    async function seedUploadedFile(): Promise<{ fm: FileManagerBase; di: DriveInfo; record: FileRecord }> {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];
      await fm.uploadFile(di.id, { path: 'package.json', ...makeUploadSource('package.json') });
      const record = fm.recordList.find((fr) => fr.path === 'package.json')!;
      return { fm, di, record };
    }

    it('metadata-only: bumps version, merges customMetadata, reuses the content ref, and does not upload bytes', async () => {
      const { fm, di, record } = await seedUploadedFile();

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_UPDATED, handler);

      await fm.updateFile(di.id, record, { customMetadata: { note: 'hello' } });

      const entries = fm.recordList.filter((fr) => fr.topic === record.topic);
      expect(entries).toHaveLength(1);
      const updated = entries[0];
      expect(updated.version).toBe(FeedIndex.fromBigInt(1n).toString());
      expect(updated.path).toBe(record.path);
      expect(updated.customMetadata).toMatchObject({ note: 'hello' });
      // Content ref reused verbatim — no bytes uploaded.
      expect(updated.content).toEqual(record.content);
      expect(handler).toHaveBeenCalled();
    });

    it('metadata-only with empty changes re-publishes a new version (content and metadata unchanged)', async () => {
      const { fm, di, record } = await seedUploadedFile();

      await expect(fm.updateFile(di.id, record, {})).rejects.toThrow(
        new FileRecordError('Neither a file/path nor customMetadata is provided'),
      );

      const updated = fm.recordList.find((fr) => fr.topic === record.topic)!;
      expect(updated.version).toBe(FEED_INDEX_ZERO.toString());
      expect(updated.path).toBe(record.path);
      expect(updated.content).toEqual(record.content);
    });

    it('re-saves the parent manifest to sync the fork version when re-versioning', async () => {
      const { fm, di, record } = await seedUploadedFile();
      const saveManifestSpy = jest.spyOn((fm as any).store, 'saveMantarayNode');
      await fm.updateFile(di.id, record, { item: { ...makeUploadSource('package.json') } });

      // The fork's cached NODE_VERSION must track the feed head, so update now persists the manifest.
      expect(saveManifestSpy).toHaveBeenCalledTimes(1);
    });

    it('uploads new bytes: re-versions an existing file and derives ACT history from the record', async () => {
      // A real upload seeds the fork; update now syncs that fork's version, so the fork must exist.
      const { fm, di, record } = await seedUploadedFile();
      const uploadDataSpy = jest.spyOn(Bee.prototype, 'uploadData');

      await fm.updateFile(di.id, record, { item: { ...makeUploadSource('package.json') } });
      // New content bytes are uploaded; updateFile derives actHistoryAddress from record.content.
      expect(uploadDataSpy).toHaveBeenCalled();

      const updated = fm.recordList.find((fr) => fr.topic === record.topic)!;
      expect(updated.version).toBe(FeedIndex.fromBigInt(1n).toString());
      expect(updated.path).toBe('package.json');
    });

    it('does not create a second recordList entry when re-versioning (upsert, not append)', async () => {
      const { fm, di, record } = await seedUploadedFile();

      await fm.updateFile(di.id, record, { item: { ...makeUploadSource('package.json') } });

      expect(fm.recordList.filter((fr) => fr.topic === record.topic)).toHaveLength(1);
    });

    nodeOnly('throws when uploading a directory as the new content source', async () => {
      const { fm, di, record } = await seedUploadedFile();

      await expect(fm.updateFile(di.id, record, { item: { sourcePath: 'tests' } })).rejects.toThrow(
        'Cannot upload a directory - use uploadFiles',
      );
    });

    it('throws when the drive is not found', async () => {
      const fm = await createInitializedFileManager();
      const ghost = createMockDriveInfo(actPublisher, { id: '7'.repeat(64), name: 'ghost' });
      const record: FileRecord = {
        type: NodeType.File,
        batchId: DUMMY_BATCH_ID,
        owner,
        redundancyLevel: RedundancyLevel.OFF,
        actPublisher,
        topic: Topic.fromString('orphan').toString(),
        driveId: ghost.id,
        path: 'package.json',
        content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
        version: FEED_INDEX_ZERO.toString(),
      };

      await expect(fm.updateFile(ghost.id, record, {})).rejects.toThrow(
        `Drive with id ${ghost.id.slice(0, 6)} not found`,
      );
    });

    it('lazy-loads the record from its feed on a cache miss, then re-versions it', async () => {
      const { fm, di, record } = await seedUploadedFile();

      const ix = fm.recordList.findIndex((f) => f.topic === record.topic);
      (fm as unknown as SeedableFm)._recordList.splice(ix, 1);

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FEED_INDEX_ZERO,
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });
      const getRecordSpy = jest
        .spyOn((fm as any).store, 'getRecord')
        .mockResolvedValue({ ...record, path: 'package.json' });

      await fm.updateFile(di.id, record, { customMetadata: { note: 'hi' } });

      expect(getRecordSpy).toHaveBeenCalledWith(record.topic, record.actPublisher, expect.anything(), undefined);
      const rehydrated = fm.recordList.filter((f) => f.topic === record.topic);
      expect(rehydrated).toHaveLength(1);
      expect(rehydrated[0].version).toBe(FeedIndex.fromBigInt(1n).toString());
      expect(rehydrated[0].customMetadata).toMatchObject({ note: 'hi' });

      getRecordSpy.mockRestore();
    });

    it('throws when the resolved record does not belong to the target drive', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      const foreign: FileRecord = {
        type: NodeType.File,
        batchId: DUMMY_BATCH_ID,
        owner,
        redundancyLevel: RedundancyLevel.OFF,
        actPublisher,
        topic: Topic.fromString('foreign-topic').toString(),
        driveId: di.id,
        path: 'package.json',
        content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
        version: FEED_INDEX_ZERO.toString(),
      };

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FEED_INDEX_ZERO,
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });
      jest.spyOn((fm as any).store, 'getRecord').mockResolvedValue({ ...foreign, driveId: '9'.repeat(64) });

      await expect(fm.updateFile(di.id, foreign, { customMetadata: { a: '1' } })).rejects.toThrow(
        `does not belong to drive "${di.name}"`,
      );
    });

    it('throws a not-found error when the record is absent on a cold cache', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      const record: FileRecord = {
        type: NodeType.File,
        batchId: DUMMY_BATCH_ID,
        owner,
        redundancyLevel: RedundancyLevel.OFF,
        actPublisher,
        topic: Topic.fromString('cold-topic').toString(),
        driveId: di.id,
        path: 'package.json',
        content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
        version: FEED_INDEX_ZERO.toString(),
      };

      await expect(fm.updateFile(di.id, record, { customMetadata: { a: '1' } })).rejects.toThrow(
        `File record not found for topic: ${record.topic.slice(0, 6)}`,
      );
    });
  });

  describe('move', () => {
    it('renames a file fork in place and bumps the FileRecord version', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const drive = fm.driveList[1];

      await fm.uploadFile(drive.id, { path: 'package.json', ...makeUploadSource('package.json') });
      const original = fm.recordList.find((fr) => fr.path === 'package.json')!;

      await fm.move('package.json', 'renamed.json', drive.id);

      const moved = fm.recordList.find((fr) => fr.topic === original.topic)!;
      expect(moved.path).toBe('renamed.json');
      expect(moved.version).toBe(FeedIndex.fromBigInt(1n).toString());

      const driveMantaray = (fm as any).store.getManifestCache(drive.topic) as MantarayNode;
      expect(driveMantaray.find('package.json')).toBeFalsy();
      expect(driveMantaray.find('renamed.json')).toBeTruthy();
    });

    it('refuses to move a trashed node until it is recovered', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const drive = fm.driveList[1];

      await fm.uploadFile(drive.id, { path: 'package.json', ...makeUploadSource('package.json') });
      const original = fm.recordList.find((fr) => fr.path === 'package.json')!;
      await fm.trashFile(original);

      await expect(fm.move('package.json', 'renamed.json', drive.id)).rejects.toThrow(
        'Cannot move a trashed file/folder; recover it first',
      );

      // The guard fires before any manifest mutation — the fork stays put.
      const driveMantaray = (fm as any).store.getManifestCache(drive.topic) as MantarayNode;
      expect(driveMantaray.find('package.json')).toBeTruthy();
      expect(driveMantaray.find('renamed.json')).toBeFalsy();
    });

    it('self-hydrates a file that was never loaded into recordList', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const driveMantaray = (fm as any).store.getManifestCache(drive.topic) as MantarayNode;

      const fileTopic = Topic.fromString('cold-file').toString();
      driveMantaray.addFork('cold.txt', new Reference(fileTopic), {
        [MANIFEST_METADATA_FILE_TOPIC]: fileTopic,
        [MANIFEST_METADATA_NODE_TOPIC]: fileTopic,
        [MANIFEST_METADATA_NODE_TYPE]: NodeType.File,
      });

      const coldFileRecord = {
        topic: fileTopic,
        driveId: drive.id,
        path: 'cold.txt',
        type: NodeType.File,
        batchId: DUMMY_BATCH_ID,
        owner,
        actPublisher,
        redundancyLevel: RedundancyLevel.OFF,
        content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
      };

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(0n),
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });
      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(Bytes.fromUtf8(JSON.stringify(coldFileRecord)));

      expect(fm.recordList.find((f) => f.topic === fileTopic)).toBeUndefined();

      await fm.move('cold.txt', 'warm.txt', drive.id);

      const moved = fm.recordList.find((f) => f.topic === fileTopic);
      expect(moved).toBeDefined();
      expect(moved?.path).toBe('warm.txt');
    });

    it('throws when the source path is not found in the manifest', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.move('missing.txt', 'x.txt', drive.id)).rejects.toThrow('Path not found: missing.txt');
    });

    it('throws when source and destination paths are identical', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.move('a.txt', 'a.txt', drive.id)).rejects.toThrow('Source and destination paths are identical');
    });

    it('rejects a move onto an existing destination and leaves both forks in place', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const drive = fm.driveList[1];

      await fm.uploadFile(drive.id, { path: 'a.json', ...makeUploadSource('package.json') });
      await fm.uploadFile(drive.id, { path: 'b.json', ...makeUploadSource('package.json') });

      await expect(fm.move('a.json', 'b.json', drive.id)).rejects.toThrow('Destination already exists: b.json');

      const driveMantaray = (fm as any).store.getManifestCache(drive.topic) as MantarayNode;
      expect(driveMantaray.find('a.json')).toBeTruthy();
      expect(driveMantaray.find('b.json')).toBeTruthy();
    });
  });
});
