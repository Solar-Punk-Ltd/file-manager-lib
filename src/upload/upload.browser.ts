import { BatchId, Bee, BeeRequestOptions, RedundantUploadOptions, UploadResult } from '@ethersphere/bee-js';
import { BrowserUploadOptions, WrappedUploadResult } from '../utils/types';

export async function uploadBrowser(
  bee: Bee,
  batchId: string | BatchId,
  browserOptions: BrowserUploadOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const streamFilesOpts = uploadOptions ? { ...uploadOptions, act: false, actHistoryAddress: undefined } : undefined;

  const uploadFilesRes = await bee.streamFiles(
    batchId,
    browserOptions.files,
    browserOptions.onUploadProgress,
    streamFilesOpts,
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (browserOptions.preview) {
    uploadPreviewRes = await bee.streamFiles(
      batchId,
      [browserOptions.preview],
      browserOptions.onUploadProgress,
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
