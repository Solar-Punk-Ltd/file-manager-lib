import { BatchId, Bee, BeeRequestOptions, RedundantUploadOptions, UploadResult } from '@ethersphere/bee-js';

import { BrowserUploadOptions, DriveInfo } from '../types';
import { ActReferences } from '../types/utils';
import { FileError } from '../utils/errors';

async function uploadBrowser(
  bee: Bee,
  batchId: string | BatchId,
  browserOptions: BrowserUploadOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const result = await bee.uploadData(batchId, browserOptions.file, uploadOptions, requestOptions);

  if (result.tagUid !== undefined) {
    browserOptions.onUploadProgress?.(result.tagUid);
  }

  return result;
}

export async function processUploadBrowser(
  bee: Bee,
  driveInfo: DriveInfo,
  browserOptions: BrowserUploadOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ActReferences> {
  if (!browserOptions.file) {
    throw new FileError('File is required.');
  }

  const uploadResult = await uploadBrowser(bee, driveInfo.batchId, browserOptions, uploadOptions, requestOptions);

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ActReferences;
}
