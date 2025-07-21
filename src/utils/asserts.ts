import { EthAddress, Reference, Topic } from '@ethersphere/bee-js';
import { Types } from 'cafe-utility';

import { FileInfo, FileVersionMetadata, ShareItem, WrappedFileInfoFeed, WrappedUploadResult } from './types';

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

  if (fi.topic !== undefined) {
    new Topic(fi.topic);
  }

  if (fi.customMetadata !== undefined && !isRecord(fi.customMetadata)) {
    throw new TypeError('FileInfo customMetadata has to be object!');
  }

  if (fi.timestamp !== undefined && typeof fi.timestamp !== 'number') {
    throw new TypeError('timestamp property of FileInfo has to be number!');
  }

  if (fi.owner !== undefined) {
    new EthAddress(fi.owner);
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

export function assertFileVersionMetadata(value: unknown): asserts value is FileVersionMetadata {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('FileVersionMetadata has to be an object!');
  }
  const m = value as FileVersionMetadata;
  if (typeof m.filePath !== 'string') {
    throw new TypeError('FileVersionMetadata.filePath must be a string!');
  }
  if (typeof m.contentHash !== 'string') {
    throw new TypeError('FileVersionMetadata.contentHash must be a string!');
  }
  if (typeof m.size !== 'number') {
    throw new TypeError('FileVersionMetadata.size must be a number!');
  }
  if (typeof m.timestamp !== 'string') {
    throw new TypeError('FileVersionMetadata.timestamp must be a string!');
  }
  if (typeof m.version !== 'number') {
    throw new TypeError('FileVersionMetadata.version must be a number!');
  }
  if (typeof m.batchId !== 'string') {
    throw new TypeError('FileVersionMetadata.batchId must be a string!');
  }
  if (m.customMetadata !== undefined && !isRecord(m.customMetadata)) {
    throw new TypeError('FileVersionMetadata.customMetadata, if present, must be Record<string, string>!');
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
    throw new TypeError('WrappedMantarayFeed has to be object!');
  }

  const wmf = value as unknown as WrappedFileInfoFeed;

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
