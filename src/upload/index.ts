import type {
  Bee,
  BeeRequestOptions,
  FileUploadOptions,
  RedundancyLevel,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import type { DriveInfo } from '../types/info';
import type { BrowserUploadOptions, NodeUploadOptions, UploadItem, UploadSource } from '../types/upload';
import type { ActReferences } from '../types/utils';
import { FileError } from '../utils/errors';

export async function assertUploadableSource(item: UploadItem): Promise<void> {
  // TODO: processUpload reports the missing path/file itself -> throw here?
  if (isNode) {
    const nodeOptions = item as NodeUploadOptions;
    if (!nodeOptions.sourcePath) {
      return;
    }

    const { isDir } = await import('../utils/fs/fs.node');
    if (await isDir(nodeOptions.sourcePath)) {
      throw new FileError('Cannot upload a directory - use uploadFiles');
    }

    return;
  }

  const isFileProvided = (item as BrowserUploadOptions).file;
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
  item: UploadSource,
  uploadOptions: RedundantUploadOptions | FileUploadOptions | undefined,
  redundancyLevel: RedundancyLevel,
): ProcessedOptions => {
  const processedOptions = { ...uploadOptions, act: true, redundancyLevel };

  const options = isNode ? (item as NodeUploadOptions) : (item as BrowserUploadOptions);

  return { options, uploadOptions: processedOptions };
};

// TODO: why separate rLevel arg ? --> merge and require
export async function processUpload(
  bee: Bee,
  driveInfo: DriveInfo,
  item: UploadSource,
  redundancyLevel: RedundancyLevel,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ActReferences> {
  const processedOptions = processOptions(isNode, item, uploadOptions, redundancyLevel);

  if (isNode) {
    const { processUploadNode } = await import('./upload.node');
    const nodeOptions = processedOptions.options as NodeUploadOptions;
    return processUploadNode(bee, driveInfo, nodeOptions, processedOptions.uploadOptions, requestOptions);
  }

  const { processUploadBrowser } = await import('./upload.browser');
  const browserOptions = processedOptions.options as BrowserUploadOptions;
  return processUploadBrowser(bee, driveInfo, browserOptions, processedOptions.uploadOptions, requestOptions);
}
