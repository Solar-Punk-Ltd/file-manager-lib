import { Bee, BeeRequestOptions, DownloadOptions, Reference } from '@ethersphere/bee-js';

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
    resources.map(async (r) => {
      // Hop 1: ACT-decrypt the wrapper to get the raw 32-byte content reference
      const rawRef = await bee.downloadData(
        r.reference,
        { ...options, actHistoryAddress: r.actHistoryAddress, actPublisher: r.actPublisher },
        requestOptions,
      );
      // Hop 2: fetch the real content (plaintext, content-addressed — no ACT)
      const contentRef = new Reference(rawRef.toUint8Array());
      return await bee.downloadData(contentRef, options, requestOptions);
    }),
    (value, ix) => results.push({ path: resources[ix].path, result: value }),
    (reason, ix) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error(`downloadNode: failed to fetch ${resources[ix].path}: ${(reason as any)?.message || reason}`),
  );
  return results;
}
