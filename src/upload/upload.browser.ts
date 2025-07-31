import { Bee, BeeRequestOptions, RedundantUploadOptions, UploadResult } from '@ethersphere/bee-js';

import { FileInfoOptions, WrappedUploadResult } from '../utils/types';
import { FileInfoError } from '../utils/errors';

export async function uploadBrowser(
  bee: Bee,
  infoOptions: FileInfoOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (!infoOptions.files) {
    throw new FileInfoError('Files option has to be provided.');
  }

  const uploadFilesRes = await bee.streamFiles(
    infoOptions.info.batchId,
    infoOptions.files,
    infoOptions.onUploadProgress,
    { ...uploadOptions, act: false },
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (infoOptions.preview) {
    uploadPreviewRes = await bee.streamFiles(
      infoOptions.info.batchId,
      [infoOptions.preview],
      infoOptions.onUploadProgress,
      { ...uploadOptions, act: false },
      requestOptions,
    );
  }

  const wrappedData: WrappedUploadResult = {
    uploadFilesRes: uploadFilesRes.reference.toString(),
    uploadPreviewRes: uploadPreviewRes?.reference.toString(),
  };

  return await bee.uploadData(
    infoOptions.info.batchId,
    JSON.stringify(wrappedData),
    { ...uploadOptions, act: true },
    requestOptions,
  );
}
