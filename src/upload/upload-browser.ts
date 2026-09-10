import type { BeeRequestOptions } from '@ethersphere/bee-js';

import type { SwarmClient } from '../types';
import { type DriveInfo } from '../types/info';
import { type BrowserUploadOptions } from '../types/upload';
import { type ContentRef, type SwarmUploadOptions } from '../types/utils';

export async function processUploadBrowser(
  swarmClient: SwarmClient,
  driveInfo: DriveInfo,
  browserOptions: BrowserUploadOptions,
  options: SwarmUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ContentRef> {
  const result = await swarmClient.uploadData(driveInfo.batchId, browserOptions.file, options, requestOptions);

  if (result.tagUid !== undefined) {
    browserOptions.onUploadProgress?.(result.tagUid);
  }

  return { reference: result.reference.toString() };
}
