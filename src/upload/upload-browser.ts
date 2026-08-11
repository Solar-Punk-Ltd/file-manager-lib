import {
  type BatchId,
  type Bee,
  type BeeRequestOptions,
  type RedundantUploadOptions,
  type UploadResult,
} from '@ethersphere/bee-js';

import { type DriveInfo } from '../types/info';
import { type BrowserUploadOptions } from '../types/upload';
import { type ActReferences } from '../types/utils';

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
  const uploadResult = await uploadBrowser(bee, driveInfo.batchId, browserOptions, uploadOptions, requestOptions);

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ActReferences;
}
