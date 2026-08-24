import { BatchId, Bee, type BeeRequestOptions, MantarayNode, RedundancyLevel, Topic } from '@ethersphere/bee-js';

import {
  abortAfterFirstRecordWrite,
  BEE_URL,
  createInitializedFileManager,
  DEFAULT_MOCK_SIGNER,
  DUMMY_BATCH_ID,
  IS_BROWSER,
  makeUploadSource,
} from '../utils';

import { applyDefaultMocks, createMockDriveInfo, createMockNodeAddresses, seedRecords } from './mock';

import { EventEmitterBase } from '@/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { type DriveInfo, FailureScope, type FileRecord, ListDepth, NodeType } from '@/types';
import { DriveError } from '@/utils';
import { getFeedData } from '@/utils/bee';
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

  describe('uploadFiles', () => {
    async function sequentialFm(): Promise<FileManagerBase> {
      const bee = new Bee(BEE_URL, { signer: DEFAULT_MOCK_SIGNER });
      const fm = new FileManagerBase(bee, new EventEmitterBase(), { uploadConcurrency: 1 });
      await fm.initialize();
      await fm.createAdminDrive(DUMMY_BATCH_ID, RedundancyLevel.MEDIUM);
      await fm.createDrive(otherMockBatchId, 'Test Drive');
      return fm;
    }

    it('rejects immediately when the signal is already aborted', async () => {
      const fm = await sequentialFm();
      const di = fm.driveList[1];

      const controller = new AbortController();
      controller.abort();

      const uploadDataSpy = jest.spyOn(Bee.prototype, 'uploadData');
      uploadDataSpy.mockClear();

      await expect(
        fm.uploadFiles(di.id, [{ path: 'pre-aborted.txt', ...makeUploadSource('package.json') }], '', undefined, {
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      expect(uploadDataSpy).not.toHaveBeenCalled();
    });

    it('stops paying for the rest of the batch as soon as the signal fires', async () => {
      const fm = await sequentialFm();
      const di = fm.driveList[1];

      const controller = new AbortController();
      abortAfterFirstRecordWrite(fm, controller);

      const uploadDataSpy = jest.spyOn(Bee.prototype, 'uploadData');
      uploadDataSpy.mockClear();

      await expect(
        fm.uploadFiles(
          di.id,
          [
            { path: 'first.txt', ...makeUploadSource('package.json') },
            { path: 'never-one.txt', ...makeUploadSource('package.json') },
            { path: 'never-two.txt', ...makeUploadSource('package.json') },
          ],
          '',
          undefined,
          { signal: controller.signal },
        ),
      ).rejects.toThrow();

      const uploadedPayloads = uploadDataSpy.mock.calls.length;
      expect(uploadedPayloads).toBeGreaterThan(0);
      expect(uploadedPayloads).toBeLessThanOrEqual(2);
    });

    it('discards the aborted batch from local state instead of leaving it half-applied', async () => {
      const fm = await sequentialFm();
      const di = fm.driveList[1];

      const controller = new AbortController();
      abortAfterFirstRecordWrite(fm, controller);

      const recordsBefore = fm.recordList.length;
      const manifestRefBefore = { ...di.manifestRef } as Required<DriveInfo>['manifestRef'];

      await expect(
        fm.uploadFiles(
          di.id,
          [
            { path: 'aborted-one.txt', ...makeUploadSource('package.json') },
            { path: 'aborted-two.txt', ...makeUploadSource('package.json') },
          ],
          '',
          undefined,
          { signal: controller.signal },
        ),
      ).rejects.toThrow();

      expect(fm.recordList).toHaveLength(recordsBefore);
      expect(fm.recordList.some((fr) => fr.path.startsWith('aborted-'))).toBe(false);

      expect((fm as any).store.getManifestCache(di.topic)).toBeUndefined();

      expect(fm.driveList[1].manifestRef).toEqual(manifestRefBefore);
    });

    it('saves the batch normally when the signal never fires', async () => {
      const fm = await sequentialFm();
      const di = fm.driveList[1];

      const controller = new AbortController();
      const saveManifestSpy = jest.spyOn((fm as any).store, 'saveMantarayNode');

      const result = await fm.uploadFiles(
        di.id,
        [{ path: 'clean.txt', ...makeUploadSource('package.json') }],
        '',
        undefined,
        { signal: controller.signal },
      );

      expect(result.failed).toHaveLength(0);
      expect(result.succeeded.map((r) => r.path)).toEqual(['clean.txt']);
      expect(saveManifestSpy).toHaveBeenCalledTimes(1);
      const finalizeOptions = saveManifestSpy.mock.calls[0][2] as BeeRequestOptions | undefined;
      expect(finalizeOptions?.signal).toBe(controller.signal);

      const driveMantaray = (fm as any).store.getManifestCache(di.topic) as MantarayNode;
      expect(driveMantaray.find('clean.txt')).toBeTruthy();
    });
  });

  // The suppression guard in walkFolder's failure handlers is `signal?.aborted`, one slipped word
  // away from `signal`, which would drop every NodeFailure whenever a signal is passed at all — and
  // callers pass one on essentially every listing. An aborted walk cannot be asserted from the other
  // side: it rejects via throwIfAborted, so no ListFolderResult is ever produced.
  it('reports node failures normally when a signal is present but never aborted', async () => {
    const fm = await createInitializedFileManager();
    const drive = fm.driveList[0];

    const badTopic = Topic.fromString('abort-live-signal-bad').toString();

    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { loadMantaray, getAllNodeEntries } = require('@/utils/mantaray');
    loadMantaray.mockResolvedValue(new MantarayNode());
    getAllNodeEntries.mockReturnValue([{ path: 'bad.txt', type: NodeType.File, topic: badTopic, rawMetadata: {} }]);

    (getFeedData as jest.Mock).mockRejectedValue(new Error('feed unreachable'));

    const controller = new AbortController();
    const { entries, failed } = await fm.listFolder(drive.id, '', ListDepth.Shallow, undefined, {
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(false);
    expect(entries).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ path: 'bad.txt', scope: FailureScope.Entry, topic: badTopic });
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
      name: 'a.txt',
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
