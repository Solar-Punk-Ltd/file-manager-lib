import { BatchId, Bee, RedundancyLevel } from '@ethersphere/bee-js';

import { BEE_URL, createInitializedFileManager, DEFAULT_MOCK_SIGNER, DUMMY_BATCH_ID } from '../utils';

import { applyDefaultMocks } from './mock';

import { EventEmitterBase } from '@/eventEmitter';
import { NodeStatus } from '@/types';
import { FileManagerEvents } from '@/utils';

describe('Events and emitter', () => {
  const otherMockBatchId = new BatchId('4'.repeat(64));
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();

  beforeEach(async () => {
    applyDefaultMocks();
  });

  it('emits FILE_UPLOADED with the persisted FileRecord', async () => {
    const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
    const emitter = new EventEmitterBase();
    const uploadHandler = jest.fn();

    const fm = await createInitializedFileManager(bee, DUMMY_BATCH_ID, emitter);
    fm.emitter.on(FileManagerEvents.FILE_UPLOADED, uploadHandler);
    const redundancy = RedundancyLevel.MEDIUM;
    await fm.createDrive(otherMockBatchId, 'Test Drive', redundancy);
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
        status: NodeStatus.Active,
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
    await createInitializedFileManager(bee, DUMMY_BATCH_ID, emitter);

    expect(eventHandler).toHaveBeenCalledWith(true);
  });
});
