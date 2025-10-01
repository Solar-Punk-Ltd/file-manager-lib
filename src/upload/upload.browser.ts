import { BatchId, Bee, BeeRequestOptions, RedundantUploadOptions, UploadResult } from '@ethersphere/bee-js';
import { FileInfoOptions, WrappedUploadResult } from '../utils/types';
import { FileInfoError } from '../utils/errors';

export async function uploadBrowser(
  bee: Bee,
  batchId: string | BatchId,
  fileOptions: FileInfoOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (!fileOptions.files) {
    throw new FileInfoError('Files option has to be provided.');
  }

  const streamFilesOpts = uploadOptions
    ? { ...uploadOptions, act: false, actHistoryAddress: undefined }
    : undefined;

  const uploadFilesRes = await bee.streamFiles(
    batchId,
    fileOptions.files,
    fileOptions.onUploadProgress,
    streamFilesOpts,
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (fileOptions.preview) {
    uploadPreviewRes = await bee.streamFiles(
      batchId,
      [fileOptions.preview],
      fileOptions.onUploadProgress,
      streamFilesOpts,
      requestOptions,
    );
  }

  const wrappedData: WrappedUploadResult = {
    uploadFilesRes: uploadFilesRes.reference.toString(),
    uploadPreviewRes: uploadPreviewRes?.reference.toString(),
  };

  return await bee.uploadData(batchId, JSON.stringify(wrappedData), { ...uploadOptions, act: true }, requestOptions);
}
