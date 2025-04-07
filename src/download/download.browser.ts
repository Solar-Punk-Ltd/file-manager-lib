import { BeeRequestOptions, DownloadOptions, PublicKey, Reference } from '@ethersphere/bee-js';
import { Types } from 'cafe-utility';

export async function downloadBrowser(
  resources: string[] | Reference[],
  apiUrl: string,
  endpoint: string,
  options?: DownloadOptions,
): Promise<ReadableStream<Uint8Array<ArrayBufferLike>>[]> {
  const dataStreams: ReadableStream<Uint8Array<ArrayBufferLike>>[] = [];
  for (const resource of resources) {
    const stream = await downloadReadableFetch(resource, apiUrl, endpoint, undefined, options);
    dataStreams.push(stream);
  }

  return dataStreams;
}

async function downloadReadableFetch(
  resource: string | Reference,
  apiUrl: string,
  endpoint: string,
  requestOptions?: BeeRequestOptions,
  options?: DownloadOptions,
): Promise<ReadableStream<Uint8Array>> {
  if (options) {
    options = prepareDownloadOptions(options);
  }

  const response = await fetch(`${apiUrl}/${endpoint}/${resource.toString()}`, {
    method: 'GET',
    headers: {
      ...requestOptions?.headers,
      ...prepareRequestHeaders(options),
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  if (!response.body) {
    throw new Error('ReadableStream is not supported in this environment.');
  }

  // eslint-disable-next-line no-console
  console.log('bagoy downloadReadableFetch response: ', response);

  // Return the ReadableStream directly
  return response.body;
}

// This was moved from bee-js, but unnecessary headers were removed
export function prepareRequestHeaders(nullableOptions?: unknown): Record<string, string> {
  const headers: Record<string, string> = {};

  if (!nullableOptions) {
    return headers;
  }

  const options = Types.asObject(nullableOptions);

  if (options.redundancyStrategy) {
    headers['swarm-redundancy-strategy'] = String(options.redundancyStrategy);
  }

  if (Types.isBoolean(options.fallback)) {
    headers['swarm-redundancy-fallback-mode'] = options.fallback.toString();
  }

  if (options.timeoutMs) {
    headers['swarm-chunk-retrieval-timeout'] = String(options.timeoutMs);
  }

  return headers;
}

// Copied from bee-js, exact function
function prepareDownloadOptions(value: unknown): DownloadOptions {
  const object = Types.asObject(value, { name: 'DownloadOptions' });

  return {
    redundancyStrategy: Types.asOptional(
      (x) => Types.asInteger(x, { name: 'redundancyStrategy' }),
      object.redundancyStrategy,
    ),
    fallback: Types.asOptional((x) => Types.asBoolean(x, { name: 'fallback' }), object.fallback),
    timeoutMs: Types.asOptional((x) => Types.asInteger(x, { name: 'timeoutMs', min: 0 }), object.timeoutMs),
    actPublisher: Types.asOptional((x) => new PublicKey(x), object.actPublisher),
    actHistoryAddress: Types.asOptional((x) => new Reference(x), object.actHistoryAddress),
    actTimestamp: Types.asOptional((x) => Types.asNumber(x, { name: 'actTimestamp' }), object.actTimestamp),
  };
}
