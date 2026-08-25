import { BatchId, Bee, BeeResponseError, FeedIndex, RedundancyLevel, Reference, Topic } from '@ethersphere/bee-js';

import {
  buyStampSerialized,
  createInitializedFileManager,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  OTHER_BEE_URL,
  OTHER_MOCK_SIGNER,
  retryOnPropagationDelay,
} from '../utils';

import { ensureUniqueSignerWithStamp } from './setup/utils';

import { BeeClient } from '@/clients';
import { FileManagerBase } from '@/fileManager';
import { type ActReferences } from '@/types';
import { FileManagerEvents, StampError } from '@/utils';
import { assertActReferences } from '@/utils/asserts';
import { getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, STATE_TOPIC_LABEL, SWARM_ZERO_ADDRESS } from '@/utils/constants';
import { generateRandomBytes } from '@/utils/crypto';

describe('Initialization and construction', () => {
  let client: BeeClient;
  let bee: Bee;
  let fileManager: FileManagerBase;
  let actPublisher: string;
  let adminBatchId: BatchId;

  beforeAll(async () => {
    const { client: bc, bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    client = bc;
    bee = beeDev;
    adminBatchId = ownerStamp;
    fileManager = await createInitializedFileManager(client, adminBatchId);
    actPublisher = client.actPublisher;
  });

  beforeEach(async () => {
    jest.resetAllMocks();
  });

  it('should create and initialize a new instance and check if admin stamp is not found', async () => {
    expect(fileManager.recordList).toEqual([]);

    const unpurchasedBatchId = new BatchId(generateRandomBytes(BatchId.LENGTH));
    const otherClient = new BeeClient(new Bee(OTHER_BEE_URL), OTHER_MOCK_SIGNER);
    const fm2 = new FileManagerBase(otherClient);
    try {
      fm2.emitter.on(FileManagerEvents.INITIALIZED, (e) => {
        expect(e).toBeTruthy();
      });
      await fm2.initialize();
      await fm2.createAdminDrive(unpurchasedBatchId, RedundancyLevel.OFF);
    } catch (error: any) {
      expect(error).toBeInstanceOf(StampError);
      expect(error.message).toContain(
        `Stamp with batchId: ${unpurchasedBatchId.toString().slice(0, 6)}... not found OR not usable`,
      );
    }

    expect(fm2.recordList).toEqual([]);
  });

  it('should initialize the admin feed and topic', async () => {
    expect(fileManager.recordList).toEqual([]);

    const stateFeedTopic = new Topic(await client.deriveSecret(STATE_TOPIC_LABEL));

    const { payload } = await retryOnPropagationDelay(() => getFeedData(client, stateFeedTopic, client.owner, 0n));

    const adminManifestRef = payload.toJSON() as ActReferences;
    assertActReferences(adminManifestRef);

    const manifestRoot = await client.downloadProtected({
      reference: adminManifestRef.reference,
      historyRef: adminManifestRef.historyRef,
      publisher: actPublisher,
    });
    expect(manifestRoot).not.toEqual(SWARM_ZERO_ADDRESS.toUint8Array());

    await fileManager.initialize();
    const reinitManifestRoot = await client.downloadProtected({
      reference: adminManifestRef.reference,
      historyRef: adminManifestRef.historyRef,
      publisher: actPublisher,
    });
    expect(manifestRoot).toEqual(reinitManifestRoot);
  });

  it('should throw an error if someone else than the admin tries to read the admin feed', async () => {
    const otherBee = new Bee(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });

    const stateFeedTopic = new Topic(await client.deriveSecret(STATE_TOPIC_LABEL));

    const { payload } = await retryOnPropagationDelay(() => getFeedData(client, stateFeedTopic, client.owner, 0n));
    const feedTopicState = payload.toJSON() as ActReferences;

    try {
      await client.downloadProtected({
        reference: feedTopicState.reference,
        historyRef: feedTopicState.historyRef,
        publisher: OTHER_MOCK_SIGNER.publicKey().toCompressedHex(),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BeeResponseError);
      expect((error as BeeResponseError).status).toBe(404);
    }

    try {
      await retryOnPropagationDelay(() =>
        otherBee.data.download(new Reference(feedTopicState.reference), {
          actHistoryAddress: new Reference(feedTopicState.historyRef),
          actPublisher,
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BeeResponseError);
      expect((error as BeeResponseError).status).toBe(404);
    }
  });

  it('reports an empty feed for an unwritten topic, and Bee reports it as a 404', async () => {
    const unwritten = new Topic(generateRandomBytes(Topic.LENGTH));
    const address = client.owner;

    await expect(bee.feed.makeReader(unwritten.toUint8Array(), address).downloadPayload()).rejects.toMatchObject({
      status: 404,
    });

    const { feedIndex, feedIndexNext, payload } = await getFeedData(client, unwritten, address.toString());

    expect(feedIndex.equals(FeedIndex.MINUS_ONE)).toBe(true);
    expect(feedIndexNext.equals(FEED_INDEX_ZERO)).toBe(true);
    expect(payload.toUint8Array()).toEqual(SWARM_ZERO_ADDRESS.toUint8Array());
  });

  it('should not reinitialize if already initialized', async () => {
    const recordListBefore = [...fileManager.recordList];
    fileManager.emitter.on(FileManagerEvents.INITIALIZED, (e) => {
      expect(e).toEqual(true);
    });
    await fileManager.initialize();
    expect(fileManager.recordList).toEqual(recordListBefore);
  });

  it('should maintain isInitialized flag after successful reinitialization', async () => {
    expect((fileManager as any).isInitialized).toBe(true);
    await fileManager.initialize();
    expect((fileManager as any).isInitialized).toBe(true);
  });

  it('should not clear drives when reinitializing with valid stamp', async () => {
    const drivesBefore = fileManager.driveList;
    expect(drivesBefore.length).toBeGreaterThan(0);

    await fileManager.initialize();

    const drivesAfter = fileManager.driveList;
    expect(drivesAfter).toEqual(drivesBefore);
  });

  it('should maintain admin stamp reference after reinitialization', async () => {
    const adminStampBefore = fileManager.adminStamp;
    expect(adminStampBefore).toBeDefined();

    await fileManager.initialize();

    const adminStampAfter = fileManager.adminStamp;
    expect(adminStampAfter).toBeDefined();
    expect(adminStampAfter?.batchId).toBe(adminStampBefore?.batchId);
  });

  it('initializes against a real node even when the INITIALIZED listener throws', async () => {
    const fm = new FileManagerBase(client);
    fm.emitter.on(FileManagerEvents.INITIALIZED, () => {
      throw new Error('consumer handler blew up');
    });

    await fm.initialize();

    expect(fm.isInitialized).toBe(true);
    expect(fm.driveList.some((d) => d.isAdmin)).toBe(true);
  });

  it('rolls state back after a failed initialize, so a retry against the real node succeeds', async () => {
    const fm = new FileManagerBase(client);
    const events: boolean[] = [];
    fm.emitter.on(FileManagerEvents.INITIALIZED, (ok: boolean) => events.push(ok));

    const spy = jest
      .spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').connectivity), 'getNodeAddresses')
      .mockRejectedValueOnce(new Error('transient node failure'));

    await fm.initialize();
    expect(events).toEqual([false]);
    expect(fm.isInitialized).toBe(false);
    expect(fm.driveList).toHaveLength(0);
    expect(fm.recordList).toHaveLength(0);

    spy.mockRestore();

    await fm.initialize();
    expect(events).toEqual([false, true]);
    expect(fm.isInitialized).toBe(true);
    expect(fm.driveList.some((d) => d.isAdmin)).toBe(true);
  });
});

describe('reinitialization', () => {
  it('should emit STATE_INVALID after expiry', async () => {
    const { client, bee, ownerStamp } = await ensureUniqueSignerWithStamp();
    await createInitializedFileManager(client, ownerStamp);

    const originalFn = bee.stamp.getAll.bind(bee.stamp);
    const spy = jest.spyOn(bee.stamp, 'getAll');

    spy.mockImplementation(async () => {
      await originalFn();
      return [];
    });

    const newFileManager = new FileManagerBase(client);

    newFileManager.emitter.on(FileManagerEvents.STATE_INVALID, (stateInvalidEmitted) => {
      expect(stateInvalidEmitted).toBe(true);
    });

    newFileManager.emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
      expect(success).toBe(true);
    });

    await newFileManager.initialize();

    expect(newFileManager.driveList).toHaveLength(0);
    expect(newFileManager.recordList).toHaveLength(0);

    spy.mockRestore();
  });

  it('should successfully revalidate when admin stamp is still valid', async () => {
    const { client, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(client, ownerStamp);

    const initialDrives = fileManager.driveList;
    const initialFileCount = fileManager.recordList.length;

    expect(initialDrives.length).toBeGreaterThanOrEqual(1);

    let initEventFired = false;
    let invalidEventFired = false;

    fileManager.emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
      initEventFired = true;
      expect(success).toBe(true);
    });

    fileManager.emitter.on(FileManagerEvents.STATE_INVALID, () => {
      invalidEventFired = true;
    });

    await fileManager.initialize();

    expect(initEventFired).toBe(true);
    expect(invalidEventFired).toBe(false);
    expect(fileManager.driveList).toEqual(initialDrives);
    expect(fileManager.recordList).toHaveLength(initialFileCount);
  });

  it('should preserve user data when creating a new instance with valid stamp', async () => {
    const { client, bee, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(client, ownerStamp);

    const userBatchId = await buyStampSerialized(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'userDrive');
    await fileManager.createDrive(userBatchId, 'User Drive');

    const drivesBeforeReinit = fileManager.driveList;
    const userDrive = drivesBeforeReinit.find((d) => d.name === 'User Drive');
    expect(userDrive).toBeDefined();

    const newFileManager = new FileManagerBase(client);
    await newFileManager.initialize();

    const drivesAfterReinit = newFileManager.driveList;
    expect(drivesAfterReinit).toHaveLength(drivesBeforeReinit.length);
    const userDriveAfter = drivesAfterReinit.find((d) => d.name === 'User Drive');
    expect(userDriveAfter).toBeDefined();
    expect(userDriveAfter?.id).toBe(userDrive?.id);
  });

  it('should handle multiple sequential reinitializations with valid stamp', async () => {
    const { client, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(client, ownerStamp);

    const initialDriveCount = fileManager.driveList.length;

    for (let i = 0; i < 3; i++) {
      await fileManager.initialize();
      expect(fileManager.driveList).toHaveLength(initialDriveCount);
    }

    for (let i = 0; i < 2; i++) {
      await retryOnPropagationDelay(
        async () => {
          const freshManager = new FileManagerBase(client);
          await freshManager.initialize();
          expect(freshManager.driveList).toHaveLength(initialDriveCount);
        },
        10,
        1000,
      );
    }
  });

  it('should allow operations after successful revalidation', async () => {
    const { client, bee, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(client, ownerStamp);

    await fileManager.initialize();

    const newBatchId = await buyStampSerialized(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'afterReinit');
    await fileManager.createDrive(newBatchId, 'Post Reinit Drive');

    const drives = fileManager.driveList;
    const newDrive = drives.find((d) => d.name === 'Post Reinit Drive');
    expect(newDrive).toBeDefined();
  });

  it('should emit correct events during revalidation failure', async () => {
    const { client, bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    const originalFn = beeDev.stamp.getAll.bind(beeDev.stamp);
    const spy = jest.spyOn(beeDev.stamp, 'getAll');

    spy.mockImplementation(async () => {
      const batches = await originalFn();
      return batches.map((b) => ({
        ...b,
        usable: true,
        label: b.label,
      }));
    });

    await createInitializedFileManager(client, ownerStamp);

    spy.mockImplementation(async () => {
      await originalFn();
      return [];
    });

    await retryOnPropagationDelay(
      async () => {
        const events: string[] = [];

        const newFileManager = new FileManagerBase(client);
        newFileManager.emitter.on(FileManagerEvents.STATE_INVALID, () => {
          events.push('STATE_INVALID');
        });
        newFileManager.emitter.on(FileManagerEvents.INITIALIZED, (success: boolean) => {
          events.push(`INITIALIZED:${success}`);
        });

        await newFileManager.initialize();

        expect(events).toContain('STATE_INVALID');
        expect(events).toContain('INITIALIZED:true');
      },
      10,
      1000,
    );

    spy.mockRestore();
  });

  it('should not affect other drives when revalidating admin stamp', async () => {
    const { client, bee: beeDev, ownerStamp } = await ensureUniqueSignerWithStamp();
    const fileManager = await createInitializedFileManager(client, ownerStamp);

    const batch1 = await buyStampSerialized(beeDev, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'drive1');
    const batch2 = await buyStampSerialized(beeDev, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'drive2');

    await fileManager.createDrive(batch1, 'Drive 1');
    await fileManager.createDrive(batch2, 'Drive 2');

    const drivesBeforeReinit = fileManager.driveList;
    const drive1 = drivesBeforeReinit.find((d) => d.name === 'Drive 1');
    const drive2 = drivesBeforeReinit.find((d) => d.name === 'Drive 2');

    expect(drive1).toBeDefined();
    expect(drive2).toBeDefined();

    await fileManager.initialize();

    const drivesAfterReinit = fileManager.driveList;
    expect(drivesAfterReinit.find((d) => d.id === drive1?.id)).toBeDefined();
    expect(drivesAfterReinit.find((d) => d.id === drive2?.id)).toBeDefined();
  });
});
