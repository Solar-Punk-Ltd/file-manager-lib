import { BatchId, Bee, Identifier, RedundancyLevel, Topic } from '@ethersphere/bee-js';
import { type MantarayNode } from '@ethersphere/core-sdk';

import { createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { applyDefaultMocks, createMockDriveInfo, createMockNodeAddresses, seedRecords } from './mock';

import { type DriveInfo, NodeType } from '@/types';
import { DriveError, FileManagerEvents } from '@/utils';
import {
  ADMIN_DRIVE_NAME,
  MANIFEST_METADATA_DRIVE_ID,
  MANIFEST_METADATA_DRIVE_NAME,
  MANIFEST_METADATA_NODE_TOPIC,
  ROOT_PATH,
  SWARM_ZERO_ADDRESS,
} from '@/utils/constants';
import { getDriveForkPath } from '@/utils/mantaray';

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

    it('should throw error if drive with same name exists', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');

      const otherBatchId = 'aa0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';
      await expect(fm.createDrive(otherBatchId, 'Test Drive')).rejects.toThrow(
        new DriveError('Drive with name "Test Drive" already exists'),
      );
    });

    it('should allow several drives to share one batch', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');

      const second = await fm.createDrive(otherMockBatchId, 'New Drive');
      expect(second.name).toBe('New Drive');
      expect(second.batchId).toBe(otherMockBatchId.toString());
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
          name: 'x.txt',
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
          name: 'y.txt',
          path: 'y.txt',
          content: { reference: SWARM_ZERO_ADDRESS.toString(), historyRef: SWARM_ZERO_ADDRESS.toString() },
          redundancyLevel: RedundancyLevel.OFF,
        },
      );

      const diluteSpy = jest.spyOn(Object.getPrototypeOf(new Bee('http://localhost:1633').stamp), 'dilute');

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

  describe('rename via move', () => {
    it('renames a drive and emits DRIVE_RENAMED', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const drive = fm.driveList[1];
      const topicBefore = drive.topic;
      const manifestRefBefore = drive.manifestRef;

      const renamed = jest.fn();
      fm.emitter.on(FileManagerEvents.DRIVE_RENAMED, renamed);

      await fm.move(ROOT_PATH, 'Renamed Drive', drive.id);

      const after = fm.driveList.find((d) => d.id === drive.id)!;
      expect(after.name).toBe('Renamed Drive');
      expect(after.topic).toBe(topicBefore);
      expect(after.manifestRef).toEqual(manifestRefBefore);
      expect(renamed).toHaveBeenCalledWith({ driveInfo: after });
    });

    it('rewrites the drive fork metadata in place, keeping the id-keyed fork path', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const drive = fm.driveList[1];

      await fm.move(ROOT_PATH, 'Renamed Drive', drive.id);

      const stateTopic = (fm as any).stateFeedTopic.toString();
      const adminMantaray = (fm as any).store.getManifestCache(stateTopic) as MantarayNode;
      const fork = adminMantaray.find(getDriveForkPath(drive.id));

      expect(fork).toBeTruthy();
      expect(fork!.metadata?.[MANIFEST_METADATA_DRIVE_NAME]).toBe('Renamed Drive');
      expect(fork!.metadata?.[MANIFEST_METADATA_DRIVE_ID]).toBe(drive.id);
      expect(fork!.metadata?.[MANIFEST_METADATA_NODE_TOPIC]).toBe(drive.topic);
    });

    it('refuses to rename the admin drive', async () => {
      const fm = await createInitializedFileManager();
      const admin = fm.driveList[0];

      await expect(fm.move(ROOT_PATH, 'not-admin', admin.id)).rejects.toThrow(
        new DriveError('Cannot rename the admin drive'),
      );
      expect(fm.driveList[0].name).toBe(ADMIN_DRIVE_NAME);
    });

    it('refuses a name another drive already carries, and a no-op rename', async () => {
      const fm = await createInitializedFileManager();
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      await fm.createDrive(new BatchId('5'.repeat(64)), 'Second Drive');
      const drive = fm.driveList[1];

      await expect(fm.move(ROOT_PATH, 'Second Drive', drive.id)).rejects.toThrow(
        new DriveError('Drive with name "Second Drive" already exists'),
      );
      await expect(fm.move(ROOT_PATH, 'Test Drive', drive.id)).rejects.toThrow(
        new DriveError('Source and destination names are identical'),
      );
      expect(fm.driveList[1].name).toBe('Test Drive');
    });

    it('still refuses every other root move', async () => {
      const fm = await createInitializedFileManager();
      const drive = fm.driveList[0];

      await expect(fm.move(ROOT_PATH, 'folder/child', drive.id)).rejects.toThrow('Cannot move root folder');
      await expect(fm.move(ROOT_PATH, ROOT_PATH, drive.id)).rejects.toThrow('Cannot move root folder');
      await expect(fm.move(ROOT_PATH, '', drive.id)).rejects.toThrow('Cannot move root folder');
    });
  });
});
