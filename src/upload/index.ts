import type {
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import type { DriveInfo, FileInfoOptions } from '../types';
import type { ReferenceWithHistory } from '../types/utils';

import { processUploadBrowser } from './upload.browser';

export async function processUpload(
  bee: Bee,
  driveInfo: DriveInfo,
  fileOptions: FileInfoOptions,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
  if (isNode) {
    const { processUploadNode } = await import('./upload.node');
    return processUploadNode(bee, driveInfo, fileOptions, uploadOptions, requestOptions);
  }

  return processUploadBrowser(bee, driveInfo, fileOptions, uploadOptions, requestOptions);
}
