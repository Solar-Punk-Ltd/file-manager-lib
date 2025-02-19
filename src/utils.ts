import { BeeRequestOptions, Bytes, EthAddress, FeedIndex, Reference, Topic } from '@upcoming/bee-js';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import path from 'path';

//import { FileError } from './errors';
import { FileInfo, RequestOptions, ShareItem, WrappedFileInfoFeed } from './types';

export function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes: Map<string, string> = new Map([
    ['.txt', 'text/plain'],
    ['.json', 'application/json'],
    ['.html', 'text/html'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
  ]);
  return contentTypes.get(ext) || 'application/octet-stream';
}

export function isDir(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) throw new Error(`Path ${dirPath} does not exist!`);
  return fs.lstatSync(dirPath).isDirectory();
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function isStrictlyObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

export function isRecord(value: Record<string, string> | string[]): value is Record<string, string> {
  return typeof value === 'object' && 'key' in value;
}

export function assertFileInfo(value: unknown): asserts value is FileInfo {
  if (!isStrictlyObject(value)) {
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

  if (fi.preview !== undefined && typeof fi.preview !== 'string') {
    throw new TypeError('preview property of FileInfo has to be string!');
  }

  if (fi.shared !== undefined && typeof fi.shared !== 'boolean') {
    throw new TypeError('shared property of FileInfo has to be boolean!');
  }

  if (fi.redundancyLevel !== undefined && typeof fi.redundancyLevel !== 'number') {
    throw new TypeError('redundancyLevel property of FileInfo has to be number!');
  }
}

export function assertShareItem(value: unknown): asserts value is ShareItem {
  if (!isStrictlyObject(value)) {
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
  if (!isStrictlyObject(value)) {
    throw new TypeError('WrappedMantarayFeed has to be object!');
  }

  const wmf = value as unknown as WrappedFileInfoFeed;

  new Reference(wmf.reference);
  new Reference(wmf.historyRef);

  if (wmf.eGranteeRef !== undefined) {
    new Reference(wmf.eGranteeRef);
  }
}

export function makeBeeRequestOptions(requestOptions: RequestOptions): BeeRequestOptions {
  const options: BeeRequestOptions = {};
  if (requestOptions.historyRef !== undefined) {
    options.headers = { 'swarm-act-history-address': requestOptions.historyRef.toString() };
  }
  if (requestOptions.publisher !== undefined) {
    options.headers = {
      ...options.headers,
      'swarm-act-publisher': requestOptions.publisher.toCompressedHex(),
    };
  }
  if (requestOptions.timestamp !== undefined) {
    options.headers = { ...options.headers, 'swarm-act-timestamp': requestOptions.timestamp.toString() };
  }
  if (requestOptions.redundancyLevel !== undefined) {
    options.headers = { ...options.headers, 'swarm-redundancy-level': requestOptions.redundancyLevel.toString() };
  }

  return options;
}

export function numberToFeedIndex(index: number | Uint8Array | string | Bytes): FeedIndex {
  index = typeof index === 'number' ? FeedIndex.fromBigInt(BigInt(index)) : index;
  return new FeedIndex(index);
}

export function makeNumericIndex(index: FeedIndex | undefined): number {
  return index === undefined ? 0 : Number(index.toBigInt());
}

// status is undefined in the error object
// Determines if the error is about 'Not Found'
export function isNotFoundError(error: any): boolean {
  return error.stack.includes('404') || error.message.includes('Not Found') || error.message.includes('404');
}

export function getRandomBytes(len: number): Bytes {
  return new Bytes(randomBytes(len));
}
