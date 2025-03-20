import { BatchId, Bee, BeeRequestOptions, UploadOptions } from '@ethersphere/bee-js';

import { FileManagerUploadOptions, ReferenceWithHistory, UploadProgress } from '../utils/types';
import { FileInfoError } from '../utils/errors';
import { UploadResult } from '../utils/types';

export async function uploadBrowser(
  bee: Bee,
  options: FileManagerUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (!options.files) {
    throw new FileInfoError('Files option has to be provided.');
  }

  const uploadFilesRes = await streamFiles(
    bee,
    options.batchId,
    options.files,
    options.onUploadProgress,
    { act: true },
    requestOptions,
  );
  let uploadPreviewRes: ReferenceWithHistory | undefined;
  if (options.preview) {
    uploadPreviewRes = await streamFiles(
      bee,
      options.batchId,
      [options.preview],
      options.onUploadProgress,
      { act: true },
      requestOptions,
    );
  }

  return { uploadFilesRes, uploadPreviewRes };
}

async function streamFiles(
  bee: Bee,
  batchId: BatchId,
  files: File[] | FileList,
  onUploadProgress?: (progress: UploadProgress) => void,
  uploadOptions?: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
  const reuslt = await bee.streamFiles(batchId, files, onUploadProgress, uploadOptions, requestOptions);

  return {
    reference: reuslt.reference.toString(),
    historyRef: reuslt.historyAddress.getOrThrow().toString(),
  };
}
