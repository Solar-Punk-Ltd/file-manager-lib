import { Bytes } from '@ethersphere/bee-js';

export function getRandomBytesBrowser(len: number): Bytes {
  const arr = new Uint8Array(len);
  window.crypto.getRandomValues(arr);
  return new Bytes(arr);
}
