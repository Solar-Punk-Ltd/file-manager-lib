import type {
  BeeRequestOptions,
  FileUploadOptions,
  RedundancyLevel,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import { type SwarmClient } from '../types/client/swarmClient';
import type { DriveInfo } from '../types/info';
import type { BrowserUploadOptions, NodeUploadOptions, UploadSource } from '../types/upload';
import type { ActReferences } from '../types/utils';
import { FileError } from '../utils/errors';

export function assertUploadableSource(item: UploadSource): void {
  if (isNode) {
    if (!(item as NodeUploadOptions).sourcePath) {
      throw new FileError('File source path is required.');
    }
    return;
  }

  if (!(item as BrowserUploadOptions).file) {
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
  swarmClient: SwarmClient,
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
    const { processUploadNode } = await import('./upload-node');
    const contentRefs = await processUploadNode(
      swarmClient,
      driveInfo,
      options as NodeUploadOptions,
      processedUploadOptions,
      requestOptions,
    );

    return { contentRefs, rLevel };
  }

  const { processUploadBrowser } = await import('./upload-browser');
  const contentRefs = await processUploadBrowser(
    swarmClient,
    driveInfo,
    options as BrowserUploadOptions,
    processedUploadOptions,
    requestOptions,
  );

  return { contentRefs, rLevel };
}
