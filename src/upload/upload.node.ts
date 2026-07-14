import { BatchId, Bee, BeeRequestOptions, FileUploadOptions, UploadResult } from '@ethersphere/bee-js';

import { DriveInfo, NodeUploadOptions } from '../types';
import { ActReferences } from '../types/utils';
import { FileError } from '../utils/errors';

async function uploadNode(
  bee: Bee,
  batchId: string | BatchId,
  nodeOptions: NodeUploadOptions,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const result = await uploadFile(bee, batchId, nodeOptions.path, uploadOptions, requestOptions);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    throw new FileError(`Failed to upload file ${resolvedPath}: ${error}`);
  }
}

export async function processUploadNode(
  bee: Bee,
  driveInfo: DriveInfo,
  nodeOptions: NodeUploadOptions,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ActReferences> {
  if (!nodeOptions.path) {
    throw new FileError('File path is required.');
  }

  const uploadResult = await uploadNode(bee, driveInfo.batchId, nodeOptions, uploadOptions, requestOptions);

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ActReferences;
}
