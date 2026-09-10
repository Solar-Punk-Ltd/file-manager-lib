import type { BeeRequestOptions } from '@ethersphere/bee-js';
import { type BatchId } from '@ethersphere/core-sdk';

import { type DriveInfo } from '../types/info';
import type { SwarmClient } from '../types/swarmClient';
import { type NodeUploadOptions } from '../types/upload';
import { type ContentRef, type SwarmUploadOptions } from '../types/utils';
import { ErrorHandler, FileError } from '../utils/errors';

const errorHandler = ErrorHandler.getInstance();

async function uploadFile(
  swarmClient: SwarmClient,
  batchId: string | BatchId,
  resolvedPath: string,
  options: SwarmUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ContentRef & { tagUid?: number }> {
  const { isDir } = await import('../utils/fs/fs-node');
  const isPathDir = await isDir(resolvedPath);

  if (isPathDir) {
    throw new FileError(`Cannot upload a directory - use uploadFiles`);
  }

  try {
    const { readFile } = await import('../utils/fs/fs-node');
    const { data } = await readFile(resolvedPath);

    const result = await swarmClient.uploadData(batchId.toString(), data, options, requestOptions);

    return { reference: result.reference.toString(), tagUid: result.tagUid };
  } catch (err: unknown) {
    errorHandler.handleError(err, `Failed to upload file ${resolvedPath}`);
    throw new FileError(`Failed to upload file ${resolvedPath}`, err);
  }
}

export async function processUploadNode(
  swarmClient: SwarmClient,
  driveInfo: DriveInfo,
  nodeOptions: NodeUploadOptions,
  options: SwarmUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ContentRef> {
  const { reference, tagUid } = await uploadFile(
    swarmClient,
    driveInfo.batchId,
    nodeOptions.sourcePath,
    options,
    requestOptions,
  );

  if (tagUid !== undefined) {
    nodeOptions.onUploadProgress?.(tagUid);
  }

  return { reference };
}
