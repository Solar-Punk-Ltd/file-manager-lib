import { BatchId, Bee, BeeRequestOptions, RedundantUploadOptions, UploadResult } from '@ethersphere/bee-js';

import { BrowserUploadOptions, DriveInfo } from '../types';
import { ReferenceWithHistory, WrappedUploadResult } from '../types/utils';

export async function uploadBrowser(
  bee: Bee,
  batchId: string | BatchId,
  browserOptions: BrowserUploadOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const streamFilesOpts = uploadOptions ? { ...uploadOptions, act: false, actHistoryAddress: undefined } : undefined;

  const fileMetadata = browserOptions.fileMetadata;
  const fileOptionsProvider: ((file: File) => Record<string, string>) | undefined = fileMetadata
    ? (file: File): Record<string, string> => fileMetadata.get(file.webkitRelativePath || file.name) ?? {}
    : undefined;

  const uploadFilesRes = await bee.streamFiles(
    batchId,
    browserOptions.files,
    browserOptions.onUploadProgress,
    fileOptionsProvider,
    streamFilesOpts,
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (browserOptions.preview) {
    uploadPreviewRes = await bee.streamFiles(
      batchId,
      [browserOptions.preview],
      browserOptions.onUploadProgress,
      fileOptionsProvider,
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

export async function processUploadBrowser(
  bee: Bee,
  driveInfo: DriveInfo,
  browserOptions: BrowserUploadOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
  if (!browserOptions.files) {
    throw new Error('Files are required.');
  }

  const uploadResult = await uploadBrowser(bee, driveInfo.batchId, browserOptions, uploadOptions, requestOptions);

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ReferenceWithHistory;
}
