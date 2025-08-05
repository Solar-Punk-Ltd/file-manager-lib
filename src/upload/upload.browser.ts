import { Bee, BeeRequestOptions, RedundantUploadOptions, UploadResult } from '@ethersphere/bee-js';

import { FileInfoOptions, WrappedUploadResult } from '../utils/types';
import { FileInfoError } from '../utils/errors';

export async function uploadBrowser(
  bee: Bee,
  fileOptions: FileInfoOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (!fileOptions.files) {
    throw new FileInfoError('Files option has to be provided.');
  }

  const uploadFilesRes = await bee.streamFiles(
    fileOptions.batchId,
    fileOptions.files,
    fileOptions.onUploadProgress,
    { ...uploadOptions, act: false },
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (fileOptions.preview) {
    uploadPreviewRes = await bee.streamFiles(
      fileOptions.batchId,
      [fileOptions.preview],
      fileOptions.onUploadProgress,
      { ...uploadOptions, act: false },
      requestOptions,
    );
  }

  const wrappedData: WrappedUploadResult = {
    uploadFilesRes: uploadFilesRes.reference.toString(),
    uploadPreviewRes: uploadPreviewRes?.reference.toString(),
  };

  return await bee.uploadData(
    fileOptions.batchId,
    JSON.stringify(wrappedData),
    { ...uploadOptions, act: true },
    requestOptions,
  );
}
