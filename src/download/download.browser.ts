import { BeeRequestOptions, DownloadOptions, Reference } from '@ethersphere/bee-js';

import { downloadReadableFetch } from '../utils/browser';

export async function downloadBrowser(
  resources: string[] | Reference[],
  apiUrl: string,
  endpoint: string,
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReadableStream<Uint8Array>[]> {
  const dataStreams: ReadableStream<Uint8Array>[] = [];

  for (const resource of resources) {
    const stream = await downloadReadableFetch(resource, apiUrl, endpoint, requestOptions, options);
    dataStreams.push(stream);
  }

  return dataStreams;
}
