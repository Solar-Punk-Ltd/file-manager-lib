import { PostageBatch } from '@ethersphere/bee-js';

import { StampError } from './errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isNotFoundError(error: any): boolean {
  return error.stack?.includes('404') || error.message?.includes('Not Found') || error.message?.includes('404');
}

export async function settlePromises<T>(
  promises: Promise<T>[],
  cb: (value: T, index: number) => void,
  onError?: (reason: unknown, index: number) => void,
): Promise<void> {
  const results = await Promise.allSettled(promises);
  results.forEach((result, ix) => {
    if (result.status === 'fulfilled') {
      cb(result.value, ix);
    } else {
      if (onError) {
        onError(result.reason, ix);
      } else {
        console.error(`Failed to resolve promise: ${result.reason}`);
      }
    }
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
