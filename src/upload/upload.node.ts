import {
  BatchId,
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  UploadResult,
} from '@ethersphere/bee-js';

import { FileError, FileInfoError } from '../utils/errors';
import { isDir, readFile } from '../utils/node';
import { FileInfoOptions, WrappedUploadResult } from '../utils/types';

export async function uploadNode(
  bee: Bee,
  infoOptions: FileInfoOptions,
  uploadOptions?: FileUploadOptions | CollectionUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (!infoOptions.path) {
    throw new FileInfoError('Path option has to be provided.');
  }

  const uploadFilesRes = await uploadFileOrDirectory(
    bee,
    new BatchId(infoOptions.info.batchId),
    infoOptions.path,
    { ...uploadOptions, act: false },
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (infoOptions.previewPath) {
    uploadPreviewRes = await uploadFileOrDirectory(
      bee,
      new BatchId(infoOptions.info.batchId),
      infoOptions.previewPath,
      { ...uploadOptions, act: false },
      requestOptions,
    );
  }

  const wrappedData: WrappedUploadResult = {
    uploadFilesRes: uploadFilesRes.reference.toString(),
    uploadPreviewRes: uploadPreviewRes?.reference.toString(),
  };

  return await bee.uploadData(
    infoOptions.info.batchId,
    JSON.stringify(wrappedData),
    { ...uploadOptions, act: true },
    requestOptions,
  );
}

async function uploadFileOrDirectory(
  bee: Bee,
  batchId: BatchId,
  resolvedPath: string,
  uploadOptions?: CollectionUploadOptions | FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (isDir(resolvedPath)) {
    return uploadDirectory(bee, batchId, resolvedPath, uploadOptions as CollectionUploadOptions, requestOptions);
  } else {
    return uploadFile(bee, batchId, resolvedPath, uploadOptions as FileUploadOptions, requestOptions);
  }
}

async function uploadFile(
  bee: Bee,
  batchId: BatchId,
  resolvedPath: string,
  uploadOptions?: FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  try {
    const { data, name, contentType } = readFile(resolvedPath);

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
