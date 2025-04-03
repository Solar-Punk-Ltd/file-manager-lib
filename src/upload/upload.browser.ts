import { Bee, BeeRequestOptions, UploadResult } from '@ethersphere/bee-js';

import { FileManagerUploadOptions, WrappedUploadResult } from '../utils/types';
import { FileInfoError } from '../utils/errors';

export async function uploadBrowser(
  bee: Bee,
  options: FileManagerUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (!options.files) {
    throw new FileInfoError('Files option has to be provided.');
  }

  const uploadFilesRes = await bee.streamFiles(
    options.batchId,
    options.files,
    options.onUploadProgress,
    { act: false },
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (options.preview) {
    uploadPreviewRes = await bee.streamFiles(
      options.batchId,
      [options.preview],
      options.onUploadProgress,
      { act: false },
      requestOptions,
    );
  }

  const wrappedData: WrappedUploadResult = {
    uploadFilesRes: uploadFilesRes.reference.toString(),
    uploadPreviewRes: uploadPreviewRes?.reference.toString(),
  };

  return await bee.uploadData(
    options.batchId,
    JSON.stringify(wrappedData),
    { act: true },
    {
      ...requestOptions,
    },
  );
}
