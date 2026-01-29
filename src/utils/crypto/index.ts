import { Bytes } from '@ethersphere/bee-js';
import { isNode } from 'std-env';
import { getRandomBytesNode } from './crypto.node';
import { getRandomBytesBrowser } from './crypto.browser';

export async function generateRandomBytes(len: number): Promise<Bytes> {
  if (isNode) {
    return await getRandomBytesNode(len);
  }

  return getRandomBytesBrowser(len);
}
