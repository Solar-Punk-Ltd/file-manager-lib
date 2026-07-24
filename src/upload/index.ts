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
  redundancyLevel: RedundancyLevel;
}

const processOptions = (
  isNode: boolean,
  item: UploadSource,
  redundancyLevel: RedundancyLevel,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions,
): ProcessedOptions => {
  const effectiveRedundancyLevel = uploadOptions?.redundancyLevel ?? redundancyLevel;
  const processedOptions = { ...uploadOptions, act: true, redundancyLevel: effectiveRedundancyLevel };

  const options = isNode ? (item as NodeUploadOptions) : (item as BrowserUploadOptions);

  return { options, uploadOptions: processedOptions, redundancyLevel: effectiveRedundancyLevel };
};

export async function processUpload(
  bee: Bee,
  driveInfo: DriveInfo,
  item: UploadSource,
  redundancyLevel: RedundancyLevel,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<{ contentRefs: ActReferences; rLevel: RedundancyLevel }> {
  const {
    options,
    uploadOptions: processedUploadOptions,
    redundancyLevel: rLevel,
  } = processOptions(isNode, item, redundancyLevel, uploadOptions);

  if (isNode) {
    const { processUploadNode } = await import('./upload.node');
    const contentRefs = await processUploadNode(
      bee,
      driveInfo,
      options as NodeUploadOptions,
      processedUploadOptions,
      requestOptions,
    );

    return { contentRefs, rLevel };
  }

  const { processUploadBrowser } = await import('./upload.browser');
  const contentRefs = await processUploadBrowser(
    bee,
    driveInfo,
    options as BrowserUploadOptions,
    processedUploadOptions,
    requestOptions,
  );

  return { contentRefs, rLevel };
}
