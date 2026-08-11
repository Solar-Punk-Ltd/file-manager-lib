import { BatchId, Bee, Identifier, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import { createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { applyDefaultMocks, createMockDriveInfo, createMockNodeAddresses, seedRecords } from './mock';

import { type DriveInfo, NodeType } from '@/types';
import { DriveError, FileManagerEvents } from '@/utils';
import { ADMIN_DRIVE_NAME, SWARM_ZERO_ADDRESS } from '@/utils/constants';

describe('Drive operations', () => {
  const otherMockBatchId = new BatchId('4'.repeat(64));
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();
  const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();

  beforeEach(async () => {
    applyDefaultMocks();
  });

  describe('createAdminDrive', () => {
    it('should create an admin drive', async () => {
      const fm = await createInitializedFileManager();
      const di = fm.driveList[0];
      expect(di).toBeDefined();
      expect(di.name).toBe(ADMIN_DRIVE_NAME);
      expect(di.batchId).toBe(DUMMY_BATCH_ID.toString());
      expect(di.id).toHaveLength(64);
      expect(di.owner).toBe(owner);
      expect(di.topic).toBeDefined();
      expect(di.manifestRef).toBeDefined();
      expect(di.isAdmin).toBe(true);
    });

    it('should throw error if an admin drive already exists', async () => {
      const fm = await createInitializedFileManager();
      await expect(fm.createAdminDrive('1'.repeat(64))).rejects.toThrow(new DriveError('Admin drive already exists'));
    });
  });

  describe('createDrive', () => {
    it('should create a new drive', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];
      expect(di).toBeDefined();
      expect(di.name).toBe('Test Drive');
      expect(di.batchId).toBe(otherMockBatchId.toString());
      expect(di.id).toHaveLength(64);
      expect(di.owner).toBe(owner);
      expect(di.topic).toBeDefined();
      expect(di.manifestRef).toBeDefined();
    });

    it('should throw error if drive with same name or batchId exists', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      await expect(fm.createDrive(otherMockBatchId, 'New Drive')).rejects.toThrow(
        new DriveError(
          `Drive with name "New Drive" or batchId "${otherMockBatchId.toString().slice(0, 6)}" already exists`,
        ),
      );
      const newDriveId = 'aa0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';
      await expect(fm.createDrive(newDriveId, 'Test Drive')).rejects.toThrow(
        new DriveError(`Drive with name "Test Drive" or batchId "${newDriveId.slice(0, 6)}" already exists`),
      );
    });
  });

  describe('forgetDrive', () => {
    it('should remove a user drive, prune its files, and emit DRIVE_FORGOTTEN', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Drive to forget (unit)');
      const target = fm.driveList.find((d) => d.name === 'Drive to forget (unit)')!;
      expect(target).toBeDefined();

      seedRecords(
        fm,
        {
          type: NodeType.File,
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
          type: NodeType.File,
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
      expect(fm.recordList.some((fr) => fr.driveId === target.id)).toBe(false);
      expect(diluteSpy).not.toHaveBeenCalled();
    });

    it('should throw when the drive does not exist', async () => {
      const fm = await createInitializedFileManager();
      const ghost = createMockDriveInfo(actPublisher, { id: '9'.repeat(64), name: 'ghost', isAdmin: false });

      await expect(fm.forgetDrive(new Identifier(ghost.id))).rejects.toThrow(
        new DriveError(`Drive with id ${ghost.id.slice(0, 6)} not found`),
      );
    });
  });
});
