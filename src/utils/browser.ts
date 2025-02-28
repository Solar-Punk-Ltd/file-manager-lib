import { Bytes } from '@upcoming/bee-js';

import {
  assertFileInfo,
  assertShareItem,
  assertWrappedFileInoFeed,
  buyStamp,
  isNotFoundError,
  makeBeeRequestOptions,
} from './common';

export { assertFileInfo, assertShareItem, assertWrappedFileInoFeed, buyStamp, isNotFoundError, makeBeeRequestOptions };

export function getRandomBytes(len: number): Bytes {
  const arr = new Uint8Array(len);
  window.crypto.getRandomValues(arr);
  return new Bytes(arr);
}
