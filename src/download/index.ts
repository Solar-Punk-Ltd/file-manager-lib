import { Bee, BeeRequestOptions, DownloadOptions } from '@ethersphere/bee-js';

import { DownloadResource, DownloadResult } from '../types/download';
import { settlePromises } from '../utils/common';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export async function processDownload(
  bee: Bee,
  resources: DownloadResource[],
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<DownloadResult[]> {
  requestOptions?.signal?.throwIfAborted();
  const results: DownloadResult[] = [];

  await settlePromises(
    resources.map(async (r) => {
      return await bee.downloadReadableData(
        r.reference,
        { ...options, actHistoryAddress: r.actHistoryAddress, actPublisher: r.actPublisher },
        requestOptions,
      );
    }),
    (value, ix) => results.push({ path: resources[ix].path, result: value }),
    (reason, ix) => {
      if (requestOptions?.signal?.aborted) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger.error(`processDownload: failed to fetch ${resources[ix].path}: ${(reason as any)?.message || reason}`);
    },
  );

  requestOptions?.signal?.throwIfAborted();

  return results;
}
