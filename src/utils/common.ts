import { NodeStatus } from '../types/info';

import { Logger } from './logger';
import { isTrashPath } from './path';

const logger = Logger.getInstance();

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
          logger.error(`Failed to resolve task ${ix}: ${reason}`);
        }
      }
    }
  };
  const pool = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(pool);
}

export const joinPath = (base: string, name: string): string => {
  return base ? `${base}/${name}` : name;
};

export const getRecordStatus = (recordPath: string): NodeStatus => {
  return isTrashPath(recordPath) ? NodeStatus.Trashed : NodeStatus.Active;
};

const HTTP_NOT_FOUND = 404;

const toStatusCode = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
};

export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const { status, response } = error as { status?: unknown; response?: { status?: unknown } };

  return toStatusCode(status) === HTTP_NOT_FOUND || toStatusCode(response?.status) === HTTP_NOT_FOUND;
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
        logger.error(`Failed to resolve promise: ${result.reason}`);
      }
    }
  });
}
