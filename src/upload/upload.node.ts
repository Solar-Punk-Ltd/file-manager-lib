import {
  BatchId,
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  RedundantUploadOptions,
  UploadResult,
} from '@ethersphere/bee-js';

import { FileError } from '../utils/errors';
import {
  DriveInfo,
  FileInfoOptions,
  NodeUploadOptions,
  ReferenceWithHistory,
  WrappedUploadResult,
} from '../utils/types';

async function uploadNode(
  bee: Bee,
  batchId: string | BatchId,
  nodeOptions: NodeUploadOptions,
  uploadOptions?: FileUploadOptions | CollectionUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const uploadFilesRes = await uploadFileOrDirectory(
    bee,
    new BatchId(batchId),
    nodeOptions.path,
    { ...uploadOptions, act: false },
    requestOptions,
  );

  let uploadPreviewRes: UploadResult | undefined;

  if (nodeOptions.previewPath) {
    uploadPreviewRes = await uploadFileOrDirectory(
      bee,
      new BatchId(batchId),
      nodeOptions.previewPath,
      { ...uploadOptions, act: false },
      requestOptions,
    );
  }

  const wrappedData: WrappedUploadResult = {
    uploadFilesRes: uploadFilesRes.reference.toString(),
    uploadPreviewRes: uploadPreviewRes?.reference.toString(),
  };

  return await bee.uploadData(batchId, JSON.stringify(wrappedData), { ...uploadOptions, act: true }, requestOptions);
}

async function uploadFileOrDirectory(
  bee: Bee,
  batchId: BatchId,
  resolvedPath: string,
  uploadOptions?: CollectionUploadOptions | FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  const { isDir } = await import('../utils/fs/fs.node');
  const isPathDir = await isDir(resolvedPath);

  if (isPathDir) {
    return uploadDirectory(bee, batchId, resolvedPath, uploadOptions as CollectionUploadOptions, requestOptions);
  }

  return uploadFile(bee, batchId, resolvedPath, uploadOptions as FileUploadOptions, requestOptions);
}

async function uploadFile(
  bee: Bee,
  batchId: BatchId,
  resolvedPath: string,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  try {
    const { readFile } = await import('../utils/fs/fs.node');
    const { data, name, contentType } = await readFile(resolvedPath);

    return await bee.uploadFile(
      batchId,
      data,
      name,
      {
        ...uploadOptions,
        contentType: contentType,
      },
      requestOptions,
    );
  } catch (error: any) {
    throw new FileError(`Failed to upload file ${resolvedPath}: ${error}`);
  }
}

async function uploadDirectory(
  bee: Bee,
  batchId: BatchId,
  resolvedPath: string,
  uploadOptions?: CollectionUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  try {
    return await bee.uploadFilesFromDirectory(batchId, resolvedPath, uploadOptions, requestOptions);
  } catch (error: any) {
    throw new FileError(`Failed to upload directory ${resolvedPath}: ${error}`);
  }
}

export async function processUploadNode(
  bee: Bee,
  driveInfo: DriveInfo,
  fileOptions: FileInfoOptions,
  uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
  uploadOptions = { ...uploadOptions, redundancyLevel: driveInfo.redundancyLevel };

  if (fileOptions.file) {
    return {
      reference: fileOptions.file.reference.toString(),
      historyRef: fileOptions.file.historyRef.toString(),
    } as ReferenceWithHistory;
  }

  const batchId = driveInfo.batchId;

  const nodeOptions: NodeUploadOptions = fileOptions as NodeUploadOptions;

  if (!nodeOptions.path) {
    throw new Error('File path is required.');
  }

  const uploadResult = await uploadNode(bee, batchId, nodeOptions, uploadOptions, requestOptions);

  return {
    reference: uploadResult.reference.toString(),
    historyRef: uploadResult.historyAddress.getOrThrow().toString(),
  } as ReferenceWithHistory;
}
