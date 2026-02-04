import { Bee, BeeRequestOptions, Bytes, DownloadOptions, Reference } from '@ethersphere/bee-js';
import { settlePromises } from '../utils/common';

export async function downloadNode(
  bee: Bee,
  resources: string[] | Reference[],
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<Bytes[]> {
  const dataPromises: Promise<Bytes>[] = [];
  for (const resource of resources) {
    dataPromises.push(bee.downloadData(resource, options, requestOptions));
  }

  const files: Bytes[] = [];
  await settlePromises<Bytes>(dataPromises, (value) => {
    files.push(value);
  });

  return files;
}
