import { Bee, BeeRequestOptions, DownloadOptions, Reference } from '@ethersphere/bee-js';

import { DownloadResource, DownloadResult } from '../types';
import { settlePromises } from '../utils/common';

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
      const rawRef = await bee.downloadData(
        r.reference,
        { ...options, actHistoryAddress: r.actHistoryAddress, actPublisher: r.actPublisher },
        requestOptions,
      );

      const contentRef = new Reference(rawRef.toUint8Array());

      return await bee.downloadReadableData(
        contentRef.toString(),
        { ...options, actHistoryAddress: undefined, actPublisher: undefined },
        requestOptions,
      );
    }),
    (value, ix) => results.push({ path: resources[ix].path, result: value }),
    (reason, ix) => {
      if (requestOptions?.signal?.aborted) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error(`processDownload: failed to fetch ${resources[ix].path}: ${(reason as any)?.message || reason}`);
    },
  );

  requestOptions?.signal?.throwIfAborted();

  return results;
}
