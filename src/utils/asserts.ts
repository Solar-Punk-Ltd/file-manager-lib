import { BatchId, EthAddress, Identifier, PublicKey, Reference, Topic } from '@ethersphere/bee-js';
import { Types } from 'cafe-utility';

import { DriveInfo, FileInfo, ShareItem, WrappedFileInfoFeed, WrappedUploadResult } from './types';

export function isRecord(value: unknown): value is Record<string, string> {
  return Types.isStrictlyObject(value) && Object.values(value).every((v) => typeof v === 'string');
}

export function assertFileInfo(value: unknown): asserts value is FileInfo {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('FileInfo has to be object!');
  }

  const fi = value as unknown as FileInfo;

  new Reference(fi.file.reference);
  new Reference(fi.batchId);
  new Reference(fi.file.historyRef);
  new EthAddress(fi.owner);
  new Topic(fi.topic);
  new PublicKey(fi.actPublisher);

  // if (fi.actPublisher !== undefined) {
  //   new PublicKey(fi.actPublisher);
  // }

  if (fi.customMetadata !== undefined && !isRecord(fi.customMetadata)) {
    throw new TypeError('FileInfo customMetadata has to be object!');
  }

  if (fi.timestamp !== undefined && typeof fi.timestamp !== 'number') {
    throw new TypeError('timestamp property of FileInfo has to be number!');
  }

  if (fi.name !== undefined && typeof fi.name !== 'string') {
    throw new TypeError('fileName property of FileInfo has to be string!');
  }

  if (fi.preview !== undefined) {
    new Reference(fi.preview.reference);
    new Reference(fi.preview.historyRef);
  }

  if (fi.shared !== undefined && typeof fi.shared !== 'boolean') {
    throw new TypeError('shared property of FileInfo has to be boolean!');
  }

  if (fi.redundancyLevel !== undefined && typeof fi.redundancyLevel !== 'number') {
    throw new TypeError('redundancyLevel property of FileInfo has to be number!');
  }
}

export function assertShareItem(value: unknown): asserts value is ShareItem {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('ShareItem has to be object!');
  }

  const item = value as unknown as ShareItem;

  assertFileInfo(item.fileInfo);

  if (item.timestamp !== undefined && typeof item.timestamp !== 'number') {
    throw new TypeError('timestamp property of ShareItem has to be number!');
  }

  if (item.message !== undefined && typeof item.message !== 'string') {
    throw new TypeError('message property of ShareItem has to be string!');
  }
}

export function assertWrappedFileInoFeed(value: unknown): asserts value is WrappedFileInfoFeed {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('WrappedFileInfoFeed has to be object!');
  }

  const wmf = value as unknown as WrappedFileInfoFeed;

  new Topic(wmf.topic);

  if (wmf.eGranteeRef !== undefined) {
    new Reference(wmf.eGranteeRef);
  }
}

export function asserWrappedUploadResult(value: unknown): asserts value is WrappedUploadResult {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('WrappedUploadResult has to be object!');
  }

  const wur = value as unknown as WrappedUploadResult;

  new Reference(wur.uploadFilesRes);

  if (wur.uploadPreviewRes !== undefined) {
    new Reference(wur.uploadPreviewRes);
  }
}

export function assertDriveInfo(value: unknown): asserts value is DriveInfo {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('DriveInfo has to be object!');
  }

  const di = value as unknown as DriveInfo;

  new BatchId(di.batchId);
  new EthAddress(di.owner);
  new Identifier(di.id);

  if (di.infoFeedList !== undefined) {
    if (!Array.isArray(di.infoFeedList)) {
      throw new TypeError('infoFeedList property of DriveInfo has to be array!');
    }

    for (const item of di.infoFeedList) {
      assertWrappedFileInoFeed(item);
    }
  }

  if (di.name === undefined || typeof di.name !== 'string' || di.name.length === 0) {
    throw new TypeError('name property of DriveInfo has to be string!');
  }

  if (di.redundancyLevel === undefined || typeof di.redundancyLevel !== 'number') {
    throw new TypeError('redundancyLevel property of DriveInfo has to be number!');
  }
}
