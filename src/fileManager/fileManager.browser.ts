import { BatchId, BeeRequestOptions, Topic, UploadOptions } from '@upcoming/bee-js';

import { getRandomBytes } from '../utils/browser';
import { makeBeeRequestOptions } from '../utils/common';
import { FileInfoError } from '../utils/errors';
import { FileManagerUploadOptions, ReferenceWithHistory, UploadProgress } from '../utils/types';

import { FileManagerBase } from './fileManager';

export class FileManagerBrowser extends FileManagerBase {
  async upload(options: FileManagerUploadOptions): Promise<void> {
    if (!options.files) {
      throw new FileInfoError('Files option has to be provided.');
    }

    if ((options.infoTopic && !options.historyRef) || (!options.infoTopic && options.historyRef)) {
      throw new FileInfoError('infoTopic and historyRef have to be provided at the same time.');
    }

    const requestOptions = options.historyRef
      ? makeBeeRequestOptions({ historyRef: options.historyRef, redundancyLevel: options.redundancyLevel })
      : undefined;

    const uploadFilesRes = await this.streamFiles(
      options.batchId,
      options.files,
      options.onUploadProgress,
      { act: true },
      requestOptions,
    );
    let uploadPreviewRes: ReferenceWithHistory | undefined;
    if (options.preview) {
      uploadPreviewRes = await this.streamFiles(
        options.batchId,
        [options.preview],
        options.onUploadProgress,
        { act: true },
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

  private async streamFiles(
    batchId: BatchId,
    files: File[] | FileList,
    onUploadProgress?: (progress: UploadProgress) => void,
    uploadOptions?: UploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    const reuslt = await this.bee.streamFiles(batchId, files, onUploadProgress, uploadOptions, requestOptions);

    return {
      reference: reuslt.reference.toString(),
      historyRef: reuslt.historyAddress.getOrThrow().toString(),
    };
  }

  protected generateTopic(): Topic {
    return new Topic(getRandomBytes(Topic.LENGTH));
  }
}
