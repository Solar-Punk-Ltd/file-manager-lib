import { Bytes } from '@ethersphere/bee-js';
import { isNode } from 'std-env';

export async function generateRandomBytes(len: number): Promise<Bytes> {
  if (isNode) {
    const { getRandomBytesNode } = await import('./crypto.node');
    return await getRandomBytesNode(len);
  }

  const { getRandomBytesBrowser } = await import('./crypto.browser');
  return getRandomBytesBrowser(len);
}
