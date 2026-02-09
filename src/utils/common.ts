import { Bytes, PostageBatch } from '@ethersphere/bee-js';

import { StampError } from './errors';
import { getRandomBytesNode } from './node';
import { getRandomBytesBrowser } from './browser';
import { isNode } from 'std-env';

export function generateRandomBytes(len: number): Bytes {
  if (isNode) {
    return getRandomBytesNode(len);
  }
  return getRandomBytesBrowser(len);
}

export function isNotFoundError(error: any): boolean {
  return error.stack?.includes('404') || error.message?.includes('Not Found') || error.message?.includes('404');
}

export async function settlePromises<T>(promises: Promise<T>[], cb: (value: T) => void): Promise<void> {
  await Promise.allSettled(promises).then((results) => {
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        cb(result.value);
      } else {
        console.error(`Failed to resolve promise: ${result.reason}`);
      }
    });
  });
}

export const getEncodedSize = (input: string): number => {
  return new TextEncoder().encode(input).length;
};

export const verifyStampUsability = (s: PostageBatch | undefined, batchId?: string): PostageBatch => {
  if (!s || !s.usable) {
    throw new StampError(`Stamp with batchId: ${batchId?.slice(0, 6)}... not found OR not usable`);
  }

  return s;
};
