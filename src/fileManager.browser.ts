import { BatchId, Bee, BeeRequestOptions, RedundancyLevel, Reference, Topic, UploadOptions } from '@upcoming/bee-js';

import { getRandomBytes } from './utils/browser';
import { makeBeeRequestOptions } from './utils/common';
import { FileInfoError } from './utils/errors';
import { ReferenceWithHistory, UploadProgress } from './utils/types';
import { FileManager } from './fileManager';

export class FileManagerBrowser extends FileManager {
  constructor(bee: Bee) {
    super(bee);
  }

  // Start Swarm data saving methods
  // TODO: event emitter integration
  async upload(
    batchId: BatchId,
    files: File[] | FileList,
    customMetadata?: Record<string, string>,
    historyRef?: Reference,
    infoTopic?: string,
    index?: number | undefined,
    preview?: File,
    redundancyLevel?: RedundancyLevel,
    onUploadProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    if ((infoTopic && !historyRef) || (!infoTopic && historyRef)) {
      throw new FileInfoError('infoTopic and historyRef have to be provided at the same time.');
    }

    const requestOptions = historyRef ? makeBeeRequestOptions({ historyRef, redundancyLevel }) : undefined;
    const uploadFilesRes = await this.streamFiles(batchId, files, onUploadProgress, { act: true }, requestOptions);
    let uploadPreviewRes: ReferenceWithHistory | undefined;
    if (preview) {
      uploadPreviewRes = await this.streamFiles(batchId, [preview], onUploadProgress, { act: true }, requestOptions);
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
