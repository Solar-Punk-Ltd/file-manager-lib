import { BeeRequestOptions, RedundantUploadOptions, Reference, UploadResult } from '@ethersphere/bee-js';
import { Optional } from 'cafe-utility';

import { DriveInfo } from '../types/info';
import { SwarmClient } from '../types/swarmClient';
import { BrowserUploadOptions } from '../types/upload';
import { ActReferences } from '../types/utils';
import { FileError } from '../utils/errors';

async function uploadBrowser(
  swarmClient: SwarmClient,
  batchId: string,
  browserOptions: BrowserUploadOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const result = await swarmClient.uploadProtected(
    batchId,
    browserOptions.file,
    uploadOptions?.actHistoryAddress?.toString(),
    uploadOptions,
    requestOptions,
  );

  if (result.tagUid !== undefined) {
    browserOptions.onUploadProgress?.(result.tagUid);
  }

  return {
    reference: new Reference(result.contentRefs.reference),
    historyAddress: Optional.of(new Reference(result.contentRefs.historyRef)),
    tagUid: result.tagUid,
  };
}

export async function processUploadBrowser(
  swarmClient: SwarmClient,
  driveInfo: DriveInfo,
  browserOptions: BrowserUploadOptions,
  uploadOptions?: RedundantUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ActReferences> {
  if (!browserOptions.file) {
    throw new FileError('File is required.');
  }

  const uploadResult = await uploadBrowser(
    swarmClient,
    driveInfo.batchId,
    browserOptions,
    uploadOptions,
    requestOptions,
  );

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ActReferences;
}
