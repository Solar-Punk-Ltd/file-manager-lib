import { Bytes } from '@ethersphere/bee-js';

export function generateRandomBytes(len: number): Bytes {
  const arr = new Uint8Array(len);
  globalThis.crypto.getRandomValues(arr);
  return new Bytes(arr);
}
