import {
  BeeRequestOptions,
  ENCRYPTED_REFERENCE_HEX_LENGTH,
  Reference,
  REFERENCE_BYTES_LENGTH,
  REFERENCE_HEX_LENGTH,
  Topic,
  TOPIC_BYTES_LENGTH,
  TOPIC_HEX_LENGTH,
  Utils,
} from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';
import { randomBytes } from 'crypto';
import path from 'path';

import { FileInfo, Index, ReferenceWithHistory, ShareItem, WrappedMantarayFeed } from './types';

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

export function assertReference(value: unknown): asserts value is Reference {
  try {
    Utils.assertHexString(value, REFERENCE_HEX_LENGTH);
  } catch (e) {
    Utils.assertHexString(value, ENCRYPTED_REFERENCE_HEX_LENGTH);
  }
}

export function assertTopic(value: unknown): asserts value is Topic {
  if (!Utils.isHexString(value, TOPIC_HEX_LENGTH)) {
    throw `Invalid feed topic: ${value}`;
  }
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

  assertReference(fi.eFileRef);

  if (fi.batchId === undefined || typeof fi.batchId !== 'string') {
    throw new TypeError('batchId property of FileInfo has to be string!');
  }

  if (fi.historyRef !== undefined) {
    assertReference(fi.historyRef);
  }

  if (fi.topic !== undefined) {
    assertTopic(fi.topic);
  }

  if (fi.customMetadata !== undefined && !isRecord(fi.customMetadata)) {
    throw new TypeError('FileInfo customMetadata has to be object!');
  }

  if (fi.timestamp !== undefined && typeof fi.timestamp !== 'number') {
    throw new TypeError('timestamp property of FileInfo has to be number!');
  }

  if (fi.owner !== undefined && !Utils.isHexEthAddress(fi.owner)) {
    throw new TypeError('owner property of FileInfo has to be string!');
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

  assertReference(rwh.historyRef);

  assertReference(rwh.reference);
}

export function assertWrappedMantarayFeed(value: unknown): asserts value is WrappedMantarayFeed {
  if (!isStrictlyObject(value)) {
    throw new TypeError('WrappedMantarayFeed has to be object!');
  }

  assertReferenceWithHistory(value);

  const wmf = value as unknown as WrappedMantarayFeed;

  if (wmf.eFileRef !== undefined) {
    assertReference(wmf.eFileRef);
  }

  if (wmf.eGranteeRef !== undefined) {
    assertReference(wmf.eGranteeRef);
  }
}

export function decodeBytesToPath(bytes: Uint8Array): string {
  if (bytes.length !== REFERENCE_BYTES_LENGTH) {
    const paddedBytes = new Uint8Array(REFERENCE_BYTES_LENGTH);
    paddedBytes.set(bytes.slice(0, REFERENCE_BYTES_LENGTH)); // Truncate or pad the input to ensure it's 32 bytes
    bytes = paddedBytes;
  }
  return new TextDecoder().decode(bytes);
}

export function encodePathToBytes(pathString: string): Uint8Array {
  return new TextEncoder().encode(pathString);
}

export function makeBeeRequestOptions(
  historyRef?: string,
  publisher?: string,
  timestamp?: number,
  act?: boolean,
): BeeRequestOptions {
  const options: BeeRequestOptions = {};
  if (historyRef !== undefined) {
    options.headers = { 'swarm-act-history-address': historyRef };
  }
  if (publisher !== undefined) {
    options.headers = {
      ...options.headers,
      'swarm-act-publisher': publisher,
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

export function numberToFeedIndex(index: number | undefined): string | undefined {
  if (index === undefined) {
    return undefined;
  }
  const bytes = new Uint8Array(8);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(4, index);

  return Utils.bytesToHex(bytes);
}

export function makeNumericIndex(index: Index): number {
  if (index instanceof Uint8Array) {
    return Binary.uint64BEToNumber(index);
  }

  if (typeof index === 'string') {
    const base = 16;
    const ix = parseInt(index, base);
    if (isNaN(ix)) {
      throw new TypeError(`Invalid index: ${index}`);
    }
    return ix;
  }

  if (typeof index === 'number') {
    return index;
  }

  throw new TypeError(`Unknown type of index: ${index}`);
}

// status is undefined in the error object
// Determines if the error is about 'Not Found'
export function isNotFoundError(error: any): boolean {
  return error.stack.includes('404') || error.message.includes('Not Found') || error.message.includes('404');
}

export function getRandomTopicHex(): Topic {
  return Utils.bytesToHex(getRandomBytes(TOPIC_BYTES_LENGTH), TOPIC_HEX_LENGTH);
}

export function getRandomBytes(len: number): Buffer {
  return randomBytes(len);
}
