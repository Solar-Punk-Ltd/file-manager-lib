import { Bee, Bytes, Reference } from '@ethersphere/bee-js';
import { downloadNode } from './download.node';
import { downloadBrowser } from './download.browser';
import { isNode } from 'std-env';

const bytesEndpoint = 'bytes';

export async function processDownload(
  bee: Bee,
  resources: string[] | Reference[],
): Promise<ReadableStream<Uint8Array>[] | Bytes[]> {
  if (isNode) {
    return await downloadNode(bee, Object.values(resources));
  }

  return await downloadBrowser(Object.values(resources), bee.url, bytesEndpoint);
}
