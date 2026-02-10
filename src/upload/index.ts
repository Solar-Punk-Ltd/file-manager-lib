import type {
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import type { DriveInfo, FileInfoOptions } from '../types';
import type { BrowserUploadOptions, NodeUploadOptions, ReferenceWithHistory } from '../types/utils';

interface ProcessedOptions {
  options: BrowserUploadOptions | NodeUploadOptions;
  uploadOptions: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions;
  file?: ReferenceWithHistory | undefined;
}

const processOptions = (
  isNode: boolean,
  driveInfo: DriveInfo,
  fileOptions: FileInfoOptions,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
): ProcessedOptions => {
  const processedOptions = { ...uploadOptions, redundancyLevel: driveInfo.redundancyLevel };

  let file: ReferenceWithHistory | undefined;

  if (fileOptions.file) {
    file = {
      reference: fileOptions.file.reference.toString(),
      historyRef: fileOptions.file.historyRef.toString(),
    };
  }

  let options: BrowserUploadOptions | NodeUploadOptions;

  if (isNode) {
    options = fileOptions as NodeUploadOptions;
  } else {
    options = fileOptions as BrowserUploadOptions;
  }

  return { options, uploadOptions: processedOptions, file };
};

export async function processUpload(
  bee: Bee,
  driveInfo: DriveInfo,
  fileOptions: FileInfoOptions,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
  const processedOptions = processOptions(isNode, driveInfo, fileOptions, uploadOptions);

  if (processedOptions.file) {
    return processedOptions.file;
  }

  if (isNode) {
    const { processUploadNode } = await import('./upload.node');
    const nodeOptions = processedOptions.options as NodeUploadOptions;
    return processUploadNode(bee, driveInfo, nodeOptions, uploadOptions, requestOptions);
  }

  const { processUploadBrowser } = await import('./upload.browser');
  const browserOptions = processedOptions.options as BrowserUploadOptions;
  return processUploadBrowser(bee, driveInfo, browserOptions, uploadOptions, requestOptions);
}
