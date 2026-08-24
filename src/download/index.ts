import { type Bee, type BeeRequestOptions, type DownloadOptions } from '@ethersphere/bee-js';

import { type DownloadFilesResult, type DownloadResource, type DownloadResult } from '../types/download';
import { type FailedResult } from '../types/utils';
import { errorMessage, settlePromises } from '../utils/common';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export async function processDownload(
  bee: Bee,
  resources: DownloadResource[],
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<DownloadFilesResult> {
  requestOptions?.signal?.throwIfAborted();
  const succeeded: DownloadResult[] = [];
  const failed: FailedResult[] = [];

  await settlePromises(
    resources.map(async (r) => {
      return await bee.downloadReadableData(
        r.reference,
        { ...options, actHistoryAddress: r.actHistoryAddress, actPublisher: r.actPublisher },
        requestOptions,
      );
    }),
    (value, ix) => succeeded.push({ path: resources[ix].path, result: value }),
    (reason, ix) => {
      if (requestOptions?.signal?.aborted) return;
      const message = errorMessage(reason);
      logger.error(`processDownload: failed to fetch ${resources[ix].path}: ${message}`);
      failed.push({ path: resources[ix].path, error: message });
    },
  );

  requestOptions?.signal?.throwIfAborted();

  return { succeeded, failed };
}
