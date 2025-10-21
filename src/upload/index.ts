import {
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  RedundantUploadOptions,
  UploadResult,
} from '@ethersphere/bee-js';
import { DriveInfo, FileInfoOptions, BrowserUploadOptions, NodeUploadOptions } from '../utils';
import { ReferenceWithHistory } from '../utils/types';
import { isNode } from 'std-env';
import { uploadNode } from './upload.node';
import { uploadBrowser } from './upload.browser';
import { FileInfoError } from '../utils/errors';

export async function processUpload(
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
  let uploadResult: UploadResult;

  if (isNode) {
    const nodeOptions: NodeUploadOptions = fileOptions as NodeUploadOptions;

    if (!nodeOptions.path) {
      throw new FileInfoError('File path is required.');
    }

    uploadResult = await uploadNode(bee, batchId, nodeOptions, uploadOptions, requestOptions);
  } else {
    const browserOptions: BrowserUploadOptions = fileOptions as BrowserUploadOptions;

    if (!browserOptions.files) {
      throw new FileInfoError('Files are required.');
    }

    uploadResult = await uploadBrowser(
      bee,
      batchId,
      browserOptions,
      uploadOptions as RedundantUploadOptions,
      requestOptions,
    );
  }

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ReferenceWithHistory;
}
