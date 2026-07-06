import { BatchId, Bee, BeeRequestOptions, RedundantUploadOptions, UploadResult } from '@ethersphere/bee-js';

import { BrowserUploadOptions, DriveInfo } from '../types';
import { ReferenceWithHistory } from '../types/utils';

// Do not call streamFiles with act: true because it would encrypt all the chunks recursively, that is unnecessary
// Wrap the uplodResult instead and encrypt that reference at the root level
export async function uploadBrowser(
  bee: Bee,
  batchId: string | BatchId,
  browserOptions: BrowserUploadOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const streamFilesOpts = uploadOptions ? { ...uploadOptions, act: false, actHistoryAddress: undefined } : undefined;

  const uploadResult = await bee.streamFiles(
    batchId,
    browserOptions.files,
    browserOptions.onUploadProgress,
    streamFilesOpts,
    requestOptions,
  );

  return await bee.uploadData(
    batchId,
    uploadResult.reference.toUint8Array(),
    { ...uploadOptions, act: true },
    requestOptions,
  );
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
