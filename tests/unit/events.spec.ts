import { BatchId, Bee, RedundancyLevel } from '@ethersphere/bee-js';

import { BEE_URL, createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID, makeUploadSource } from '../utils';

import { applyDefaultMocks } from './mock';

import { BeeClient } from '@/clients';
import { EventEmitterBase } from '@/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { NodeStatus } from '@/types';
import { FileManagerEvents } from '@/utils';

describe('Events and emitter', () => {
  const otherMockBatchId = new BatchId('4'.repeat(64));
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();

  beforeEach(async () => {
    applyDefaultMocks();
  });

  it('emits FILE_UPLOADED with the persisted FileRecord', async () => {
    const emitter = new EventEmitterBase();
    const uploadHandler = jest.fn();

    const fm = await createInitializedFileManager(
      new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER),
      DUMMY_BATCH_ID,
      emitter,
    );
    fm.emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);
    const redundancy = RedundancyLevel.MEDIUM;
    await fm.createDrive(otherMockBatchId, 'Test Drive', redundancy);
    const di = fm.driveList[1];

    jest.useFakeTimers();
    const fixedNow = 1_755_158_248_500;
    jest.setSystemTime(new Date(fixedNow));

    await fm.uploadFile(di.id, { path: 'package.json', ...makeUploadSource('package.json') });
    fm.emitter.off(FileManagerEvents.FILE_UPLOADED, uploadHandler);

    expect(uploadHandler).toHaveBeenCalledWith({
      record: expect.objectContaining({
        batchId: otherMockBatchId.toString(),
        driveId: di.id,
        path: 'package.json',
        owner,
        redundancyLevel: redundancy,
        status: NodeStatus.Active,
        timestamp: fixedNow,
        topic: expect.any(String),
      }),
    });

    jest.useRealTimers();
  });

  it('emits an INITIALIZED event with true on successful init', async () => {
    const eventHandler = jest.fn();
    const emitter = new EventEmitterBase();
    emitter.on(FileManagerEvents.INITIALIZED, eventHandler);
    await createInitializedFileManager(new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER), DUMMY_BATCH_ID, emitter);

    expect(eventHandler).toHaveBeenCalledWith(true);
  });

  // Emit sites sit mid-method, so a consumer's throwing handler must not become a library failure.
  describe('listener isolation', () => {
    it('keeps delivering to the remaining listeners when one throws', () => {
      const emitter = new EventEmitterBase();
      const before = jest.fn();
      const after = jest.fn();

      emitter.on('some-event', before);
      emitter.on('some-event', () => {
        throw new Error('listener blew up');
      });
      emitter.on('some-event', after);

      expect(() => emitter.emit('some-event', 'payload')).not.toThrow();
      expect(before).toHaveBeenCalledWith('payload');
      expect(after).toHaveBeenCalledWith('payload');
    });

    it('initializes successfully even when an INITIALIZED listener throws', async () => {
      const emitter = new EventEmitterBase();
      emitter.on(FileManagerEvents.INITIALIZED, () => {
        throw new Error('consumer handler blew up');
      });

      const fm = new FileManagerBase(new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER), emitter);
      await fm.initialize();

      expect(fm.isInitialized).toBe(true);
    });

    it('completes an upload even when the FILE_UPLOADED listener throws', async () => {
      const emitter = new EventEmitterBase();

      const fm = await createInitializedFileManager(
        new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER),
        DUMMY_BATCH_ID,
        emitter,
      );
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      const di = fm.driveList[1];

      fm.emitter.on(FileManagerEvents.FILE_UPLOADED, () => {
        throw new Error('consumer handler blew up');
      });

      const record = await fm.uploadFile(di.id, { path: 'package.json', ...makeUploadSource('package.json') });

      expect(record.path).toBe('package.json');
      expect(fm.recordList.filter((fr) => fr.path === 'package.json')).toHaveLength(1);
    });
  });
});
