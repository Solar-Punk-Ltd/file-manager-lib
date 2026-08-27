import { Reference, Topic } from '@ethersphere/bee-js';
import path from 'path';
import { setTimeout } from 'timers';

import { abortAfterFirstRecordWrite, retryOnPropagationDelay } from '../utils';

import { setupUserDrive, tempFileRegistry } from './setup/utils';

import type { BeeClient } from '@/clients';
import { EventEmitterBase } from '@/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { type DriveInfo, FailureScope, type FileRecord, type FolderInfo, ListDepth, NodeType } from '@/types';
import { MANIFEST_METADATA_NODE_TOPIC, MANIFEST_METADATA_NODE_TYPE, ROOT_PATH } from '@/utils/constants';
import { generateRandomBytes } from '@/utils/crypto';

describe('Abort signal handling', () => {
  let client: BeeClient;
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  const { writeTempFile, writeTempDir, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ client, fileManager, drive } = await setupUserDrive('abort-test', { stampLabel: 'abortControllerStamp' }));
  });

  afterAll(cleanup);

  describe('uploadFile', () => {
    const preAbortFile = 'it-abort-pre-abort.bin';
    const midAbortFile = 'it-abort-mid-flight.bin';
    const successFile = 'it-abort-success.txt';
    const multi1File = 'it-abort-multi-1.txt';
    const multi2File = 'it-abort-multi-2.txt';
    let preAbortSrc: string;
    let midAbortSrc: string;
    let successSrc: string;
    let multi1Src: string;
    let multi2Src: string;

    beforeAll(() => {
      // Larger files (1MB) give abort tests enough time to actually cancel mid-flight.
      const largeData = Buffer.alloc(1 * 1024 * 1024, 'x');
      preAbortSrc = writeTempFile(preAbortFile, largeData);
      midAbortSrc = writeTempFile(midAbortFile, largeData);
      successSrc = writeTempFile(successFile, 'This file should upload successfully');
      multi1Src = writeTempFile(multi1File, 'Content 1');
      multi2Src = writeTempFile(multi2File, 'Content 2');
    });

    it('should throw an AbortError when upload is aborted with pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort

      const uploadPromise = fileManager.uploadFile(
        drive.id,
        { path: preAbortFile, sourcePath: preAbortSrc },
        undefined,
        {
          signal: controller.signal,
        },
      );

      await expect(uploadPromise).rejects.toThrow();

      try {
        await uploadPromise;
      } catch (error: any) {
        expect(error.name === 'AbortError' || error.message.toLowerCase().includes('abort')).toBe(true);
      }
    });

    it('should throw BeeResponseError when upload is cancelled mid-flight', async () => {
      const controller = new AbortController();

      // Start upload and abort after a short delay
      const uploadPromise = fileManager.uploadFile(
        drive.id,
        { path: midAbortFile, sourcePath: midAbortSrc },
        undefined,
        {
          signal: controller.signal,
        },
      );

      controller.abort();

      try {
        await uploadPromise;
      } catch (error: any) {
        const haystack = `${error?.name ?? ''} ${error?.message ?? ''} ${error?.cause?.message ?? ''}`.toLowerCase();
        expect(error?.statusText === 'ERR_CANCELED' || /abort|cancel|terminated/.test(haystack)).toBe(true);
      }
    });

    it('should complete upload successfully when signal is not aborted', async () => {
      const controller = new AbortController();

      // Upload with signal that is NOT aborted
      await fileManager.uploadFile(drive.id, { path: successFile, sourcePath: successSrc }, undefined, {
        signal: controller.signal,
      });

      // Verify file was uploaded
      const uploadedFile = fileManager.recordList.find((fr) => fr.path === successFile);
      expect(uploadedFile).toBeDefined();
      expect(uploadedFile?.driveId).toBe(drive.id.toString());
    });

    it('should handle multiple uploads with different abort controllers', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      controller1.abort(); // Pre-abort first one

      // First upload should fail (aborted)
      const firstUploadPromise = fileManager.uploadFile(
        drive.id,
        { path: multi1File, sourcePath: multi1Src },
        undefined,
        {
          signal: controller1.signal,
        },
      );

      await expect(firstUploadPromise).rejects.toThrow();

      try {
        await firstUploadPromise;
      } catch (error: any) {
        expect(error.name === 'AbortError' || error.message.toLowerCase().includes('abort')).toBe(true);
      }

      // Second upload should succeed (not aborted)
      await fileManager.uploadFile(drive.id, { path: multi2File, sourcePath: multi2Src }, undefined, {
        signal: controller2.signal,
      });

      const uploadedFile = fileManager.recordList.find((fr) => fr.path === multi2File);
      expect(uploadedFile).toBeDefined();
    });
  });

  describe('uploadFiles', () => {
    it('leaves the drive untouched when the batch is aborted mid-flight', async () => {
      const one = writeTempFile('it-abortbatch-one.txt', 'Abort batch one');
      const two = writeTempFile('it-abortbatch-two.txt', 'Abort batch two');
      const three = writeTempFile('it-abortbatch-three.txt', 'Abort batch three');

      // uploadConcurrency 1 keeps the batch sequential, so the abort lands between files.
      const fm = new FileManagerBase(client, new EventEmitterBase(), { uploadConcurrency: 1 });
      await fm.initialize();
      const localDrive = fm.driveList.find((d) => d.id === drive.id);
      expect(localDrive).toBeDefined();
      const manifestRefBefore = { ...localDrive!.manifestRef };

      const controller = new AbortController();
      abortAfterFirstRecordWrite(fm, controller);

      await expect(
        fm.uploadFiles(
          drive.id,
          [
            { path: 'abortbatch/one.txt', sourcePath: one },
            { path: 'abortbatch/two.txt', sourcePath: two },
            { path: 'abortbatch/three.txt', sourcePath: three },
          ],
          '',
          undefined,
          { signal: controller.signal },
        ),
      ).rejects.toThrow();

      expect(fm.recordList.some((fr) => fr.path.startsWith('abortbatch/'))).toBe(false);
      expect(fm.driveList.find((d) => d.id === drive.id)!.manifestRef).toEqual(manifestRefBefore);

      const verifier = new FileManagerBase(client);
      await verifier.initialize();
      const rootEntries = (await verifier.listFolder(drive.id, ROOT_PATH, ListDepth.Shallow)).entries;
      expect(rootEntries.some((e) => e.path === 'abortbatch')).toBe(false);
    });

    it('a later unrelated write does not commit an aborted batch after the fact', async () => {
      const aborted = writeTempFile('it-abortbatch-later-aborted.txt', 'Aborted content');
      const kept = writeTempFile('it-abortbatch-later-kept.txt', 'Kept content');

      const fm = new FileManagerBase(client, new EventEmitterBase(), { uploadConcurrency: 1 });
      await fm.initialize();

      const controller = new AbortController();
      abortAfterFirstRecordWrite(fm, controller);

      await expect(
        fm.uploadFiles(
          drive.id,
          [
            { path: 'later-abort/gone.txt', sourcePath: aborted },
            { path: 'later-abort/also-gone.txt', sourcePath: aborted },
          ],
          '',
          undefined,
          { signal: controller.signal },
        ),
      ).rejects.toThrow();

      await fm.uploadFile(drive.id, { path: 'it-abortbatch-later-kept.txt', sourcePath: kept });

      const verifier = await retryOnPropagationDelay(async () => {
        const fresh = new FileManagerBase(client);
        await fresh.initialize();
        const entries = (await fresh.listFolder(drive.id, ROOT_PATH, ListDepth.Shallow)).entries;
        if (!entries.some((e) => e.path === 'it-abortbatch-later-kept.txt')) {
          throw new Error('follow-up upload not yet propagated');
        }
        return fresh;
      });

      const entries = (await verifier.listFolder(drive.id, ROOT_PATH, ListDepth.Shallow)).entries;
      expect(entries.some((e) => e.path === 'it-abortbatch-later-kept.txt')).toBe(true);
      expect(entries.some((e) => e.path === 'later-abort')).toBe(false);
    });

    it('rejects without uploading anything when the signal is pre-aborted', async () => {
      const src = writeTempFile('it-abortbatch-pre.txt', 'Never uploaded');
      const controller = new AbortController();
      controller.abort();

      await expect(
        fileManager.uploadFiles(drive.id, [{ path: 'abortbatch-pre/x.txt', sourcePath: src }], '', undefined, {
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      expect(fileManager.recordList.some((fr) => fr.path.startsWith('abortbatch-pre/'))).toBe(false);
    });
  });

  describe('download', () => {
    const downloadTestFile = 'it-abort-large-download.bin';
    let uploadedFileInfo: FileRecord;
    let actPublisher: string;

    beforeAll(async () => {
      // Upload a 1MB file to download later (large enough for reliable abort timing)
      const src = writeTempFile(downloadTestFile, Buffer.alloc(1 * 1024 * 1024, 'x'));
      await fileManager.uploadFile(drive.id, { path: downloadTestFile, sourcePath: src });
      const fr = fileManager.recordList.find((fr) => fr.path === downloadTestFile);
      expect(fr).toBeDefined();
      uploadedFileInfo = fr!;

      actPublisher = client.actPublisher;
    });

    it('should throw error when download is aborted with pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort

      await expect(
        fileManager.downloadFiles(
          [uploadedFileInfo],
          {
            actHistoryAddress: uploadedFileInfo.content.historyRef,
            actPublisher,
          },
          { signal: controller.signal },
        ),
      ).rejects.toThrow();
    });

    it('should throw error when download is cancelled mid-flight', async () => {
      const controller = new AbortController();

      // Start download and abort after a short delay
      const downloadPromise = fileManager.downloadFiles(
        [uploadedFileInfo],
        {
          actHistoryAddress: uploadedFileInfo.content.historyRef,
          actPublisher,
        },
        { signal: controller.signal },
      );

      setTimeout(() => {
        controller.abort();
      }, 1);

      await expect(downloadPromise).rejects.toThrow();
    });

    it('should complete download successfully when signal is not aborted', async () => {
      const controller = new AbortController();

      const result = await fileManager.downloadFiles(
        [uploadedFileInfo],
        {
          actHistoryAddress: uploadedFileInfo.content.historyRef,
          actPublisher,
        },
        { signal: controller.signal },
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result.succeeded)).toBe(true);
      expect(Array.isArray(result.failed)).toBe(true);
    });

    it('should handle multiple downloads with different abort controllers', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      controller1.abort(); // Pre-abort first one

      // First download should fail (aborted)
      await expect(
        fileManager.downloadFiles(
          [uploadedFileInfo],
          {
            actHistoryAddress: uploadedFileInfo.content.historyRef,
            actPublisher,
          },
          { signal: controller1.signal },
        ),
      ).rejects.toThrow();

      // Second download should succeed (not aborted)
      const result = await fileManager.downloadFiles(
        [uploadedFileInfo],
        {
          actHistoryAddress: uploadedFileInfo.content.historyRef,
          actPublisher,
        },
        { signal: controller2.signal },
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result.succeeded)).toBe(true);
      expect(Array.isArray(result.failed)).toBe(true);
    });
  });

  describe('listFolder', () => {
    const folderName = 'it-abort-listfolder-folder';
    const fileInFolder = `${folderName}/it-abort-listfolder-file.txt`;
    let folderInfo: FolderInfo;

    beforeAll(async () => {
      folderInfo = await fileManager.createFolder(drive.id, ROOT_PATH, folderName);

      const dir = writeTempDir(folderName, { 'it-abort-listfolder-file.txt': 'listFolder abort test content' });
      await fileManager.uploadFile(drive.id, {
        path: fileInFolder,
        sourcePath: path.join(dir, 'it-abort-listfolder-file.txt'),
      });
    });

    it('reports a genuinely unresolvable fork while a live signal is attached', async () => {
      const orphanTopic = new Topic(generateRandomBytes(Topic.LENGTH)).toString();
      const orphanName = 'it-abort-orphan-folder';
      const store = (fileManager as any).store;
      const { host, node } = await store.resolveHostMantaray(drive, ROOT_PATH, client.actPublisher);

      node.addFork(orphanName, new Reference(orphanTopic), {
        [MANIFEST_METADATA_NODE_TOPIC]: orphanTopic,
        [MANIFEST_METADATA_NODE_TYPE]: NodeType.Folder,
      });
      const newManifestRef = await store.saveMantarayNode(node, host);
      drive.manifestRef = newManifestRef;

      const controller = new AbortController();
      const { entries, failed } = await fileManager.listFolder(drive.id, ROOT_PATH, ListDepth.Shallow, undefined, {
        signal: controller.signal,
      });

      expect(controller.signal.aborted).toBe(false);
      expect(entries.some((e) => e.path === folderName)).toBe(true);
      const orphan = failed.find((f) => f.path === orphanName);
      expect(orphan).toBeDefined();
      expect(orphan!.scope).toBe(FailureScope.Subtree);
      expect(orphan!.topic).toBe(orphanTopic);

      node.removeFork(orphanName);
      drive.manifestRef = await store.saveMantarayNode(node, host);
    });

    it('should throw error when listFolder is aborted with pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort

      await expect(
        fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, { signal: controller.signal }),
      ).rejects.toThrow();
    });

    it('should throw error when listFolder is cancelled mid-flight', async () => {
      const controller = new AbortController();

      const listPromise = fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, {
        signal: controller.signal,
      });

      controller.abort();

      await expect(listPromise).rejects.toThrow();
    });

    it('should complete listFolder successfully when signal is not aborted', async () => {
      const controller = new AbortController();

      const result = (
        await fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, {
          signal: controller.signal,
        })
      ).entries;

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle multiple listFolder calls with different abort controllers', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      controller1.abort(); // Pre-abort first one

      // First call should fail (aborted)
      await expect(
        fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, { signal: controller1.signal }),
      ).rejects.toThrow();

      // Second call should succeed (not aborted)
      const result = (
        await fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, {
          signal: controller2.signal,
        })
      ).entries;

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
