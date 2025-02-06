import {
  BatchId,
  BeeRequestOptions,
  Bytes,
  EthAddress,
  FeedIndex,
  PublicKey,
  Reference,
  Topic,
} from '@upcoming/bee-js';
import { randomBytes } from 'crypto';
import path from 'path';

import { FileInfo, ReferenceWithHistory, ShareItem, WrappedMantarayFeed } from './types';

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

  if (fi.eFileRef === undefined || fi.eFileRef.length !== Reference.LENGTH) {
    throw new TypeError('eFileRef property of FileInfo has to be Reference!');
  }

  if (fi.batchId === undefined || fi.batchId.length !== BatchId.LENGTH) {
    throw new TypeError('batchId property of FileInfo has to be string!');
  }

  if (fi.historyRef !== undefined && fi.historyRef.length !== Reference.LENGTH) {
    throw new TypeError('historyRef property of FileInfo has to be Reference!');
  }

  if (fi.topic !== undefined && fi.topic.length !== Topic.LENGTH) {
    throw new TypeError('topic property of FileInfo has to be Reference!');
  }

  if (fi.customMetadata !== undefined && !isRecord(fi.customMetadata)) {
    throw new TypeError('FileInfo customMetadata has to be object!');
  }

  if (fi.timestamp !== undefined && typeof fi.timestamp !== 'number') {
    throw new TypeError('timestamp property of FileInfo has to be number!');
  }

  if (fi.owner !== undefined && fi.owner.length !== EthAddress.LENGTH) {
    throw new TypeError('owner property of FileInfo has to be EthAddress!');
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

  if (!isStrictlyObject(item.fileInfo)) {
    throw new TypeError('ShareItem fileInfo has to be object!');
  }

  if (item.timestamp !== undefined && typeof item.timestamp !== 'number') {
    throw new TypeError('timestamp property of ShareItem has to be number!');
  }

  if (item.message !== undefined && typeof item.message !== 'string') {
    throw new TypeError('message property of ShareItem has to be string!');
  }
}

export function assertReferenceWithHistory(value: unknown): asserts value is ReferenceWithHistory {
  if (!isStrictlyObject(value)) {
    throw new TypeError('ReferenceWithHistory has to be object!');
  }

  const rwh = value as unknown as ReferenceWithHistory;

  if (rwh.reference === undefined || rwh.reference.length !== Reference.LENGTH) {
    throw new TypeError('reference property of ReferenceWithHistory has to be Reference!');
  }

  if (rwh.historyRef === undefined || rwh.historyRef.length !== Reference.LENGTH) {
    throw new TypeError('historyRef property of ReferenceWithHistory has to be Reference!');
  }
}

export function assertWrappedMantarayFeed(value: unknown): asserts value is WrappedMantarayFeed {
  if (!isStrictlyObject(value)) {
    throw new TypeError('WrappedMantarayFeed has to be object!');
  }

  assertReferenceWithHistory(value);

  const wmf = value as unknown as WrappedMantarayFeed;

  if (wmf.eFileRef !== undefined && wmf.eFileRef.length !== Reference.LENGTH) {
    throw new TypeError('eFileRef property of WrappedMantarayFeed has to be Reference!');
  }

  if (wmf.eGranteeRef !== undefined && wmf.eGranteeRef.length !== Reference.LENGTH) {
    throw new TypeError('eGranteeRef property of WrappedMantarayFeed has to be Reference!');
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
    options.headers = { 'swarm-act-history-address': historyRef.toHex() };
  }
  if (publisher !== undefined) {
    options.headers = {
      ...options.headers,
      'swarm-act-publisher': publisher.toHex(),
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

export function getRandomTopicHex(): Topic {
  return new Topic(getRandomBytes(Topic.LENGTH));
}

export function getRandomBytes(len: number): Buffer {
  return randomBytes(len);
}
