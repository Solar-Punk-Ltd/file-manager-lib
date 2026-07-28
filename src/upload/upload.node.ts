import { BatchId, Bee, BeeRequestOptions, FileUploadOptions, UploadResult } from '@ethersphere/bee-js';

import { DriveInfo } from '../types/info';
import { NodeUploadOptions } from '../types/upload';
import { ActReferences } from '../types/utils';
import { ErrorHandler, FileError } from '../utils/errors';

const errorHandler = ErrorHandler.getInstance();

async function uploadNode(
  bee: Bee,
  batchId: string | BatchId,
  nodeOptions: NodeUploadOptions,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const result = await uploadFile(bee, batchId, nodeOptions.sourcePath, uploadOptions, requestOptions);

  if (result.tagUid !== undefined) {
    nodeOptions.onUploadProgress?.(result.tagUid);
  }

  return result;
}

async function uploadFile(
  bee: Bee,
  batchId: string | BatchId,
  resolvedPath: string,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const { isDir } = await import('../utils/fs/fs.node');
  const isPathDir = await isDir(resolvedPath);

  if (isPathDir) {
    throw new FileError(`Cannot upload a directory - use uploadFiles`);
  }

  try {
    const { readFile } = await import('../utils/fs/fs.node');
    const { data } = await readFile(resolvedPath);

    return await bee.uploadData(batchId, data, uploadOptions, requestOptions);
  } catch (err: unknown) {
    errorHandler.handleError(err, `Failed to upload file ${resolvedPath}`);
    throw new FileError(`Failed to upload file ${resolvedPath}`);
  }
}

export async function processUploadNode(
  bee: Bee,
  driveInfo: DriveInfo,
  nodeOptions: NodeUploadOptions,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ActReferences> {
  if (!nodeOptions.sourcePath) {
    throw new FileError('File source path is required.');
  }

  const uploadResult = await uploadNode(bee, driveInfo.batchId, nodeOptions, uploadOptions, requestOptions);

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ActReferences;
}
