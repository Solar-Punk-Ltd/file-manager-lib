import { Bee, DownloadOptions, Reference } from '@ethersphere/bee-js';

export async function downloadBrowser(
  bee: Bee,
  resources: string[] | Reference[],
  options?: DownloadOptions,
): Promise<ReadableStream<Uint8Array<ArrayBufferLike>>[]> {
  const dataStreams: ReadableStream<Uint8Array<ArrayBufferLike>>[] = [];
  for (const resource of resources) {
    const stream = await bee.downloadReadableDataFetch(resource, options);
    dataStreams.push(stream);
  }

  return dataStreams;
}

// async function downloadReadableFetch(
//   requestOptions: BeeRequestOptions,
//   resource: string | Reference,
//   options?: DownloadOptions,
// ): Promise<ReadableStream<Uint8Array>> {
//   if (options) {
//     options = prepareDownloadOptions(options);
//   }

//   const endpoint = 'bytes';
//   const apiUrl = 'http://localhost:1633';

//   const response = await fetch(`http://localhost:1633/${endpoint}/${resource.toString()}`, {
//     method: 'GET',
//     headers: {
//       ...requestOptions.headers,
//       ...prepareRequestHeaders(null, options),
//     },
//   });

//   if (!response.ok) {
//     throw new Error(`HTTP error! status: ${response.status}`);
//   }

//   if (!response.body) {
//     throw new Error('ReadableStream is not supported in this environment.');
//   }

//   // eslint-disable-next-line no-console
//   console.log('bagoy downloadReadableFetch response: ', response);

//   // Return the ReadableStream directly
//   return response.body;
// }
