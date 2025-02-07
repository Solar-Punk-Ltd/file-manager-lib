import { BeeRequestOptions, Bytes, EthAddress, FeedIndex, PublicKey, Reference, Topic } from '@upcoming/bee-js';
import { randomBytes } from 'crypto';
import path from 'path';

import { FileInfo, ShareItem, WrappedFileInoFeed } from './types';

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

  new Reference(fi.eFileRef);
  new Reference(fi.batchId);

  if (fi.historyRef !== undefined) {
    new Reference(fi.historyRef);
  }

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

  if (fi.fileName !== undefined && typeof fi.fileName !== 'string') {
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

export function assertWrappedFileInoFeed(value: unknown): asserts value is WrappedFileInoFeed {
  if (!isStrictlyObject(value)) {
    throw new TypeError('WrappedMantarayFeed has to be object!');
  }

  const wmf = value as unknown as WrappedFileInoFeed;

  new Reference(wmf.reference);
  new Reference(wmf.historyRef);

  if (wmf.eFileRef !== undefined) {
    new Reference(wmf.eFileRef);
  }

  if (wmf.eGranteeRef !== undefined) {
    new Reference(wmf.eGranteeRef);
  }
}

export function decodeBytesToPath(bytes: Uint8Array): string {
  if (bytes.length !== Reference.LENGTH) {
    const paddedBytes = new Uint8Array(Reference.LENGTH);
    paddedBytes.set(bytes.slice(0, Reference.LENGTH)); // Truncate or pad the input to ensure it's 32 bytes
    bytes = paddedBytes;
  }
  return new TextDecoder().decode(bytes);
}

export function encodePathToBytes(pathString: string): Uint8Array {
  return new TextEncoder().encode(pathString);
}

export function makeBeeRequestOptions(
  historyRef?: Reference,
  publisher?: PublicKey,
  timestamp?: number,
  act?: boolean,
): BeeRequestOptions {
  const options: BeeRequestOptions = {};
  if (historyRef !== undefined) {
    options.headers = { 'swarm-act-history-address': historyRef.toString() };
  }
  if (publisher !== undefined) {
    options.headers = {
      ...options.headers,
      'swarm-act-publisher': publisher.toCompressedHex(),
    };
  }
  if (timestamp !== undefined) {
    options.headers = { ...options.headers, 'swarm-act-timestamp': timestamp.toString() };
  }
  if (act) {
    options.headers = { ...options.headers, 'swarm-act': 'true' };
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

export function getRandomTopic(): Topic {
  return new Topic(getRandomBytes(Topic.LENGTH));
}

export function getRandomBytes(len: number): Buffer {
  return randomBytes(len);
}
