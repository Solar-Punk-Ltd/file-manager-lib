import { Bee, FeedIndex, Topic } from '@ethersphere/bee-js';

import { BEE_URL, createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { applyDefaultMocks, createMockNodeAddresses, mockPostageBatch } from './mock';

import { EventEmitterBase } from '@/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { NodeType, type UnresolvedDrive } from '@/types';
import { FileManagerEvents, SignerError } from '@/utils';
import { getFeedData } from '@/utils/bee';
import {
  ADMIN_DRIVE_NAME,
  FEED_INDEX_ZERO,
  MANIFEST_METADATA_DRIVE_ACT_PUBLISHER,
  MANIFEST_METADATA_DRIVE_BATCH_ID,
  MANIFEST_METADATA_DRIVE_ID,
  MANIFEST_METADATA_DRIVE_IS_ADMIN,
  MANIFEST_METADATA_DRIVE_NAME,
  MANIFEST_METADATA_DRIVE_OWNER,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_REDUNDANCY_LEVEL,
  SWARM_ZERO_ADDRESS,
} from '@/utils/constants';
import { getAllNodeEntries } from '@/utils/mantaray';

describe('Initialization and construction', () => {
  beforeEach(async () => {
    applyDefaultMocks();
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

      expect(fm.recordList).toEqual([]);
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
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FileManager is already initialized'));
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

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FileManager is being initialized'));
    });

    it('does not eagerly load any file records — hydration is lazy', async () => {
      const fm = await createInitializedFileManager();

      expect(fm.driveList.length).toBeGreaterThan(0);
      expect(fm.recordList).toHaveLength(0);
    });

    it('emits DRIVE_UNRESOLVED for a drive it cannot load instead of dropping it silently', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();
      const unresolved: UnresolvedDrive[] = [];
      emitter.on(FileManagerEvents.DRIVE_UNRESOLVED, (d: UnresolvedDrive) => unresolved.push(d));

      const fm = new FileManagerBase(bee, emitter);

      const driveTopic = Topic.fromString('unresolved-drive').toString();
      const driveId = 'a'.repeat(64);

      (getAllNodeEntries as jest.Mock).mockReturnValue([
        {
          path: `/drive-${driveId}`,
          type: NodeType.Drive,
          topic: driveTopic,
          rawMetadata: {
            [MANIFEST_METADATA_NODE_TOPIC]: driveTopic,
            [MANIFEST_METADATA_NODE_TYPE]: NodeType.Drive,
            [MANIFEST_METADATA_DRIVE_ID]: driveId,
            [MANIFEST_METADATA_DRIVE_NAME]: 'broken-drive',
            [MANIFEST_METADATA_DRIVE_OWNER]: DEFAULT_MOCK_SIGNER.publicKey().address().toString(),
            [MANIFEST_METADATA_DRIVE_BATCH_ID]: DUMMY_BATCH_ID.toString(),
            [MANIFEST_METADATA_DRIVE_IS_ADMIN]: 'false',
            [MANIFEST_METADATA_DRIVE_ACT_PUBLISHER]: createMockNodeAddresses().publicKey.toCompressedHex(),
            [MANIFEST_METADATA_REDUNDANCY_LEVEL]: '0',
          },
        },
      ]);

      const feedResult = (feedIndex: FeedIndex, feedIndexNext: FeedIndex): unknown => ({
        feedIndex,
        feedIndexNext,
        payload: {
          toUint8Array: () => SWARM_ZERO_ADDRESS.toUint8Array(),
          toJSON: () => ({
            reference: SWARM_ZERO_ADDRESS.toString(),
            historyRef: SWARM_ZERO_ADDRESS.toString(),
          }),
        },
      });

      (getFeedData as jest.Mock).mockImplementation(async (_bee: Bee, topic: Topic) =>
        topic.toString() === driveTopic
          ? feedResult(FeedIndex.MINUS_ONE, FEED_INDEX_ZERO)
          : feedResult(FEED_INDEX_ZERO, FeedIndex.fromBigInt(1n)),
      );

      await fm.initialize();

      expect(fm.driveList.find((d) => d.id === driveId)).toBeUndefined();
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({ id: driveId, name: 'broken-drive' });
      expect(unresolved[0].error).toContain('manifest feed');
    });

    it('emits DRIVE_UNRESOLVED for a malformed drive fork it cannot even parse', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();
      const unresolved: UnresolvedDrive[] = [];
      emitter.on(FileManagerEvents.DRIVE_UNRESOLVED, (d: UnresolvedDrive) => unresolved.push(d));

      const fm = new FileManagerBase(bee, emitter);

      (getAllNodeEntries as jest.Mock).mockReturnValue([
        {
          path: '/drive-malformed',
          type: NodeType.Drive,
          topic: Topic.fromString('malformed-drive').toString(),
          rawMetadata: {},
        },
      ]);

      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FEED_INDEX_ZERO,
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toUint8Array: () => SWARM_ZERO_ADDRESS.toUint8Array(),
          toJSON: () => ({
            reference: SWARM_ZERO_ADDRESS.toString(),
            historyRef: SWARM_ZERO_ADDRESS.toString(),
          }),
        },
      });

      await fm.initialize();

      expect(fm.driveList).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({ id: 'unknown', name: 'unknown' });
      expect(unresolved[0].error).toContain('drive fork metadata');
    });

    it('reports failure and rolls partial state back, leaving the instance retryable', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();
      const events: boolean[] = [];
      emitter.on(FileManagerEvents.INITIALIZED, (ok: boolean) => events.push(ok));

      const fm = new FileManagerBase(bee, emitter);
      jest
        .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').connectivity), 'getNodeAddresses')
        .mockRejectedValueOnce(new Error('bee offline'));

      await fm.initialize();

      expect(events).toEqual([false]);
      expect(fm.isInitialized).toBe(false);
      expect(fm.driveList).toHaveLength(0);
      expect(fm.recordList).toHaveLength(0);

      await fm.initialize();

      expect(events).toEqual([false, true]);
      expect(fm.isInitialized).toBe(true);
    });

    it('recovers from a failure raised after the admin manifest was already cached', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();
      const events: boolean[] = [];
      emitter.on(FileManagerEvents.INITIALIZED, (ok: boolean) => events.push(ok));

      // A resolvable state feed, so initialize() gets as far as loading the admin manifest.
      (getFeedData as jest.Mock).mockResolvedValue({
        feedIndex: FEED_INDEX_ZERO,
        feedIndexNext: FeedIndex.fromBigInt(1n),
        payload: {
          toUint8Array: () => Topic.fromString('state-feed').toUint8Array(),
          toJSON: () => ({ reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() }),
        },
      });

      const fm = new FileManagerBase(bee, emitter);
      (getAllNodeEntries as jest.Mock).mockImplementationOnce(() => {
        throw new Error('corrupt admin manifest');
      });

      await fm.initialize();
      expect(events).toEqual([false]);
      expect(fm.isInitialized).toBe(false);

      await fm.initialize();
      expect(events).toEqual([false, true]);
      expect(fm.isInitialized).toBe(true);
    });
  });

  describe('reinitialization', () => {
    it('should emit STATE_INVALID when admin stamp becomes unusable during reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const getPostageBatchesSpy = jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').stamp), 'getAll');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: true,
          label: ADMIN_DRIVE_NAME,
        },
      ]);

      const fm = await createInitializedFileManager(bee, DUMMY_BATCH_ID, emitter);
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

      const fm = await createInitializedFileManager(bee, DUMMY_BATCH_ID, emitter);
      const initialDrives = fm.driveList;
      const initialFileCount = fm.recordList.length;

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
      expect(fm.recordList).toHaveLength(initialFileCount);
    });

    it('should handle multiple sequential reinitializations with valid stamp', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, DUMMY_BATCH_ID);

      const initialDriveCount = fm.driveList.length;

      for (let i = 0; i < 3; i++) {
        await fm.initialize();
        expect(fm.driveList).toHaveLength(initialDriveCount);
      }
    });

    it('should reset isInitialized flag when admin stamp becomes invalid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      await createInitializedFileManager(bee, DUMMY_BATCH_ID);

      const getPostageBatchesSpy = jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').stamp), 'getAll');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: false,
          label: ADMIN_DRIVE_NAME,
        },
      ]);

      const newFm = new FileManagerBase(bee);
      await newFm.initialize();

      expect((newFm as any).isInitialized).toBe(true);
      expect(newFm.driveList).toHaveLength(0);
      expect(newFm.recordList).toHaveLength(0);

      getPostageBatchesSpy.mockRestore();
    });

    it('should maintain isInitialized flag after successful reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, DUMMY_BATCH_ID);

      expect((fm as any).isInitialized).toBe(true);

      await fm.initialize();

      expect((fm as any).isInitialized).toBe(true);
    });

    it('should not clear drives when reinitializing with valid stamp', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, DUMMY_BATCH_ID);

      const drivesBefore = fm.driveList;
      expect(drivesBefore.length).toBeGreaterThan(0);

      await fm.initialize();

      const drivesAfter = fm.driveList;
      expect(drivesAfter).toEqual(drivesBefore);
    });

    it('should maintain admin stamp reference after reinitialization', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = await createInitializedFileManager(bee, DUMMY_BATCH_ID);

      const adminStampBefore = fm.adminStamp;
      expect(adminStampBefore).toBeDefined();

      await fm.initialize();

      const adminStampAfter = fm.adminStamp;
      expect(adminStampAfter).toBeDefined();
      expect(adminStampAfter?.batchID.toString()).toBe(adminStampBefore?.batchID.toString());
    });

    it('should clear recordList when admin stamp becomes invalid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      await createInitializedFileManager(bee, DUMMY_BATCH_ID);

      const getPostageBatchesSpy = jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').stamp), 'getAll');
      getPostageBatchesSpy.mockResolvedValue([
        {
          ...mockPostageBatch,
          usable: false,
          label: ADMIN_DRIVE_NAME,
        },
      ]);

      const newFm = new FileManagerBase(bee);
      await newFm.initialize();

      expect(newFm.recordList).toHaveLength(0);
      expect(newFm.driveList).toHaveLength(0);

      getPostageBatchesSpy.mockRestore();
    });

    it('should not emit STATE_INVALID when admin stamp remains valid', async () => {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const emitter = new EventEmitterBase();

      const fm = await createInitializedFileManager(bee, DUMMY_BATCH_ID, emitter);

      let invalidEventFired = false;
      emitter.on(FileManagerEvents.STATE_INVALID, () => {
        invalidEventFired = true;
      });

      await fm.initialize();

      expect(invalidEventFired).toBe(false);
    });
  });
});
