import { Bytes } from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import { getRandomBytesBrowser } from './crypto.browser';
import { getRandomBytesNode } from './crypto.node';

export async function generateRandomBytes(len: number): Promise<Bytes> {
  if (isNode) {
    return await getRandomBytesNode(len);
  }

  return getRandomBytesBrowser(len);
}
