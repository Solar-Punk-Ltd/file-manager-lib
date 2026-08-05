import { BatchId, BeeRequestOptions, FileUploadOptions, Reference, UploadResult } from '@ethersphere/bee-js';
import { Optional } from 'cafe-utility';

import { DriveInfo } from '../types/info';
import { SwarmClient } from '../types/swarmClient';
import { NodeUploadOptions } from '../types/upload';
import { ActReferences } from '../types/utils';
import { ErrorHandler, FileError } from '../utils/errors';

const errorHandler = ErrorHandler.getInstance();

async function uploadNode(
  swarmClient: SwarmClient,
  batchId: string | BatchId,
  nodeOptions: NodeUploadOptions,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const result = await uploadFile(swarmClient, batchId, nodeOptions.sourcePath, uploadOptions, requestOptions);

  if (result.tagUid !== undefined) {
    nodeOptions.onUploadProgress?.(result.tagUid);
  }

  return result;
}

async function uploadFile(
  swarmClient: SwarmClient,
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

    const result = await swarmClient.uploadProtected(
      batchId.toString(),
      data,
      uploadOptions?.actHistoryAddress?.toString(),
      uploadOptions,
      requestOptions,
    );

    return {
      reference: new Reference(result.contentRefs.reference),
      historyAddress: Optional.of(new Reference(result.contentRefs.historyRef)),
      tagUid: result.tagUid,
    };
  } catch (err: unknown) {
    errorHandler.handleError(err, `Failed to upload file ${resolvedPath}`);
    throw new FileError(`Failed to upload file ${resolvedPath}`, err);
  }
}

export async function processUploadNode(
  swarmClient: SwarmClient,
  driveInfo: DriveInfo,
  nodeOptions: NodeUploadOptions,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ActReferences> {
  if (!nodeOptions.sourcePath) {
    throw new FileError('File source path is required.');
  }

  const uploadResult = await uploadNode(swarmClient, driveInfo.batchId, nodeOptions, uploadOptions, requestOptions);

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ActReferences;
}
