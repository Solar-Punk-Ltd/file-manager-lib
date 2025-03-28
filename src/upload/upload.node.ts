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
import { FileManagerUploadOptions, WrappedUploadResult } from '../utils/types';

export async function uploadNode(
  bee: Bee,
  options: FileManagerUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (!options.path) {
    throw new FileInfoError('Path option has to be provided.');
  }

  const uploadFilesRes = await uploadFileOrDirectory(
    bee,
    options.batchId,
    options.path,
    { redundancyLevel: options.redundancyLevel },
    requestOptions,
  );
  let uploadPreviewRes: UploadResult | undefined;
  if (options.previewPath) {
    uploadPreviewRes = await uploadFileOrDirectory(
      bee,
      options.batchId,
      options.previewPath,
      { redundancyLevel: options.redundancyLevel },
      requestOptions,
    );
  }

  const wrappedData: WrappedUploadResult = {
    uploadFilesRes: uploadFilesRes.reference.toString(),
    uploadPreviewRes: uploadPreviewRes?.reference.toString(),
  };
  const wrappedUploadRes = await bee.uploadData(
    options.batchId,
    JSON.stringify(wrappedData),
    { act: true },
    {
      ...requestOptions,
    },
  );

  return wrappedUploadRes;
}

async function uploadFileOrDirectory(
  bee: Bee,
  batchId: BatchId,
  resolvedPath: string,
  uploadOptions?: CollectionUploadOptions | FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<UploadResult> {
  if (isDir(resolvedPath)) {
    return uploadDirectory(bee, batchId, resolvedPath, uploadOptions, requestOptions);
  } else {
    return uploadFile(bee, batchId, resolvedPath, uploadOptions, requestOptions);
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
    const uploadFileRes = await bee.uploadFile(
      batchId,
      data,
      name,
      {
        ...uploadOptions,
        contentType: contentType,
      },
      requestOptions,
    );

    // return {
    //   reference: uploadFileRes.reference.toString(),
    //   historyRef: uploadFileRes.historyAddress.getOrThrow().toString(),
    // };

    return uploadFileRes;
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
    const uploadFilesRes = await bee.uploadFilesFromDirectory(batchId, resolvedPath, uploadOptions, requestOptions);

    // return {
    //   reference: uploadFilesRes.reference.toString(),
    //   historyRef: uploadFilesRes.historyAddress.getOrThrow().toString(),
    // };
    return uploadFilesRes;
  } catch (error: any) {
    throw new FileError(`Failed to upload directory ${resolvedPath}: ${error}`);
  }
}
