import { Bee, BeeRequestOptions, DownloadOptions } from '@ethersphere/bee-js';
import { isNode } from 'std-env';

import { DownloadResource, DownloadResult } from '../types';

const bytesEndpoint = 'bytes';

export async function processDownload(
  bee: Bee,
  resources: DownloadResource[],
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<DownloadResult[]> {
  if (isNode) {
    const { downloadNode } = await import('./download.node');
    return downloadNode(bee, resources, options, requestOptions);
  }

  const { downloadBrowser } = await import('./download.browser');
  return downloadBrowser(resources, bee.url, bytesEndpoint, options, requestOptions);
}
