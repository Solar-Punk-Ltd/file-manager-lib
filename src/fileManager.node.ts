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

import { FileInfoError } from './utils/errors';
import { getRandomBytes, isDir, makeBeeRequestOptions, readFile } from './utils/node';
import { ReferenceWithHistory } from './utils/types';
import { FileManager } from './fileManager.base';

export class FileManagerNode extends FileManager {
  constructor(bee: Bee) {
    super(bee);
  }

  // End getter methods

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

    const topic = infoTopic ? Topic.fromString(infoTopic) : new Topic(getRandomBytes(Topic.LENGTH));
    const feedIndex = index !== undefined ? index : 0;
    const fileInfoResult = await this.uploadFileInfo({
      batchId: batchId.toString(),
      file: uploadFilesRes,
      topic: topic.toString(),
      owner: this.signer.publicKey().address().toString(),
      name: 'TODO bagoy',
      timestamp: new Date().getTime(),
      shared: false,
      preview: uploadPreviewRes,
      index: feedIndex,
      redundancyLevel,
      customMetadata,
    });

    await super.saveWrappedFileInfoFeed(batchId, fileInfoResult, topic, feedIndex, redundancyLevel);

    const ix = this.ownerFeedList.findIndex((f) => f.topic.toString() === topic.toString());
    if (ix !== -1) {
      this.ownerFeedList[ix] = {
        topic: topic.toString(),
        eGranteeRef: this.ownerFeedList[ix].eGranteeRef?.toString(),
      };
    } else {
      this.ownerFeedList.push({ topic: topic.toString() });
    }

    await this.saveFileInfoFeedList();
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
}
