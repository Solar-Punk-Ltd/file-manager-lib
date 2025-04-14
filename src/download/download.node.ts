import { Bee, Bytes, DownloadOptions, Reference } from '@ethersphere/bee-js';

export async function downloadNode(
  bee: Bee,
  resources: string[] | Reference[],
  options?: DownloadOptions,
): Promise<Bytes[]> {
  const dataPromises: Promise<Bytes>[] = [];
  for (const resource of resources) {
    dataPromises.push(bee.downloadData(resource, options));
  }

  const files: Bytes[] = [];
  await Promise.allSettled(dataPromises).then((results) => {
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        files.push(result.value);
      } else {
        console.error(`Failed to dowload file(s): ${result.reason}`);
      }
    });
  });

  return files;
}
