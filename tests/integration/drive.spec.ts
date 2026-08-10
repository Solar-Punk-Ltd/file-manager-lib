import { Bee, Identifier, PostageBatch, PrivateKey, RedundancyLevel } from '@ethersphere/bee-js';

import { buyStampSerialized, createInitializedFileManager, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH } from '../utils';

import { ensureUniqueSignerWithStamp, tempFileRegistry } from './setup/utils';

import { FileManagerBase } from '@/fileManager';
import { DriveInfo } from '@/types';
import { DriveError, FileManagerEvents } from '@/utils';

describe('Drive operations', () => {
  let bee: Bee;
  let fileManager: FileManagerBase;
  let ownerBatch: PostageBatch;
  let signer: PrivateKey;
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    const { bee: beeDev, ownerStamp, signer: newSigner } = await ensureUniqueSignerWithStamp();
    bee = beeDev;
    signer = newSigner;
    const stamp = (await bee.getPostageBatches()).find((s) => s.batchID.toString() === ownerStamp.toString());

    expect(stamp).toBeDefined();
    expect(stamp?.batchID.toString() === ownerStamp.toString()).toBeTruthy();
    ownerBatch = stamp!;

    fileManager = await createInitializedFileManager(bee, ownerStamp);
  });

  afterAll(cleanup);

  it('should create a drive and retrieve it', async () => {
    const batchId = await buyStampSerialized(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'createDriveStamp');

    await fileManager.createDrive(batchId, 'Test Drive');
    const drives = fileManager.driveList;
    expect(drives.length).toBeGreaterThanOrEqual(1);
    const testDrive = drives.find((d) => d.name === 'Test Drive');
    expect(testDrive).toBeDefined();
    expect(new Identifier(testDrive!.id)).toHaveLength(Identifier.LENGTH);
    expect(testDrive!.batchId).toBe(batchId.toString());
    expect(testDrive!.name).toBe('Test Drive');
    expect(testDrive!.owner).toBe(signer.publicKey().address().toHex());
    expect(testDrive!.redundancyLevel).toBe(RedundancyLevel.OFF);
    expect(fileManager.recordList.filter((fr) => fr.driveId === testDrive!.id)).toHaveLength(0);
  });

  it('should forget a user drive: removes the drive, prunes its files, and persists the change', async () => {
    const forgetBatchId = await buyStampSerialized(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'forgetDriveStamp');
    await fileManager.createDrive(forgetBatchId, 'Drive to forget');

    const created = fileManager.driveList.find((d) => d.name === 'Drive to forget');
    expect(created).toBeDefined();
    const driveId = created!.id.toString();
    const initialDriveCount = fileManager.driveList.length;

    const fileA = writeTempFile('forget-drive-a.txt', 'forget a content');
    const fileB = writeTempFile('forget-drive-b.txt', 'forget b content');
    const uploadResult = await fileManager.uploadFiles(
      driveId,
      [
        { path: 'a.txt', sourcePath: fileA },
        { path: 'b.txt', sourcePath: fileB },
      ],
      '',
    );
    expect(uploadResult.failed).toHaveLength(0);

    expect(fileManager.recordList.some((fr) => fr.driveId === driveId)).toBe(true);

    const eventPromise = new Promise<void>((resolve) => {
      const handler = ({ driveInfo }: { driveInfo: DriveInfo }): void => {
        try {
          expect(driveInfo.id.toString()).toBe(driveId);
          resolve();
        } finally {
          fileManager.emitter?.off?.(FileManagerEvents.DRIVE_FORGOTTEN, handler);
        }
      };
      fileManager.emitter.on(FileManagerEvents.DRIVE_FORGOTTEN, handler);
    });
    await fileManager.forgetDrive(new Identifier(created!.id));
    await eventPromise;
    const afterForgetDrives = fileManager.driveList;
    expect(afterForgetDrives).toHaveLength(initialDriveCount - 1);
    expect(afterForgetDrives.find((d) => d.id.toString() === driveId)).toBeUndefined();

    expect(fileManager.recordList.some((fr) => fr.driveId === driveId)).toBe(false);

    const fm2 = await createInitializedFileManager(bee, ownerBatch.batchID);
    const drives2 = fm2.driveList;
    expect(drives2.find((d) => d.name === 'Drive to forget')).toBeUndefined();
  });

  it('should throw when trying to forget the admin drive', async () => {
    const adminDrive = fileManager.driveList.find((d) => d.isAdmin);
    expect(adminDrive).toBeDefined();
    await expect(fileManager.forgetDrive(new Identifier(adminDrive!.id))).rejects.toThrow(
      new DriveError('Cannot forget admin drive'),
    );
  });

  it('should throw when trying to forget a non-existent drive', async () => {
    const idBytes = new Uint8Array(Identifier.LENGTH);
    idBytes.fill(1);
    await expect(fileManager.forgetDrive(new Identifier(idBytes))).rejects.toThrow(
      new DriveError(`Drive with id ${new Identifier(idBytes).toString().slice(0, 6)} not found`),
    );
  });
});
