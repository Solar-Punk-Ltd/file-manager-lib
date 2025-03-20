import { BatchId, Bee, BeeRequestOptions, CollectionUploadOptions, FileUploadOptions } from '@ethersphere/bee-js';

import { FileError, FileInfoError } from '../utils/errors';
import { isDir, readFile } from '../utils/node';
import { FileManagerUploadOptions, ReferenceWithHistory } from '../utils/types';
import { UploadResult } from '../utils/types';

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
    { act: true, redundancyLevel: options.redundancyLevel },
    requestOptions,
  );
  let uploadPreviewRes: ReferenceWithHistory | undefined;
  if (options.previewPath) {
    uploadPreviewRes = await uploadFileOrDirectory(
      bee,
      options.batchId,
      options.previewPath,
      { act: true, redundancyLevel: options.redundancyLevel },
      requestOptions,
    );
  }

  return { uploadFilesRes, uploadPreviewRes };
}

async function uploadFileOrDirectory(
  bee: Bee,
  batchId: BatchId,
  resolvedPath: string,
  uploadOptions?: CollectionUploadOptions | FileUploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReferenceWithHistory> {
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
): Promise<ReferenceWithHistory> {
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

    return {
      reference: uploadFileRes.reference.toString(),
      historyRef: uploadFileRes.historyAddress.getOrThrow().toString(),
    };
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
): Promise<ReferenceWithHistory> {
  try {
    const uploadFilesRes = await bee.uploadFilesFromDirectory(batchId, resolvedPath, uploadOptions, requestOptions);

    return {
      reference: uploadFilesRes.reference.toString(),
      historyRef: uploadFilesRes.historyAddress.getOrThrow().toString(),
    };
  } catch (error: any) {
    throw new FileError(`Failed to upload directory ${resolvedPath}: ${error}`);
  }
}
