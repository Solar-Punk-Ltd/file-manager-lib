import { Bytes } from '@ethersphere/core-sdk';

export function generateRandomBytes(len: number): Bytes {
  const arr = new Uint8Array(len);
  globalThis.crypto.getRandomValues(arr);
  return new Bytes(arr);
}
