import {
  BatchId,
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  RedundantUploadOptions,
  UploadResult,
} from '@ethersphere/bee-js';

import { BrowserUploadOptions, DriveInfo, FileInfoOptions } from '../types';
import { ReferenceWithHistory, WrappedUploadResult } from '../types/utils';

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

export async function processUploadBrowser(
  bee: Bee,
  driveInfo: DriveInfo,
  fileOptions: FileInfoOptions,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
  uploadOptions = { ...uploadOptions, redundancyLevel: driveInfo.redundancyLevel };

  if (fileOptions.file) {
    return {
      reference: fileOptions.file.reference.toString(),
      historyRef: fileOptions.file.historyRef.toString(),
    } as ReferenceWithHistory;
  }

  const batchId = driveInfo.batchId;

  const browserOptions: BrowserUploadOptions = fileOptions as BrowserUploadOptions;

  if (!browserOptions.files) {
    throw new Error('Files are required.');
  }

  const uploadResult = await uploadBrowser(
    bee,
    batchId,
    browserOptions,
    uploadOptions as RedundantUploadOptions,
    requestOptions,
  );

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ReferenceWithHistory;
}
