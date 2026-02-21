import { Bee, BeeRequestOptions, Bytes, DownloadOptions, Reference } from '@ethersphere/bee-js';
import { isNode } from 'std-env';

const bytesEndpoint = 'bytes';

export async function processDownload(
  bee: Bee,
  resources: string[] | Reference[],
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReadableStream<Uint8Array>[] | Bytes[]> {
  if (isNode) {
    const { downloadNode } = await import('./download.node');
    return await downloadNode(bee, Object.values(resources), options, requestOptions);
  }

  const { downloadBrowser } = await import('./download.browser');
  return await downloadBrowser(Object.values(resources), bee.url, bytesEndpoint, options, requestOptions);
}
