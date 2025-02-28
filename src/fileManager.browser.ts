import {
  BatchId,
  Bee,
  BeeRequestOptions,
  RedundancyLevel,
  RedundantUploadOptions,
  Reference,
  Topic,
} from '@upcoming/bee-js';

import { getRandomBytes, makeBeeRequestOptions } from './utils/browser';
import { FileInfoError } from './utils/errors';
import { ReferenceWithHistory, UploadProgress } from './utils/types';
import { FileManager } from './fileManager.base';

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

    const requestOptions = historyRef ? makeBeeRequestOptions({ historyRef }) : undefined;
    const uploadFilesRes = await this.streamFiles(
      batchId,
      files,
      onUploadProgress,
      { act: true, redundancyLevel },
      requestOptions,
    );
    let uploadPreviewRes: ReferenceWithHistory | undefined;
    if (preview) {
      uploadPreviewRes = await this.streamFiles(
        batchId,
        [preview],
        onUploadProgress,
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

    await this.saveWrappedFileInfoFeed(batchId, fileInfoResult, topic, feedIndex, redundancyLevel);

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

  // TODO: redundancyLevel missing from uploadoptions
  private async streamFiles(
    batchId: BatchId,
    files: File[] | FileList,
    onUploadProgress?: (progress: UploadProgress) => void,
    uploadOptions?: RedundantUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReferenceWithHistory> {
    const reuslt = await this.bee.streamFiles(batchId, files, onUploadProgress, uploadOptions, requestOptions);

    return {
      reference: reuslt.reference.toString(),
      historyRef: reuslt.historyAddress.getOrThrow().toString(),
    };
  }
}
