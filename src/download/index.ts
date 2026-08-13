import type { BeeRequestOptions, DownloadOptions } from '@ethersphere/bee-js';

import { type DownloadFilesResult, type DownloadResource, type DownloadResult } from '../types/download';
import type { SwarmClient } from '../types/swarmClient';
import type { FailedResult } from '../types/utils';
import { settlePromises } from '../utils/common';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export async function processDownload(
  swarmClient: SwarmClient,
  resources: DownloadResource[],
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<DownloadFilesResult> {
  requestOptions?.signal?.throwIfAborted();
  const succeeded: DownloadResult[] = [];
  const failed: FailedResult[] = [];

  await settlePromises(
    resources.map(async (r) => {
      return await swarmClient.downloadProtectedStream(
        { reference: r.reference, historyRef: r.actHistoryAddress, publisher: r.actPublisher.toString() },
        undefined,
        options,
        requestOptions,
      );
    }),
    (value, ix) => succeeded.push({ path: resources[ix].path, result: value }),
    (reason, ix) => {
      if (requestOptions?.signal?.aborted) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = (reason as any)?.message || String(reason);
      logger.error(`processDownload: failed to fetch ${resources[ix].path}: ${message}`);
      failed.push({ path: resources[ix].path, error: message });
    },
  );

  requestOptions?.signal?.throwIfAborted();

  return { succeeded, failed };
}
