import type {
  BeeRequestOptions,
  FileUploadOptions,
  RedundancyLevel,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import type { DriveInfo } from '../types/info';
import { type SwarmClient } from '../types/swarmClient';
import type { BrowserUploadOptions, NodeUploadOptions, UploadSource } from '../types/upload';
import type { ContentRef, SwarmUploadOptions } from '../types/utils';
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

/**
 * Upload one file's bytes with Swarm native encryption and return the 64-byte reference.
 *
 * `encrypt` is forced rather than taken from `uploadOptions`: the reference is the only content
 * capability a record holds, so an unencrypted upload would leave the bytes readable to anyone who
 * learns it.
 */
export async function processUpload(
  swarmClient: SwarmClient,
  driveInfo: DriveInfo,
  item: UploadSource,
  redundancyLevel: RedundancyLevel,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<{ content: ContentRef; rLevel: RedundancyLevel }> {
  const rLevel = uploadOptions?.redundancyLevel ?? redundancyLevel;
  const options: SwarmUploadOptions = { encrypt: true, redundancyLevel: rLevel };

  if (isNode) {
    const { processUploadNode } = await import('./upload-node');
    const content = await processUploadNode(swarmClient, driveInfo, item as NodeUploadOptions, options, requestOptions);

    return { content, rLevel };
  }

  const { processUploadBrowser } = await import('./upload-browser');
  const content = await processUploadBrowser(
    swarmClient,
    driveInfo,
    item as BrowserUploadOptions,
    options,
    requestOptions,
  );

  return { content, rLevel };
}
