/* eslint-env browser */
/* global File, FileList, DataTransfer */
import { BatchId } from '@ethersphere/bee-js';

import {
  createInitializedFileManager,
  createInitMocks,
  createMockFeedWriter,
  createStreamFilesSpy,
  createUploadDataSpy,
  createUploadFileSpy,
  MOCK_BATCH_ID,
} from '../mockHelpers';

// Helper to create a FileList from an array of File objects.
function createFileList(files: File[]): FileList {
  const dataTransfer = new DataTransfer();
  files.forEach((file) => dataTransfer.items.add(file));
  return dataTransfer.files;
}

describe('upload (Browser)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should call streamFiles', async () => {
    createInitMocks();
    const fm = await createInitializedFileManager(true);
    const streamFilesSpy = createStreamFilesSpy('1');
    createUploadFileSpy('2');
    createUploadDataSpy('3');
    createUploadDataSpy('4');
    createMockFeedWriter('5');

    // Create a fake FileList
    const fileA = new File(['Content A'], 'a.txt', { type: 'text/plain' });
    const fileB = new File(['Content B'], 'b.txt', { type: 'text/plain' });
    const files = createFileList([fileA, fileB]);

    // Call the upload method (note: second parameter is File[] or FileList, third is name)
    await fm.upload(new BatchId(MOCK_BATCH_ID), files, 'tests');

    expect(streamFilesSpy).toHaveBeenCalled();
  });

  it('should call streamFiles for preview if preview file is provided', async () => {
    createInitMocks();
    const fm = await createInitializedFileManager(true);
    const streamFilesSpy = createStreamFilesSpy('1');
    const streamFilesPreviewSpy = createStreamFilesSpy('6');
    createUploadFileSpy('2');
    createUploadDataSpy('3');
    createUploadDataSpy('4');
    createMockFeedWriter('5');

    const fileA = new File(['Content A'], 'a.txt', { type: 'text/plain' });
    const fileList = createFileList([fileA]);
    const previewFile = new File(['Preview'], 'preview.txt', { type: 'text/plain' });

    await fm.upload(
      new BatchId(MOCK_BATCH_ID),
      fileList,
      'tests',
      undefined,
      undefined,
      undefined,
      undefined,
      previewFile,
    );

    expect(streamFilesSpy).toHaveBeenCalled();
    expect(streamFilesPreviewSpy).toHaveBeenCalled();
  });

  it('should throw error if infoTopic and historyRef are not provided at the same time', async () => {
    createInitMocks();
    const fm = await createInitializedFileManager(true);

    await expect(async () => {
      await fm.upload(
        new BatchId(MOCK_BATCH_ID),
        createFileList([]),
        'tests',
        undefined,
        undefined,
        'infoTopic',
        undefined,
      );
    }).rejects.toThrow('infoTopic and historyRef have to be provided at the same time.');
  });
});
