import { Bee, FeedIndex, type PrivateKey, Topic } from '@ethersphere/bee-js';

import { BEE_URL, createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { applyDefaultMocks, mockStampInfo } from './mock';

import { EventEmitterBase } from '@/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { BeeClient } from '@/swarm';
import { FileManagerEvents, SignerError } from '@/utils';
import { fetchStamp, getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, SWARM_ZERO_ADDRESS } from '@/utils/constants';
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

    // The signer guard moved to the backend: FileManagerBase never sees key material, so it is
    // BeeClient that refuses to be built without one.
    it('should throw error, if Signer is not provided to the backend', () => {
      const bee = new Bee(BEE_URL);
      const noSigner = undefined as unknown as PrivateKey;
      expect(() => new BeeClient(bee, noSigner)).toThrow(SignerError);
      expect(() => new BeeClient(bee, noSigner)).toThrow('Signer required');
    });

    it('should initialize FileManager instance with correct values', async () => {
      const fm = await createInitializedFileManager();

      expect(fm.recordList).toEqual([]);
    });
  });

  describe('initialize', () => {
    it('should initialize FileManager', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const eventHandler = jest.fn();
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);
      await createInitializedFileManager(client, undefined, emitter);

      expect(eventHandler).toHaveBeenCalledWith(true);
    });

    it('should not initialize, if already initialized', async () => {
      const logSpy = jest.spyOn(console, 'debug');
      const eventHandler = jest.fn();
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, eventHandler);

      const fm = await createInitializedFileManager(
        new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER),
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

      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const fm = new FileManagerBase(client, emitter);
      fm.initialize();
      fm.initialize();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FileManager is being initialized'));
    });

    it('does not eagerly load any file records — hydration is lazy', async () => {
      const fm = await createInitializedFileManager();

      expect(fm.driveList.length).toBeGreaterThan(0);
      expect(fm.recordList).toHaveLength(0);
    });

    it('reports failure and rolls partial state back, leaving the instance retryable', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const emitter = new EventEmitterBase();
      const events: boolean[] = [];
      emitter.on(FileManagerEvents.INITIALIZED, (ok: boolean) => events.push(ok));

      const fm = new FileManagerBase(client, emitter);
      jest.spyOn(Bee.prototype, 'getNodeAddresses').mockRejectedValueOnce(new Error('bee offline'));

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
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
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

      const fm = new FileManagerBase(client, emitter);
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
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const emitter = new EventEmitterBase();

      (fetchStamp as jest.Mock).mockResolvedValue({ ...mockStampInfo, usable: true });

      const fm = await createInitializedFileManager(client, DUMMY_BATCH_ID, emitter);
      expect(fm.adminStamp?.usable).toBe(true);
      expect(fm.driveList).toHaveLength(1);

      let reinitFired = false;
      emitter.on(FileManagerEvents.INITIALIZED, () => {
        reinitFired = true;
      });

      await fm.initialize();
      expect(reinitFired).toBe(true);
      expect(fm.driveList).toHaveLength(1);
    });

    it('should successfully revalidate when admin stamp is still valid', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const emitter = new EventEmitterBase();

      const fm = await createInitializedFileManager(client, DUMMY_BATCH_ID, emitter);
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
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const fm = await createInitializedFileManager(client, DUMMY_BATCH_ID);

      const initialDriveCount = fm.driveList.length;

      for (let i = 0; i < 3; i++) {
        await fm.initialize();
        expect(fm.driveList).toHaveLength(initialDriveCount);
      }
    });

    it('should reset isInitialized flag when admin stamp becomes invalid', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      await createInitializedFileManager(client, DUMMY_BATCH_ID);

      (fetchStamp as jest.Mock).mockResolvedValue({ ...mockStampInfo, usable: false });

      const newFm = new FileManagerBase(client);
      await newFm.initialize();

      expect((newFm as any).isInitialized).toBe(true);
      expect(newFm.driveList).toHaveLength(0);
      expect(newFm.recordList).toHaveLength(0);
    });

    it('should maintain isInitialized flag after successful reinitialization', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const fm = await createInitializedFileManager(client, DUMMY_BATCH_ID);

      expect((fm as any).isInitialized).toBe(true);

      await fm.initialize();

      expect((fm as any).isInitialized).toBe(true);
    });

    it('should not clear drives when reinitializing with valid stamp', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const fm = await createInitializedFileManager(client, DUMMY_BATCH_ID);

      const drivesBefore = fm.driveList;
      expect(drivesBefore.length).toBeGreaterThan(0);

      await fm.initialize();

      const drivesAfter = fm.driveList;
      expect(drivesAfter).toEqual(drivesBefore);
    });

    it('should maintain admin stamp reference after reinitialization', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const fm = await createInitializedFileManager(client, DUMMY_BATCH_ID);

      const adminStampBefore = fm.adminStamp;
      expect(adminStampBefore).toBeDefined();

      await fm.initialize();

      const adminStampAfter = fm.adminStamp;
      expect(adminStampAfter).toBeDefined();
      expect(adminStampAfter?.batchId).toBe(adminStampBefore?.batchId);
    });

    it('should clear recordList when admin stamp becomes invalid', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      await createInitializedFileManager(client, DUMMY_BATCH_ID);

      (fetchStamp as jest.Mock).mockResolvedValue({ ...mockStampInfo, usable: false });

      const newFm = new FileManagerBase(client);
      await newFm.initialize();

      expect(newFm.recordList).toHaveLength(0);
      expect(newFm.driveList).toHaveLength(0);
    });

    it('should not emit STATE_INVALID when admin stamp remains valid', async () => {
      const client = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER);
      const emitter = new EventEmitterBase();

      const fm = await createInitializedFileManager(client, DUMMY_BATCH_ID, emitter);

      let invalidEventFired = false;
      emitter.on(FileManagerEvents.STATE_INVALID, () => {
        invalidEventFired = true;
      });

      await fm.initialize();

      expect(invalidEventFired).toBe(false);
    });
  });
});
