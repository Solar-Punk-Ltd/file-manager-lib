import type {
  Bee,
  BeeRequestOptions,
  FileUploadOptions,
  RedundancyLevel,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import type { DriveInfo, FileInfoOptions } from '../types';
import type { BrowserUploadOptions, NodeUploadOptions, ReferenceWithHistory } from '../types/utils';
import { FileError } from '../utils/errors';

export async function assertUploadableSource(fileOptions: FileInfoOptions): Promise<void> {
  // TODO: processUpload reports the missing path/file itself -> throw here?
  if (isNode) {
    const nodeOptions = fileOptions as NodeUploadOptions;
    if (!nodeOptions.path) {
      return;
    }

    const { isDir } = await import('../utils/fs/fs.node');
    if (await isDir(nodeOptions.path)) {
      throw new FileError('Cannot upload a directory - use uploadFiles');
    }

    return;
  }

  const isFileProvided = (fileOptions as BrowserUploadOptions).file;
  if (!isFileProvided) {
    throw new FileError('File is required.');
  }
}

interface ProcessedOptions {
  options: BrowserUploadOptions | NodeUploadOptions;
  uploadOptions: RedundantUploadOptions | FileUploadOptions;
}

const processOptions = (
  isNode: boolean,
  fileOptions: FileInfoOptions,
  uploadOptions: RedundantUploadOptions | FileUploadOptions | undefined,
  redundancyLevel: RedundancyLevel,
): ProcessedOptions => {
  const processedOptions = { ...uploadOptions, redundancyLevel };

  const options = isNode ? (fileOptions as NodeUploadOptions) : (fileOptions as BrowserUploadOptions);

  return { options, uploadOptions: processedOptions };
};

// TODO: why separate rLevel arg ?
export async function processUpload(
  bee: Bee,
  driveInfo: DriveInfo,
  fileOptions: FileInfoOptions,
  uploadOptions: RedundantUploadOptions | FileUploadOptions | undefined,
  // Effective redundancy level inherited from the target parent folder (or drive root) —
  // resolved by the caller, since only it knows which ManifestHost the file is landing under.
  redundancyLevel: RedundancyLevel,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
  const processedOptions = processOptions(isNode, fileOptions, uploadOptions, redundancyLevel);

  if (isNode) {
    const { processUploadNode } = await import('./upload.node');
    const nodeOptions = processedOptions.options as NodeUploadOptions;
    return processUploadNode(bee, driveInfo, nodeOptions, processedOptions.uploadOptions, requestOptions);
  }

  const { processUploadBrowser } = await import('./upload.browser');
  const browserOptions = processedOptions.options as BrowserUploadOptions;
  return processUploadBrowser(bee, driveInfo, browserOptions, processedOptions.uploadOptions, requestOptions);
}
