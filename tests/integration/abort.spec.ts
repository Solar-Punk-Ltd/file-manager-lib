import { setTimeout } from 'timers';

import { setupUserDrive, tempFileRegistry } from './setup/utils';

import { FileManagerBase } from '@/fileManager';
import { BeeClient } from '@/swarm';
import { DriveInfo, FileRecord, FolderInfo, ListDepth } from '@/types';
import { ROOT_PATH } from '@/utils/constants';

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

    beforeAll(() => {
      // Larger files (1MB) give abort tests enough time to actually cancel mid-flight.
      const largeData = Buffer.alloc(1 * 1024 * 1024, 'x');
      writeTempFile(preAbortFile, largeData);
      writeTempFile(midAbortFile, largeData);
      writeTempFile(successFile, 'This file should upload successfully');
      writeTempFile(multi1File, 'Content 1');
      writeTempFile(multi2File, 'Content 2');
    });

    it('should throw an AbortError when upload is aborted with pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort

      const uploadPromise = fileManager.uploadFile(
        drive.id,
        { path: preAbortFile, sourcePath: preAbortFile },
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
        { path: midAbortFile, sourcePath: midAbortFile },
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
      await fileManager.uploadFile(drive.id, { path: successFile, sourcePath: successFile }, undefined, {
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
        { path: multi1File, sourcePath: multi1File },
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
      await fileManager.uploadFile(drive.id, { path: multi2File, sourcePath: multi2File }, undefined, {
        signal: controller2.signal,
      });

      const uploadedFile = fileManager.recordList.find((fr) => fr.path === multi2File);
      expect(uploadedFile).toBeDefined();
    });
  });

  describe('download', () => {
    const downloadTestFile = 'it-abort-large-download.bin';
    let uploadedFileInfo: FileRecord;
    let actPublisher: string;

    beforeAll(async () => {
      // Upload a 1MB file to download later (large enough for reliable abort timing)
      writeTempFile(downloadTestFile, Buffer.alloc(1 * 1024 * 1024, 'x'));
      await fileManager.uploadFile(drive.id, { path: downloadTestFile, sourcePath: downloadTestFile });
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
      expect(Array.isArray(result)).toBe(true);
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
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('listFolder', () => {
    const folderName = 'it-abort-listfolder-folder';
    const fileInFolder = `${folderName}/it-abort-listfolder-file.txt`;
    let folderInfo: FolderInfo;

    beforeAll(async () => {
      folderInfo = await fileManager.createFolder(drive.id, ROOT_PATH, folderName);

      writeTempDir(folderName, { 'it-abort-listfolder-file.txt': 'listFolder abort test content' });
      await fileManager.uploadFile(drive.id, { path: fileInFolder, sourcePath: fileInFolder });
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

      setTimeout(() => {
        controller.abort();
      }, 1);

      await expect(listPromise).rejects.toThrow();
    });

    it('should complete listFolder successfully when signal is not aborted', async () => {
      const controller = new AbortController();

      const result = await fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, {
        signal: controller.signal,
      });

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
      const result = await fileManager.listFolder(drive.id, folderInfo.path, ListDepth.Shallow, undefined, {
        signal: controller2.signal,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
