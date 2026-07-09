import type {
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  RedundancyLevel,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import type { DriveInfo, FileInfoOptions } from '../types';
import type { BrowserUploadOptions, NodeUploadOptions, ReferenceWithHistory } from '../types/utils';

interface ProcessedOptions {
  options: BrowserUploadOptions | NodeUploadOptions;
  uploadOptions: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions;
  file?: ReferenceWithHistory;
}

const processOptions = (
  isNode: boolean,
  fileOptions: FileInfoOptions,
  uploadOptions: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions | undefined,
  redundancyLevel: RedundancyLevel,
): ProcessedOptions => {
  const processedOptions = { ...uploadOptions, redundancyLevel };

  let file: ReferenceWithHistory | undefined;

  if (fileOptions.file) {
    file = {
      reference: fileOptions.file.reference.toString(),
      historyRef: fileOptions.file.historyRef.toString(),
    };
  }

  const options = isNode ? (fileOptions as NodeUploadOptions) : (fileOptions as BrowserUploadOptions);

  return { options, uploadOptions: processedOptions, file };
};

export async function processUpload(
  bee: Bee,
  driveInfo: DriveInfo,
  fileOptions: FileInfoOptions,
  uploadOptions: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions | undefined,
  // Effective redundancy level inherited from the target parent folder (or drive root) —
  // resolved by the caller, since only it knows which ManifestHost the file is landing under.
  redundancyLevel: RedundancyLevel,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
  const processedOptions = processOptions(isNode, fileOptions, uploadOptions, redundancyLevel);

  if (processedOptions.file) {
    return processedOptions.file;
  }

  if (isNode) {
    const { processUploadNode } = await import('./upload.node');
    const nodeOptions = processedOptions.options as NodeUploadOptions;
    return processUploadNode(bee, driveInfo, nodeOptions, processedOptions.uploadOptions, requestOptions);
  }

  const { processUploadBrowser } = await import('./upload.browser');
  const browserOptions = processedOptions.options as BrowserUploadOptions;
  return processUploadBrowser(bee, driveInfo, browserOptions, processedOptions.uploadOptions, requestOptions);
}
