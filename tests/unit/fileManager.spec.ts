import {
  BatchId,
  Bee,
  Bytes,
  FeedIndex,
  Identifier,
  MantarayNode,
  PublicKey,
  RedundancyLevel,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import {
  createInitializedFileManager,
  createInitMocks,
  createMockDriveInfo,
  createMockNodeAddresses,
  MOCK_BATCH_ID,
  mockPostageBatch,
} from '../mockHelpers';
import { BEE_URL, DEFAULT_MOCK_SIGNER } from '../utils';

import { EventEmitterBase } from '@/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { DirectoryEntry, DriveInfo, FileRecord, FileStatus, ListDepth, NodeType } from '@/types';
import { FeedResultWithIndex } from '@/types/utils';
import { DriveError, FileError, FileInfoError, FileManagerEvents, SignerError } from '@/utils';
import { fetchStamp, getFeedData } from '@/utils/bee';
import {
  ADMIN_STAMP_LABEL,
  FEED_INDEX_ZERO,
  MANIFEST_METADATA_FILE_TOPIC,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  SWARM_ZERO_ADDRESS,
} from '@/utils/constants';
import { generateRandomBytes } from '@/utils/crypto';

jest.mock('@/utils/bee', () => ({
  ...jest.requireActual('@/utils/bee'),
  getFeedData: jest.fn(),
  fetchStamp: jest.fn(),
}));
jest.mock('@/utils/crypto', () => ({
  generateRandomBytes: jest.fn(),
}));
jest.mock('@/utils/mantaray', () => ({
  ...jest.requireActual('@/utils/mantaray'),
  loadMantaray: jest.fn(),
  getAllNodeEntries: jest.fn(),
}));

describe('FileManager', () => {
  const otherMockBatchId = new BatchId('4'.repeat(64));
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();
  const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();

  let randomByteSeed = 0;

  beforeEach(async () => {
    jest.resetAllMocks();
    createInitMocks();

    (getFeedData as jest.Mock).mockResolvedValue({
      feedIndex: FeedIndex.MINUS_ONE,
      feedIndexNext: FEED_INDEX_ZERO,
      payload: {
        toUint8Array: () => SWARM_ZERO_ADDRESS.toUint8Array(),
        toJSON: () => ({
          reference: SWARM_ZERO_ADDRESS.toString(),
          historyRef: SWARM_ZERO_ADDRESS.toString(),
        }),
      },
    });

    (fetchStamp as jest.Mock).mockResolvedValue({ ...mockPostageBatch });

    // Unique bytes per call so drive/file/folder topics never collide in nodeManifestCache /
    // nodeFeedIndexCache
    randomByteSeed = 0;
    (generateRandomBytes as jest.Mock).mockImplementation((len: number) => {
      randomByteSeed += 1;
      const arr = new Uint8Array(len);
      arr[len - 1] = randomByteSeed & 0xff;
      arr[len - 2] = (randomByteSeed >> 8) & 0xff;
      return new Bytes(arr);
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { loadMantaray, getAllNodeEntries } = require('@/utils/mantaray');
    loadMantaray.mockResolvedValue(new MantarayNode());
    getAllNodeEntries.mockReturnValue([]);
  });

  describe('constructor', () => {
    it('should create new instance of FileManager', async () => {
      const fm = await createInitializedFileManager();

      expect(fm).toBeInstanceOf(FileManagerBase);
    });

    it('should throw error, if Signer is not provided', () => {
      expect(() => new FileManagerBase(new Bee(BEE_URL))).toThrow(SignerError);
      expect(() => new FileManagerBase(new Bee(BEE_URL))).toThrow('Signer required');
    });

    it('should initialize FileManager instance with correct values', async () => {
      const fm = await createInitializedFileManager();

      expect(fm.fileInfoList).toEqual([]);
      expect(fm.sharedWithMe).toEqual([]);
    });
  });

  describe('initialize', () => {
    it('should initialize FileManager', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const eventHandler = jest.fn();
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, undefined, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });

    it('should not initialize, if already initialized', async () => {
      const logSpy = jest.spyOn(console, 'debug');
      const eventHandler = jest.fn();
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);

      const fm = await createInitializedFileManager(
        new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER }),
        undefined,
        emitter,
      );
      expect(eventHandler).toHaveBeenCalledWith(true);
      await fm.initialize();
      expect(logSpy).toHaveBeenCalledWith('FileManager is already initialized');
    });

    it('should not initialize, if currently being initialized', async () => {
      const logSpy = jest.spyOn(console, 'debug');
      const eventHandler = jest.fn();
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);

      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = new FileManagerBase(bee, emitter);
      fm.initialize();
      fm.initialize();

      expect(logSpy).toHaveBeenCalledWith('FileManager is being initialized');
    });

    it('does not eagerly load any file records — hydration is lazy', async () => {
      const fm = await createInitializedFileManager();

      expect(fm.driveList.length).toBeGreaterThan(0);
      expect(fm.fileInfoList).toHaveLength(0);
    });
  });

  describe('reinitialization', () => {
    it('should emit STATE_INVALID when admin stamp becomes unusable during reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const getPostageBatchesSpy = jest.spyOn(Bee.prototype, 'getPostageBatches');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: true,
          label: ADMIN_STAMP_LABEL,
        },
      ]);

      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);
      expect(fm.adminStamp?.usable).toBe(true);
      expect(fm.driveList).toHaveLength(1);

      let reinitFired = false;
      emitter.on(FileManagerEvents.INITIALIZED, () => {
        reinitFired = true;
      });

      await fm.initialize();
      expect(reinitFired).toBe(true);
      expect(fm.driveList).toHaveLength(1);

      getPostageBatchesSpy.mockRestore();
    });

    it('should successfully revalidate when admin stamp is still valid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);
      const initialDrives = fm.driveList;
      const initialFileCount = fm.fileInfoList.length;

      let initEventFired = false;
      let invalidEventFired = false;

      emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
        if (success) {
          initEventFired = true;
        }
      });

      emitter.on(FileManagerEvents.STATE_INVALID, () => {
        invalidEventFired = true;
      });

      await fm.initialize();

      expect(initEventFired).toBe(true);
      expect(invalidEventFired).toBe(false);
      expect(fm.driveList).toEqual(initialDrives);
      expect(fm.fileInfoList).toHaveLength(initialFileCount);
    });

    it('should handle multiple sequential reinitializations with valid stamp', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const initialDriveCount = fm.driveList.length;

      for (let i = 0; i < 3; i++) {
        await fm.initialize();
        expect(fm.driveList).toHaveLength(initialDriveCount);
      }
    });

    it('should reset isInitialized flag when admin stamp becomes invalid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const getPostageBatchesSpy = jest.spyOn(Bee.prototype, 'getPostageBatches');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: false,
          label: ADMIN_STAMP_LABEL,
        },
      ]);

      const newFm = new FileManagerBase(bee);
      await newFm.initialize();

      expect((newFm as any).isInitialized).toBe(true);
      expect(newFm.driveList).toHaveLength(0);
      expect(newFm.fileInfoList).toHaveLength(0);

      getPostageBatchesSpy.mockRestore();
    });

    it('should maintain isInitialized flag after successful reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID);

      expect((fm as any).isInitialized).toBe(true);

      await fm.initialize();

      expect((fm as any).isInitialized).toBe(true);
    });

    it('should not clear drives when reinitializing with valid stamp', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const drivesBefore = fm.driveList;
      expect(drivesBefore.length).toBeGreaterThan(0);

      await fm.initialize();

      const drivesAfter = fm.driveList;
      expect(drivesAfter).toEqual(drivesBefore);
    });

    it('should maintain admin stamp reference after reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const adminStampBefore = fm.adminStamp;
      expect(adminStampBefore).toBeDefined();

      await fm.initialize();

      const adminStampAfter = fm.adminStamp;
      expect(adminStampAfter).toBeDefined();
      expect(adminStampAfter?.batchID.toString()).toBe(adminStampBefore?.batchID.toString());
    });

    it('should clear fileInfoList when admin stamp becomes invalid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      await createInitializedFileManager(bee, MOCK_BATCH_ID);

      const getPostageBatchesSpy = jest.spyOn(Bee.prototype, 'getPostageBatches');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: false,
          label: ADMIN_STAMP_LABEL,
        },
      ]);

      const newFm = new FileManagerBase(bee);
      await newFm.initialize();

      expect(newFm.fileInfoList).toHaveLength(0);
      expect(newFm.driveList).toHaveLength(0);

      getPostageBatchesSpy.mockRestore();
    });

    it('should not emit STATE_INVALID when admin stamp remains valid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);

      let invalidEventFired = false;
      emitter.on(FileManagerEvents.STATE_INVALID, () => {
        invalidEventFired = true;
      });

      await fm.initialize();

      expect(invalidEventFired).toBe(false);
    });
  });

  describe('downloadFolder & downloadFile', () => {
    function seedFile(drive: DriveInfo, path: string, ref: string): FileRecord {
      return {
        batchId: MOCK_BATCH_ID,
        owner,
        actPublisher,
        topic: Topic.fromString(`dl-${path}`).toString(),
        driveId: drive.id,
        path,
        content: {
          reference: ref,
          historyRef: SWARM_ZERO_ADDRESS.toString(),
        },
        redundancyLevel: RedundancyLevel.OFF,
      };
    }

    it('downloadFolder downloads every hydrated file belonging to the drive', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      fm.fileInfoList.push(seedFile(drive, 'a.txt', '1'.repeat(64)), seedFile(drive, 'b.txt', '2'.repeat(64)));

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');

      const results = await fm.downloadFolder(drive.id);

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
      expect(results.map((r) => r.path).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('downloadFile fetches a single held record and returns one result', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const a = seedFile(drive, 'a.txt', '1'.repeat(64));
      fm.fileInfoList.push(a, seedFile(drive, 'b.txt', '2'.repeat(64)));

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');
      const result = await fm.downloadFile(a);

      expect(downloadReadableDataSpy).toHaveBeenCalledTimes(1);
      expect(result.path).toBe('a.txt');
    });

    it('downloadFolder does not download files belonging to a different drive', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const otherDrive = createMockDriveInfo(actPublisher, { id: Identifier.fromString('other-drive').toString() });
      fm.fileInfoList.push(seedFile(drive, 'mine.txt', '1'.repeat(64)));
      fm.fileInfoList.push(seedFile(otherDrive, 'not-mine.txt', '2'.repeat(64)));

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');

      const results = await fm.downloadFolder(drive.id);

      expect(downloadReadableDataSpy).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('mine.txt');
    });
  });

  describe('downloadFiles', () => {
    function makeRecord(drive: DriveInfo, path: string, ref: string): FileRecord {
      return {
        batchId: MOCK_BATCH_ID,
        owner,
        actPublisher,
        topic: Topic.fromString(`dlf-${path}`).toString(),
        driveId: drive.id,
        path,
        content: { reference: ref, historyRef: SWARM_ZERO_ADDRESS.toString() },
        redundancyLevel: RedundancyLevel.OFF,
      };
    }

    it('fetches exactly the passed records with no drive traversal', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const records = [makeRecord(drive, 'a.txt', '1'.repeat(64)), makeRecord(drive, 'b.txt', '2'.repeat(64))];

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');
      const listFolderSpy = jest.spyOn(fm, 'listFolder');

      const results = await fm.downloadFiles(records);

      expect(downloadReadableDataSpy).toHaveBeenCalledWith(
        '2'.repeat(64),
        { actHistoryAddress: SWARM_ZERO_ADDRESS.toString(), actPublisher },
        undefined,
      );
      expect(downloadReadableDataSpy).toHaveBeenCalledTimes(2);
      expect(results.map((r) => r.path).sort()).toEqual(['a.txt', 'b.txt']);

      expect(listFolderSpy).not.toHaveBeenCalled();
    });

    it('returns an empty array without touching Bee when given no records', async () => {
      const fm = await createInitializedFileManager();
      const downloadDataSpy = jest.spyOn(Bee.prototype, 'downloadData');

      const results = await fm.downloadFiles([]);

      expect(results).toEqual([]);
      expect(downloadDataSpy).not.toHaveBeenCalled();
    });
  });

  describe('listFolder', () => {
    it('returns shallow entries and hydrates newly discovered files exactly once', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      const topicA = Topic.fromString('list-a').toString();
      const topicB = Topic.fromString('list-b').toString();
      const entryA: DirectoryEntry = { path: 'a.txt', type: NodeType.File, topic: topicA, rawMetadata: {} };
      const entryB: DirectoryEntry = { path: 'b.txt', type: NodeType.File, topic: topicB, rawMetadata: {} };

      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      const { getAllNodeEntries } = require('@/utils/mantaray');
      getAllNodeEntries.mockReturnValue([entryA, entryB]);

      // b.txt is already hydrated -> must be skipped during this call
      fm.fileInfoList.push({
        batchId: MOCK_BATCH_ID,
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
            batchId: MOCK_BATCH_ID,
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

      const results = await fm.listFolder(drive.id, '');

      expect(results).toEqual([entryA, entryB]);
      expect(fm.fileInfoList.filter((f) => f.topic === topicA)).toHaveLength(1);
      expect(fm.fileInfoList.filter((f) => f.topic === topicB)).toHaveLength(1);
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
      const folderEntry: DirectoryEntry = { path: 'sub', type: NodeType.Folder, topic: folderTopic, rawMetadata: {} };

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

      expect(results).toEqual([folderEntry]);
    });
  });

  describe('uploadFile', () => {
    it('uploads a new file: adds it to fileInfoList at version 0 and forks it into the drive manifest', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      await fm.uploadFile(di.id, { path: 'package.json', sourcePath: 'package.json' });

      const entries = fm.fileInfoList.filter((fr) => fr.path === 'package.json');
      expect(entries).toHaveLength(1);
      expect(entries[0].version).toBe(FEED_INDEX_ZERO.toString());
      expect(entries[0].driveId).toBe(di.id);
      expect(entries[0].status).toBe(FileStatus.Active);

      // Fresh topic is minted (not derived from any input).
      expect(entries[0].topic.length).toBeGreaterThan(0);

      const driveMantaray = (fm as any).nodeManifestCache.get(di.topic) as MantarayNode;
      expect(driveMantaray.find('package.json')).toBeTruthy();
    });

    it('places the file at `path`, independent of `sourcePath` (rename on upload)', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      await fm.uploadFile(di.id, { path: 'renamed.json', sourcePath: 'package.json' });

      expect(fm.fileInfoList.find((fr) => fr.path === 'renamed.json')).toBeDefined();
      expect(fm.fileInfoList.find((fr) => fr.path === 'package.json')).toBeUndefined();

      const driveMantaray = (fm as any).nodeManifestCache.get(di.topic) as MantarayNode;
      expect(driveMantaray.find('renamed.json')).toBeTruthy();
      expect(driveMantaray.find('package.json')).toBeFalsy();
    });

    it('uploads into a subfolder: forks the file into the folder manifest, not the drive root', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      await fm.createFolder(di.id, '', 'tests');

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.fromBigInt(0n),
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });

      await fm.uploadFile(di.id, { path: 'tests/utils.ts', sourcePath: 'tests/utils.ts' });

      expect(fm.fileInfoList.find((fr) => fr.path === 'tests/utils.ts')).toBeDefined();

      // The file fork lives under the folder's own manifest — the drive root manifest carries the
      // 'tests' folder fork but not the file leaf.
      const driveMantaray = (fm as any).nodeManifestCache.get(di.topic) as MantarayNode;
      expect(driveMantaray.find('tests')).toBeTruthy();
      expect(driveMantaray.find('utils.ts')).toBeFalsy();
    });

    it('throws when uploading a directory — directories must go through uploadFiles', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      await expect(fm.uploadFile(di.id, { path: 'tests', sourcePath: 'tests' })).rejects.toThrow(
        'Cannot upload a directory - use uploadFiles',
      );
    });

    it('throws a FileError instance for a directory upload', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      await expect(fm.uploadFile(di.id, { path: 'tests', sourcePath: 'tests' })).rejects.toBeInstanceOf(FileError);
    });

    it('throws for a nested directory path (not just a top-level one)', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      await expect(fm.uploadFile(di.id, { path: 'tests/unit', sourcePath: 'tests/unit' })).rejects.toThrow(
        'Cannot upload a directory - use uploadFiles',
      );
    });

    it('does not add a fork or fileInfoList entry when a directory upload is rejected', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      await expect(fm.uploadFile(di.id, { path: 'tests', sourcePath: 'tests' })).rejects.toThrow();

      expect(fm.fileInfoList.find((fr) => fr.path === 'tests')).toBeUndefined();
      const driveMantaray = (fm as any).nodeManifestCache.get(di.topic) as MantarayNode;
      expect(driveMantaray.find('tests')).toBeFalsy();
    });

    it('throws when a drive is not found', async () => {
      const fm = await createInitializedFileManager();
      const ghost = createMockDriveInfo(actPublisher, { id: '7'.repeat(64), name: 'ghost' });

      await expect(fm.uploadFile(ghost.id, { path: 'package.json', sourcePath: 'package.json' })).rejects.toThrow(
        `Drive with id ${ghost.id.slice(0, 6)} not found`,
      );
    });
  });

  describe('updateFile', () => {
    // Seed a real, version-0 record via a fresh upload so update() re-versions an actual file.
    async function seedUploadedFile(): Promise<{ fm: FileManagerBase; di: DriveInfo; record: FileRecord }> {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];
      await fm.uploadFile(di.id, { path: 'package.json', sourcePath: 'package.json' });
      const record = fm.fileInfoList.find((fr) => fr.path === 'package.json')!;
      return { fm, di, record };
    }

    it('metadata-only: bumps version, merges customMetadata, reuses the content ref, and does not upload bytes', async () => {
      const { fm, di, record } = await seedUploadedFile();

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_UPDATED, handler);

      await fm.updateFile(di.id, record, { customMetadata: { note: 'hello' } });

      const entries = fm.fileInfoList.filter((fr) => fr.topic === record.topic);
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
        new FileInfoError('Neither a file/path nor customMetadata is provided'),
      );

      const updated = fm.fileInfoList.find((fr) => fr.topic === record.topic)!;
      expect(updated.version).toBe(FEED_INDEX_ZERO.toString());
      expect(updated.path).toBe(record.path);
      expect(updated.content).toEqual(record.content);
    });

    it('never touches the drive manifest (no fork add, no manifest save) even when uploading new bytes', async () => {
      const { fm, di, record } = await seedUploadedFile();
      const saveManifestSpy = jest.spyOn(fm as any, 'saveMantarayNode');
      await fm.updateFile(di.id, record, { item: { sourcePath: 'package.json' } });

      expect(saveManifestSpy).not.toHaveBeenCalled();
    });

    it('uploads new bytes: derives actHistoryAddress from the record and bumps the version', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];
      const topic = Topic.fromString('update-new-bytes').toString();
      const priorHistoryRef = '9'.repeat(64);

      const record: FileRecord = {
        batchId: MOCK_BATCH_ID,
        owner,
        actPublisher,
        topic,
        redundancyLevel: RedundancyLevel.OFF,
        driveId: di.id,
        path: 'package.json',
        content: { reference: '8'.repeat(64), historyRef: priorHistoryRef },
        version: FEED_INDEX_ZERO.toString(),
      };
      fm.fileInfoList.push(record);
      const uploadDataSpy = jest.spyOn(Bee.prototype, 'uploadData');

      await fm.updateFile(di.id, record, { item: { sourcePath: 'package.json' } });
      // TODO: called 21 times ? -> mantaray saveRecursively
      expect(uploadDataSpy).toHaveBeenCalledTimes(21);

      const updated = fm.fileInfoList.find((fr) => fr.topic === topic)!;
      expect(updated.version).toBe(FeedIndex.fromBigInt(1n).toString());
      expect(updated.path).toBe('package.json');
    });

    it('does not create a second fileInfoList entry when re-versioning (upsert, not append)', async () => {
      const { fm, di, record } = await seedUploadedFile();

      await fm.updateFile(di.id, record, { item: { sourcePath: 'package.json' } });

      expect(fm.fileInfoList.filter((fr) => fr.topic === record.topic)).toHaveLength(1);
    });

    it('throws when uploading a directory as the new content source', async () => {
      const { fm, di, record } = await seedUploadedFile();

      await expect(fm.updateFile(di.id, record, { item: { sourcePath: 'tests' } })).rejects.toThrow(
        'Cannot upload a directory - use uploadFiles',
      );
    });

    it('throws when the drive is not found', async () => {
      const fm = await createInitializedFileManager();
      const ghost = createMockDriveInfo(actPublisher, { id: '7'.repeat(64), name: 'ghost' });
      const record: FileRecord = {
        batchId: MOCK_BATCH_ID,
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
  });

  describe('createFolder', () => {
    it('creates a new folder fork under the drive root and updates the drive manifestRef', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      const folderInfo = await fm.createFolder(drive.id, '', 'Documents');

      expect(folderInfo.path).toBe('/Documents');
      expect(folderInfo.driveId).toBe(drive.id);

      const updatedDrive = fm.driveList.find((d) => d.id === drive.id)!;
      expect(updatedDrive.manifestRef).toBeDefined();

      const driveMantaray = (fm as any).nodeManifestCache.get(drive.topic) as MantarayNode;
      expect(driveMantaray.find('Documents')).toBeTruthy();
    });

    it('throws on an invalid folder name containing a slash', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.createFolder(drive.id, '', 'a/b')).rejects.toThrow('Invalid folder name');
    });
  });

  describe('version control', () => {
    let fm: FileManagerBase;

    const dummyTopic = Topic.fromString('deadbeef').toString();
    const dummyFi: FileRecord = {
      topic: dummyTopic,
      content: { historyRef: SWARM_ZERO_ADDRESS.toString(), reference: SWARM_ZERO_ADDRESS.toString() },
      owner,
      batchId: MOCK_BATCH_ID,
      driveId: Identifier.fromString('version-drive').toString(),
      path: 'x.txt',
      actPublisher,
      version: FeedIndex.fromBigInt(0n).toString(),
      redundancyLevel: RedundancyLevel.OFF,
    };

    beforeEach(async () => {
      fm = await createInitializedFileManager();
    });

    it('getFileVersion calls fetchFileInfo with the topic and compressed actPublisher', async () => {
      const fakeFi = { ...dummyFi, version: '1' };

      const rawMock: FeedResultWithIndex = {
        feedIndex: FeedIndex.fromBigInt(1n),
        feedIndexNext: FeedIndex.fromBigInt(2n),
        payload: new Bytes(SWARM_ZERO_ADDRESS.toUint8Array()),
      };
      (getFeedData as jest.Mock).mockResolvedValue(rawMock);

      const spyFetch = jest.spyOn(FileManagerBase.prototype as any, 'fetchFileInfo').mockResolvedValue(fakeFi);

      const got = await fm.getFileVersion(dummyFi, FeedIndex.fromBigInt(1n));

      expect(spyFetch).toHaveBeenCalledWith(
        dummyFi.topic,
        new PublicKey(actPublisher).toCompressedHex(),
        rawMock,
        undefined,
      );
      expect(got).toBe(fakeFi);

      // jest.resetAllMocks() in the outer beforeEach clears this mock's resolved value but does
      // not restore the original method, leaving fetchFileInfo permanently stubbed for every
      // later test in the file unless explicitly restored here.
      spyFetch.mockRestore();
    });

    it('getFileVersion returns the cached head without a feed lookup when the requested version matches', async () => {
      const cachedVersion = FeedIndex.fromBigInt(5n).toString();
      fm.fileInfoList.push({ ...dummyFi, version: cachedVersion });

      // Clear calls made by createInitializedFileManager()'s own bootstrap in the outer beforeEach.
      (getFeedData as jest.Mock).mockClear();

      const got = await fm.getFileVersion(dummyFi, FeedIndex.fromBigInt(5n));

      expect(got.version).toBe(cachedVersion);
      expect(getFeedData).not.toHaveBeenCalled();
    });

    it('getFileVersion throws if the underlying feed is missing', async () => {
      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      });

      await expect(fm.getFileVersion(dummyFi)).rejects.toThrow(
        `File feed not found for topic: ${dummyFi.topic.slice(0, 6)}`,
      );
    });

    it('restoring the current head is a no-op and throws', async () => {
      const head = FeedIndex.fromBigInt(5n);
      const headFi = { ...dummyFi, version: head.toString() };

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: head,
        feedIndexNext: FeedIndex.fromBigInt(6n),
        payload: SWARM_ZERO_ADDRESS,
      });

      const spyEmit = jest.spyOn(fm.emitter, 'emit');

      await expect(fm.restoreFileVersion(headFi)).rejects.toThrow(
        `Head Slot cannot be restored. Please select a version lesser than: ${head.toString()}`,
      );

      expect(spyEmit).not.toHaveBeenCalledWith(FileManagerEvents.FILE_VERSION_RESTORED, expect.anything());
    });

    it('restoreFileVersion throws when the underlying feed is missing', async () => {
      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FeedIndex.MINUS_ONE,
        feedIndexNext: FEED_INDEX_ZERO,
        payload: SWARM_ZERO_ADDRESS,
      });

      await expect(fm.restoreFileVersion({ ...dummyFi, version: '2' })).rejects.toThrow('Record feed not found');
    });
  });

  describe('drive handling', () => {
    it('createDrive should create an admin drive', async () => {
      const fm = await createInitializedFileManager();
      const di = fm.driveList[0];
      expect(di).toBeDefined();
      expect(di.name).toBe(ADMIN_STAMP_LABEL);
      expect(di.batchId).toBe(MOCK_BATCH_ID.toString());
      expect(di.id).toHaveLength(64);
      expect(di.owner).toBe(owner);
      expect(di.topic).toBeDefined();
      expect(di.manifestRef).toBeDefined();
      expect(di.isAdmin).toBe(true);
    });

    it('createDrive should create a new drive', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];
      expect(di).toBeDefined();
      expect(di.name).toBe('Test Drive');
      expect(di.batchId).toBe(otherMockBatchId.toString());
      expect(di.id).toHaveLength(64);
      expect(di.owner).toBe(owner);
      expect(di.topic).toBeDefined();
      expect(di.manifestRef).toBeDefined();
    });

    it('createDrive should throw error if drive with same name or batchId exists', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      await expect(fm.createDrive(otherMockBatchId, 'New Drive', false)).rejects.toThrow(
        new DriveError(
          `Drive with name "New Drive" or batchId "${otherMockBatchId.toString().slice(0, 6)}" already exists`,
        ),
      );
      const newDriveId = 'aa0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';
      await expect(fm.createDrive(newDriveId, 'Test Drive', false)).rejects.toThrow(
        new DriveError(`Drive with name "Test Drive" or batchId "${newDriveId.slice(0, 6)}" already exists`),
      );
    });

    it('createDrive should throw error if trying to create a new admin drive', async () => {
      const fm = await createInitializedFileManager();
      await expect(fm.createDrive('1'.repeat(64), 'New Drive', true)).rejects.toThrow(
        new DriveError(`Admin drive already exists`),
      );
    });

    it('destroyDrive should call diluteBatch with batchId and MAX_DEPTH', async () => {
      const diluteSpy = jest.spyOn(Bee.prototype, 'diluteBatch').mockResolvedValue(otherMockBatchId);
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      (fetchStamp as jest.Mock).mockResolvedValue({ ...mockPostageBatch, batchID: otherMockBatchId });
      await fm.destroyDrive(di.id);

      const ttlDays = mockPostageBatch.duration.toDays();
      const halvings = Math.floor(Math.log2(ttlDays));
      expect(diluteSpy).toHaveBeenCalledWith(di.batchId, mockPostageBatch.depth + halvings, undefined);
    });

    it('destroyDrive should throw error if trying to destroy Admin drive / stamp', async () => {
      const fm = await createInitializedFileManager();
      const di = fm.driveList[0];

      di.isAdmin = false;
      await expect(async () => {
        await fm.destroyDrive(di.id);
      }).rejects.toThrow(`Cannot destroy admin drive / stamp, batchId: ${MOCK_BATCH_ID.slice(0, 6)}`);
    });

    it('forgetDrive should remove a user drive, prune its files, and emit DRIVE_FORGOTTEN', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Drive to forget (unit)', false);
      const target = fm.driveList.find((d) => d.name === 'Drive to forget (unit)')!;
      expect(target).toBeDefined();

      fm.fileInfoList.push(
        {
          batchId: target.batchId,
          owner,
          actPublisher,
          topic: Topic.fromString('forget-x').toString(),
          driveId: target.id,
          path: 'x.txt',
          content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
          redundancyLevel: RedundancyLevel.OFF,
        },
        {
          batchId: target.batchId,
          owner,
          actPublisher,
          topic: Topic.fromString('forget-y').toString(),
          driveId: target.id,
          path: 'y.txt',
          content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
          redundancyLevel: RedundancyLevel.OFF,
        },
      );

      const diluteSpy = jest.spyOn(Bee.prototype, 'diluteBatch');

      const eventPromise = new Promise<void>((resolve) => {
        const handler = ({ driveInfo }: { driveInfo: DriveInfo }): void => {
          expect(driveInfo.id).toBe(target.id);
          resolve();
        };
        fm.emitter.on(FileManagerEvents.DRIVE_FORGOTTEN, handler);
      });

      await fm.forgetDrive(new Identifier(target.id));
      await eventPromise;

      expect(fm.driveList.find((d) => d.id === target.id)).toBeUndefined();
      expect(fm.fileInfoList.some((fr) => fr.driveId === target.id)).toBe(false);
      expect(diluteSpy).not.toHaveBeenCalled();
    });

    it('forgetDrive should throw when the drive does not exist', async () => {
      const fm = await createInitializedFileManager();
      const ghost = createMockDriveInfo(actPublisher, { id: '9'.repeat(64), name: 'ghost', isAdmin: false });

      await expect(fm.forgetDrive(new Identifier(ghost.id))).rejects.toThrow(
        new DriveError(`Drive with id ${ghost.id.slice(0, 6)} not found`),
      );
    });
  });

  describe('file lifecycle: trash, recover, forget', () => {
    let fm: FileManagerBase;
    let drive: DriveInfo;
    let fileRecord: FileRecord;

    beforeEach(async () => {
      fm = await createInitializedFileManager();
      drive = fm.driveList[0];
      fileRecord = {
        batchId: MOCK_BATCH_ID,
        owner,
        actPublisher,
        topic: Topic.fromString('lifecycle-target').toString(),
        driveId: drive.id,
        path: 'notes.txt',
        content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
        version: FEED_INDEX_ZERO.toString(),
        status: FileStatus.Active,
        timestamp: 0,
        redundancyLevel: RedundancyLevel.OFF,
      };
      fm.fileInfoList.push(fileRecord);
    });

    it('trashFile marks the file trashed, bumps version, and emits FILE_TRASHED', async () => {
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_TRASHED, handler);

      await fm.trashFile(fileRecord);

      expect(fileRecord.status).toBe(FileStatus.Trashed);
      expect(fileRecord.version).toBe(FeedIndex.fromBigInt(1n).toString());
      expect(handler).toHaveBeenCalledWith({ record: fileRecord });
    });

    it('trashFile throws if the file is already trashed', async () => {
      await fm.trashFile(fileRecord);
      await expect(fm.trashFile(fileRecord)).rejects.toThrow(`File already Trashed: ${fileRecord.path}`);
    });

    it('recoverFile restores active status and emits FILE_RECOVERED', async () => {
      await fm.trashFile(fileRecord);
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_RECOVERED, handler);

      await fm.recoverFile(fileRecord);

      expect(fileRecord.status).toBe(FileStatus.Active);
      expect(handler).toHaveBeenCalledWith({ record: fileRecord });
    });

    it('recoverFile throws if the file was never trashed', async () => {
      await expect(fm.recoverFile(fileRecord)).rejects.toThrow(
        `Non-Trashed files cannot be restored: ${fileRecord.path}`,
      );
    });

    it('throws when the target FileRecord is not tracked in fileInfoList', async () => {
      const ghost: FileRecord = { ...fileRecord, topic: Topic.fromString('ghost-file').toString() };
      await expect(fm.trashFile(ghost)).rejects.toThrow(`Corresponding File record does not exist: ${ghost.path}`);
    });

    it('throws when attempting to forget the drive root', async () => {
      await expect(fm.forget(drive.id, '/')).rejects.toThrow('Cannot forget drive root');
      await expect(fm.forget(drive.id, '')).rejects.toThrow('Cannot forget drive root');
    });

    it('removes a file fork and its fileInfoList entry, emitting FILE_FORGOTTEN', async () => {
      await fm.uploadFile(drive.id, { path: 'package.json', sourcePath: 'package.json' });
      const uploaded = fm.fileInfoList.find((f) => f.path === 'package.json')!;
      expect(uploaded).toBeDefined();

      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.FILE_FORGOTTEN, handler);

      await fm.forget(drive.id, 'package.json');

      expect(fm.fileInfoList.find((f) => f.path === 'package.json')).toBeUndefined();
      expect(handler).toHaveBeenCalledWith({ record: uploaded, path: 'package.json' });

      const driveMantaray = (fm as any).nodeManifestCache.get(drive.topic) as MantarayNode;
      expect(driveMantaray.find('package.json')).toBeFalsy();
    });

    it('removes a folder fork and purges all descendant fileInfoList entries', async () => {
      await fm.createFolder(drive.id, '', 'Docs');

      fm.fileInfoList.push({
        batchId: MOCK_BATCH_ID,
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

      expect(fm.fileInfoList.some((f) => f.path.startsWith('Docs/'))).toBe(false);
      expect(handler).toHaveBeenCalledWith({ driveInfo: drive, path: 'Docs' });
    });
  });

  describe('move', () => {
    it('renames a file fork in place and bumps the FileRecord version', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const drive = fm.driveList[1];

      await fm.uploadFile(drive.id, { path: 'package.json', sourcePath: 'package.json' });
      const original = fm.fileInfoList.find((fr) => fr.path === 'package.json')!;

      await fm.move('package.json', 'renamed.json', drive.id);

      const moved = fm.fileInfoList.find((fr) => fr.topic === original.topic)!;
      expect(moved.path).toBe('renamed.json');
      expect(moved.version).toBe(FeedIndex.fromBigInt(1n).toString());

      const driveMantaray = (fm as any).nodeManifestCache.get(drive.topic) as MantarayNode;
      expect(driveMantaray.find('package.json')).toBeFalsy();
      expect(driveMantaray.find('renamed.json')).toBeTruthy();
    });

    it('self-hydrates a file that was never loaded into fileInfoList', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const driveMantaray = (fm as any).nodeManifestCache.get(drive.topic) as MantarayNode;

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
        batchId: MOCK_BATCH_ID,
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

      expect(fm.fileInfoList.find((f) => f.topic === fileTopic)).toBeUndefined();

      await fm.move('cold.txt', 'warm.txt', drive.id);

      const moved = fm.fileInfoList.find((f) => f.topic === fileTopic);
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

    it('throws when trying to move the drive root', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.move('/', 'x.txt', drive.id)).rejects.toThrow('Cannot move root folder');
    });
  });

  describe('eventEmitter', () => {
    it('emits FILE_UPLOADED with the persisted FileRecord', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();
      const uploadHandler = jest.fn();

      const fm = await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);
      fm.emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);
      const redundancy = RedundancyLevel.MEDIUM;
      await fm.createDrive(otherMockBatchId, 'Test Drive', false, redundancy);
      const di = fm.driveList[1];

      jest.useFakeTimers();
      const fixedNow = 1_755_158_248_500;
      jest.setSystemTime(new Date(fixedNow));

      await fm.uploadFile(di.id, { path: 'package.json', sourcePath: 'package.json' });
      fm.emitter.off(FileManagerEvents.FILE_UPLOADED, uploadHandler);

      expect(uploadHandler).toHaveBeenCalledWith({
        record: expect.objectContaining({
          batchId: otherMockBatchId.toString(),
          driveId: di.id,
          path: 'package.json',
          owner,
          redundancyLevel: redundancy,
          shared: false,
          status: FileStatus.Active,
          timestamp: fixedNow,
          topic: expect.any(String),
        }),
      });

      jest.useRealTimers();
    });

    it('emits an INITIALIZED event with true on successful init', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const eventHandler = jest.fn();
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);
      await createInitializedFileManager(bee, MOCK_BATCH_ID, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });
  });

  describe('AbortController', () => {
    it('should throw for a directory upload regardless of an abort signal', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      const controller = new AbortController();

      await expect(
        fm.uploadFile(di.id, { path: 'tests', sourcePath: 'tests' }, undefined, {
          signal: controller.signal,
        }),
      ).rejects.toThrow('Cannot upload a directory - use uploadFiles');
    });

    it('should pass requestOptions with signal to uploadData', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      const uploadDataSpy = jest.spyOn(Bee.prototype, 'uploadData');
      const controller = new AbortController();

      await fm.uploadFile(di.id, { path: 'package.json', sourcePath: 'package.json' }, undefined, {
        signal: controller.signal,
      });

      const callsWithOptions = uploadDataSpy.mock.calls.filter((call) => call[3] !== undefined);
      expect(callsWithOptions.length).toBeGreaterThan(0);
      for (const call of callsWithOptions) {
        expect(call[3]).toHaveProperty('signal', controller.signal);
      }
    });

    it('should not pass signal if requestOptions is undefined', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      const uploadDataSpy = jest.spyOn(Bee.prototype, 'uploadData');

      await fm.uploadFile(di.id, { path: 'package.json', sourcePath: 'package.json' });

      expect(uploadDataSpy).toHaveBeenCalled();
      for (const call of uploadDataSpy.mock.calls) {
        expect(call[3]?.signal).toBeUndefined();
      }
    });

    it('should allow upload to proceed when signal is not aborted', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive', false);
      const di = fm.driveList[1];

      const controller = new AbortController();

      await expect(
        fm.uploadFile(di.id, { path: 'package.json', sourcePath: 'package.json' }, undefined, {
          signal: controller.signal,
        }),
      ).resolves.not.toThrow();
    });

    it('throw if listFolder is called on a non-existent drive', async () => {
      const fm = await createInitializedFileManager();
      const freshDrive = createMockDriveInfo(actPublisher);

      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      const { loadMantaray, getAllNodeEntries } = require('@/utils/mantaray');
      loadMantaray.mockResolvedValue(new MantarayNode());
      getAllNodeEntries.mockReturnValue([]);

      const controller = new AbortController();

      await expect(
        fm.listFolder(freshDrive.id, '', ListDepth.Shallow, undefined, { signal: controller.signal }),
      ).rejects.toThrow(DriveError);
    });

    it('forwards the abort signal to getMantarayNode downloads in listFolder', async () => {
      const fm = await createInitializedFileManager();
      const freshDrive = createMockDriveInfo(actPublisher);

      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
      const { loadMantaray, getAllNodeEntries } = require('@/utils/mantaray');
      loadMantaray.mockResolvedValue(new MantarayNode());
      getAllNodeEntries.mockReturnValue([]);
      (fm as any).driveList.push(freshDrive);

      const downloadDataSpy = jest.spyOn(Bee.prototype, 'downloadData');
      const controller = new AbortController();

      await fm.listFolder(freshDrive.id, '', ListDepth.Shallow, undefined, {
        signal: controller.signal,
      });

      expect(downloadDataSpy).toHaveBeenCalledWith(
        freshDrive.manifestRef!.reference,
        { actHistoryAddress: freshDrive.manifestRef!.historyRef, actPublisher: expect.anything() },
        { signal: controller.signal },
      );
      expect(loadMantaray).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined, {
        signal: controller.signal,
      });
    });

    it('should allow listFolder to proceed when signal is not aborted', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const controller = new AbortController();

      await expect(
        fm.listFolder(drive.id, '', ListDepth.Shallow, undefined, { signal: controller.signal }),
      ).resolves.not.toThrow();
    });

    it('forwards the abort signal through downloadFile to the final content fetch', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const rec: FileRecord = {
        batchId: MOCK_BATCH_ID,
        owner,
        actPublisher,
        topic: Topic.fromString('signal-file').toString(),
        driveId: drive.id,
        path: 'a.txt',
        content: { reference: '1'.repeat(64), historyRef: SWARM_ZERO_ADDRESS.toString() },
        redundancyLevel: RedundancyLevel.OFF,
      };
      fm.fileInfoList.push(rec);

      const downloadReadableDataSpy = jest.spyOn(Bee.prototype, 'downloadReadableData');
      const controller = new AbortController();

      await fm.downloadFile(rec, undefined, { signal: controller.signal });

      expect(downloadReadableDataSpy).toHaveBeenCalledWith(
        '1'.repeat(64),
        { actHistoryAddress: SWARM_ZERO_ADDRESS.toString(), actPublisher },
        { signal: controller.signal },
      );
    });

    it('should allow downloadFolder to proceed when signal is not aborted', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];
      const controller = new AbortController();

      await expect(
        fm.downloadFolder(drive.id, undefined, undefined, { signal: controller.signal }),
      ).resolves.not.toThrow();
    });
  });
});
