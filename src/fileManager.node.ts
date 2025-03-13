import { BatchId, Bee, BeeRequestOptions, CollectionUploadOptions, FileUploadOptions, Topic } from '@upcoming/bee-js';

import { makeBeeRequestOptions } from './utils/common';
import { FileError, FileInfoError } from './utils/errors';
import { getRandomBytes, isDir, readFile } from './utils/node';
import { FileManagerUploadOptions, ReferenceWithHistory } from './utils/types';
import { FileManager } from './fileManager';

export class FileManagerNode extends FileManager {
  constructor(bee: Bee) {
    super(bee);
  }

  // Start Swarm data saving methods
  async upload(options: FileManagerUploadOptions): Promise<void> {
    if (!options.path) {
      throw new FileInfoError('Path option has to be provided.');
    }

    if ((options.infoTopic && !options.historyRef) || (!options.infoTopic && options.historyRef)) {
      throw new FileInfoError('Options infoTopic and historyRef have to be provided at the same time.');
    }

    const requestOptions = options.historyRef
      ? makeBeeRequestOptions({ historyRef: options.historyRef, redundancyLevel: options.redundancyLevel })
      : undefined;
    const uploadFilesRes = await this.uploadFileOrDirectory(
      options.batchId,
      options.path,
      { act: true, redundancyLevel: options.redundancyLevel },
      requestOptions,
    );
    let uploadPreviewRes: ReferenceWithHistory | undefined;
    if (options.previewPath) {
      uploadPreviewRes = await this.uploadFileOrDirectory(
        options.batchId,
        options.previewPath,
        { act: true, redundancyLevel: options.redundancyLevel },
        requestOptions,
      );
    }

    const topic = options.infoTopic ? Topic.fromString(options.infoTopic) : this.generateTopic();
    await super.saveFileInfoAndFeed(
      options.batchId,
      topic,
      options.name,
      uploadFilesRes,
      uploadPreviewRes,
      options.index,
      options.customMetadata,
      options.redundancyLevel,
    );
  }

  private async uploadFileOrDirectory(
    batchId: BatchId,
    resolvedPath: string,
    uploadOptions?: CollectionUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    if (isDir(resolvedPath)) {
      return this.uploadDirectory(batchId, resolvedPath, uploadOptions, requestOptions);
    } else {
      return this.uploadFile(batchId, resolvedPath, uploadOptions, requestOptions);
    }
  }

  private async uploadFile(
    batchId: BatchId,
    resolvedPath: string,
    uploadOptions?: FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    try {
      const { data, name, contentType } = readFile(resolvedPath);
      const uploadFileRes = await this.bee.uploadFile(
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

  private async uploadDirectory(
    batchId: BatchId,
    resolvedPath: string,
    uploadOptions?: CollectionUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    try {
      const uploadFilesRes = await this.bee.uploadFilesFromDirectory(
        batchId,
        resolvedPath,
        uploadOptions,
        requestOptions,
      );

      return {
        reference: uploadFilesRes.reference.toString(),
        historyRef: uploadFilesRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw new FileError(`Failed to upload directory ${resolvedPath}: ${error}`);
    }
  }

  protected generateTopic(): Topic {
    return new Topic(getRandomBytes(Topic.LENGTH));
  }
}
