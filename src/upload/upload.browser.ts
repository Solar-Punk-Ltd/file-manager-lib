import { BatchId, Bee, BeeRequestOptions, UploadOptions, UploadResult } from '@ethersphere/bee-js';

import { FileManagerUploadOptions, UploadProgress /*, UploadResult*/, WrappedUploadResult } from '../utils/types';
import { FileInfoError } from '../utils/errors';

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
    { act: false },
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (options.preview) {
    uploadPreviewRes = await streamFiles(
      bee,
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
  const wrappedUploadRes = await bee.uploadData(
    options.batchId,
    JSON.stringify(wrappedData),
    { act: true },
    {
      ...requestOptions,
    },
  );

  return wrappedUploadRes;
}

async function streamFiles(
  bee: Bee,
  batchId: BatchId,
  files: File[] | FileList,
  onUploadProgress?: (progress: UploadProgress) => void,
  uploadOptions?: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const reuslt = await bee.streamFiles(batchId, files, onUploadProgress, uploadOptions, requestOptions);

  // return {
  //   reference: reuslt.reference.toString(),
  //   historyRef: reuslt.historyAddress.getOrThrow().toString(),
  // };
  return reuslt;
}
