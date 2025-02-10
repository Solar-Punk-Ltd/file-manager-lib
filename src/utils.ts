import { BatchId, BeeRequestOptions, Reference, Topic, Utils, MantarayNode } from '@upcoming/bee-js';
import path from 'path';

import { FileInfo, Index, ShareItem } from './types';
import { createMockMantarayNode } from '../tests/mockHelpers';

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

export function assertShareItem(value: unknown): asserts value is ShareItem {
  if (!isStrictlyObject(value)) {
    throw new TypeError('ShareItem has to be object!');
  }

  const item = value as unknown as ShareItem;

  if (!Array.isArray(item.fileInfoList)) {
    throw new TypeError('ShareItem fileInfoList has to be array!');
  }

  if (item.timestamp !== undefined && typeof item.timestamp !== 'number') {
    throw new TypeError('timestamp property of ShareItem has to be number!');
  }

  if (item.message !== undefined && typeof item.message !== 'string') {
    throw new TypeError('message property of ShareItem has to be string!');
  }
}

export function decodeBytesToPath(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    const paddedBytes = new Uint8Array(32);
    paddedBytes.set(bytes.slice(0, 32)); // Truncate or pad the input to ensure it's 32 bytes
    bytes = paddedBytes;
  }
  return new TextDecoder().decode(bytes);
}

export function encodePathToBytes(pathString: string): Uint8Array {
  return new TextEncoder().encode(pathString);
}

export function makeBeeRequestOptions(historyRef?: string, publisher?: string, timestamp?: number): BeeRequestOptions {
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

export const mockSaver = async (data: Reference, options?: { ecrypt?: boolean }): Promise<Uint8Array> => {
  const hexRef = '9'.repeat(64);
  return Utils.hexToBytes(hexRef);
}

export const mockLoader = (reference: Reference): Promise<Uint8Array> => {
  // this was created in mantaray-js, in test should serialize/deserialize the same as Bee'
  //const mantarayJson = "[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,87,104,179,182,167,219,86,210,29,26,191,244,13,65,206,191,200,52,72,254,216,215,233,176,110,192,211,176,115,242,143,32,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,128,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,18,1,47,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,133,4,242,161,7,202,148,11,234,252,76,226,246,201,169,240,150,140,98,165,181,137,63,240,228,225,226,152,48,72,210,118,0,62,123,34,119,101,98,115,105,116,101,45,105,110,100,101,120,45,100,111,99,117,109,101,110,116,34,58,34,105,110,100,101,120,46,104,116,109,108,34,125,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,4,1,105,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,193,70,83,232,215,71,198,220,109,222,253,57,104,131,145,24,158,104,98,54,174,195,97,99,123,34,213,241,56,50,159,92]";
  createMockMantarayNode();
  const x = new MantarayNode()
  MantarayNode.unmarshal()
  const uint8Array = new Uint8Array(JSON.parse(mantarayJson));


  return Promise.resolve(uint8Array);
}

export function assertReference(value: unknown): asserts value is Reference {
  if (typeof value !== 'string') {
    // this is a mock
    throw new TypeError('Reference has to be string!');
  }
  //try {
  //  Utils.assertHexString(value, REFERENCE_HEX_LENGTH);
  //} catch (e) {
  //  Utils.assertHexString(value, ENCRYPTED_REFERENCE_HEX_LENGTH);
  //}
}

export function assertBatchId(value: unknown): asserts value is BatchId {
  Utils.assertHexString(value, BATCH_ID_HEX_LENGTH);
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

export function assertTopic(value: unknown): asserts value is Topic {
  if (!Utils.isHexString(value, TOPIC_HEX_LENGTH)) {
    throw `Invalid feed topic: ${value}`;
  }
}