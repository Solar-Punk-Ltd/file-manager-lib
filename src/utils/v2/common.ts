import { DriveInfo, NodeStatus } from '../../types/v2/info';
import { Logger } from '../logger';

const logger = Logger.getInstance();
// TODO: can this be used in config? --> config: max num of parallel down/up ops ?
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

export const getRecordStatus = (drive: DriveInfo, topic: string): NodeStatus => {
  const isFoundInTrash = !!drive.trashedNodes?.some((n) => n.topic === topic);
  return isFoundInTrash ? NodeStatus.Trashed : NodeStatus.Active;
};
