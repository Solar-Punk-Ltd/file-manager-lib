import { DriveInfo, NodeStatus } from '../types/info';

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

export async function awaitAllPromisesBounded<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  cb: (value: T, index: number) => void,
  onError?: (reason: unknown, index: number) => void,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const ix = cursor++;
      try {
        const value = await tasks[ix]();
        cb(value, ix);
      } catch (reason) {
        if (onError) {
          onError(reason, ix);
        } else {
          console.error(`Failed to resolve task ${ix}: ${reason}`);
        }
      }
    }
  };
  const pool = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(pool);
}

export const getEncodedSize = (input: string): number => {
  return new TextEncoder().encode(input).length;
};

export const joinPath = (base: string, name: string): string => {
  return base ? `${base}/${name}` : name;
};

export const getRecordStatus = (drive: DriveInfo, topic: string): NodeStatus => {
  const isFoundInTrash = !!drive.trashedNodes?.some((n) => n.topic === topic);
  return isFoundInTrash ? NodeStatus.Trashed : NodeStatus.Active;
};
