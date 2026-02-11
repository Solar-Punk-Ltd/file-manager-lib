import { Bee, Bytes, Reference } from '@ethersphere/bee-js';
import { isNode } from 'std-env';

const bytesEndpoint = 'bytes';

export async function processDownload(
  bee: Bee,
  resources: string[] | Reference[],
): Promise<ReadableStream<Uint8Array>[] | Bytes[]> {
  if (isNode) {
    const { downloadNode } = await import('./download.node');
    return await downloadNode(bee, Object.values(resources));
  }

  const { downloadBrowser } = await import('./download.browser');
  return await downloadBrowser(Object.values(resources), bee.url, bytesEndpoint);
}
