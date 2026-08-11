import { BatchId, Bee, MantarayNode, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import {
  createInitializedFileManager,
  DEFAULT_MOCK_SIGNER,
  DUMMY_BATCH_ID,
  IS_BROWSER,
  makeUploadSource,
} from '../utils';

import { applyDefaultMocks, createMockDriveInfo, createMockNodeAddresses, seedRecords } from './mock';

import { type FileRecord, ListDepth, NodeType } from '@/types';
import { DriveError } from '@/utils';
import { SWARM_ZERO_ADDRESS } from '@/utils/constants';

describe('Abort signal handling', () => {
  const otherMockBatchId = new BatchId('4'.repeat(64));
  const owner = DEFAULT_MOCK_SIGNER.publicKey().address().toString();
  const actPublisher = createMockNodeAddresses().publicKey.toCompressedHex();

  const nodeOnly = IS_BROWSER ? it.skip : it;

  beforeEach(async () => {
    applyDefaultMocks();
  });

  nodeOnly('should throw for a directory upload regardless of an abort signal', async () => {
    const fm = await createInitializedFileManager();
    await fm.createDrive(otherMockBatchId, 'Test Drive');
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
    await fm.createDrive(otherMockBatchId, 'Test Drive');
    const di = fm.driveList[1];

    const uploadDataSpy = jest.spyOn(Bee.prototype, 'uploadData');
    const controller = new AbortController();

    await fm.uploadFile(di.id, { path: 'package.json', ...makeUploadSource('package.json') }, undefined, {
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
    await fm.createDrive(otherMockBatchId, 'Test Drive');
    const di = fm.driveList[1];

    const uploadDataSpy = jest.spyOn(Bee.prototype, 'uploadData');

    await fm.uploadFile(di.id, { path: 'package.json', ...makeUploadSource('package.json') });

    expect(uploadDataSpy).toHaveBeenCalled();
    for (const call of uploadDataSpy.mock.calls) {
      expect(call[3]?.signal).toBeUndefined();
    }
  });

  it('should allow upload to proceed when signal is not aborted', async () => {
    const fm = await createInitializedFileManager();
    await fm.createDrive(otherMockBatchId, 'Test Drive');
    const di = fm.driveList[1];

    const controller = new AbortController();

    await expect(
      fm.uploadFile(di.id, { path: 'package.json', ...makeUploadSource('package.json') }, undefined, {
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
      type: NodeType.File,
      batchId: DUMMY_BATCH_ID,
      owner,
      actPublisher,
      topic: Topic.fromString('signal-file').toString(),
      driveId: drive.id,
      path: 'a.txt',
      content: { reference: '1'.repeat(64), historyRef: SWARM_ZERO_ADDRESS.toString() },
      redundancyLevel: RedundancyLevel.OFF,
    };
    seedRecords(fm, rec);

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

    await expect(fm.downloadFolder(drive.id, '/', undefined, { signal: controller.signal })).resolves.not.toThrow();
  });
});
