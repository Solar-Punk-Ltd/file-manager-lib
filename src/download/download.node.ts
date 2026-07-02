import { Bee, BeeRequestOptions, DownloadOptions } from '@ethersphere/bee-js';

import { DownloadResource, DownloadResult } from '../types';
import { settlePromises } from '../utils/common';

export async function downloadNode(
  bee: Bee,
  resources: DownloadResource[],
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  await settlePromises(
    resources.map((r) =>
      bee.downloadData(
        r.reference,
        { ...options, actHistoryAddress: r.actHistoryAddress, actPublisher: r.actPublisher },
        requestOptions,
      ),
    ),
    (value, ix) => results.push({ path: resources[ix].path, result: value }),
    (reason, ix) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error(`downloadNode: failed to fetch ${resources[ix].path}: ${(reason as any)?.message || reason}`),
  );
  return results;
}
