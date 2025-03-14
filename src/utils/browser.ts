import { Bytes } from '@upcoming/bee-js';

export function getRandomBytes(len: number): Bytes {
  const arr = new Uint8Array(len);
  window.crypto.getRandomValues(arr);
  return new Bytes(arr);
}
