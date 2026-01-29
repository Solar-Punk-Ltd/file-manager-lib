import { isNode } from 'std-env';
import type {
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import type { DriveInfo, FileInfoOptions } from '../utils';
import type { ReferenceWithHistory } from '../utils/types';
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
