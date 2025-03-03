import {
  BatchId,
  Bee,
  BeeRequestOptions,
  CollectionUploadOptions,
  FileUploadOptions,
  RedundancyLevel,
  Reference,
  Topic,
} from '@upcoming/bee-js';

import { makeBeeRequestOptions } from './utils/common';
import { FileInfoError } from './utils/errors';
import { getRandomBytes, isDir, readFile } from './utils/node';
import { ReferenceWithHistory } from './utils/types';
import { FileManager } from './fileManager';

export class FileManagerNode extends FileManager {
  constructor(bee: Bee) {
    super(bee);
  }

  // Start Swarm data saving methods
  // TODO: event emitter integration
  async upload(
    batchId: BatchId,
    path: string,
    customMetadata?: Record<string, string>,
    historyRef?: Reference,
    infoTopic?: string,
    index?: number | undefined,
    previewPath?: string,
    redundancyLevel?: RedundancyLevel,
    _cb?: (T: any) => void,
  ): Promise<void> {
    if ((infoTopic && !historyRef) || (!infoTopic && historyRef)) {
      throw new FileInfoError('infoTopic and historyRef have to be provided at the same time.');
    }

    const requestOptions = historyRef ? makeBeeRequestOptions({ historyRef }) : undefined;
    const uploadFilesRes = await this.uploadFileOrDirectory(
      batchId,
      path,
      { act: true, redundancyLevel },
      requestOptions,
    );
    let uploadPreviewRes: ReferenceWithHistory | undefined;
    if (previewPath) {
      uploadPreviewRes = await this.uploadFileOrDirectory(
        batchId,
        previewPath,
        { act: true, redundancyLevel },
        requestOptions,
      );
    }

    const topic = infoTopic ? Topic.fromString(infoTopic) : this.generateTopic();
    await super.saveFileInfoAndFeed(
      batchId,
      topic,
      uploadFilesRes,
      uploadPreviewRes,
      index,
      customMetadata,
      redundancyLevel,
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
      console.log(`Uploading file: ${name}`);

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

      console.log(`File uploaded successfully: ${name}, reference: ${uploadFileRes.reference.toString()}`);
      return {
        reference: uploadFileRes.reference.toString(),
        historyRef: uploadFileRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw `Failed to upload file ${resolvedPath}: ${error}`;
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

      console.log(`Directory uploaded successfully, reference: ${uploadFilesRes.reference.toString()}`);
      return {
        reference: uploadFilesRes.reference.toString(),
        historyRef: uploadFilesRes.historyAddress.getOrThrow().toString(),
      };
    } catch (error: any) {
      throw `Failed to upload directory ${resolvedPath}: ${error}`;
    }
  }

  protected generateTopic(): Topic {
    return new Topic(getRandomBytes(Topic.LENGTH));
  }
}
