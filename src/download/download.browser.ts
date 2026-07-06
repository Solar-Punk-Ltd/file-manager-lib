import { Bee, BeeRequestOptions, DownloadOptions, PublicKey, Reference } from '@ethersphere/bee-js';
import { Types } from 'cafe-utility';

import { DownloadResource, DownloadResult } from '../types';
import { settlePromises } from '../utils/common';

async function downloadReadableFetch(
  resource: string,
  apiUrl: string,
  endpoint: string,
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<ReadableStream<Uint8Array>> {
  if (options) {
    options = prepareDownloadOptions(options);
  }

  const response = await fetch(`${apiUrl}/${endpoint}/${resource}`, {
    method: 'GET',
    headers: {
      ...requestOptions?.headers,
      ...prepareRequestHeaders(options),
    },
    signal: requestOptions?.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  if (!response.body) {
    throw new Error('ReadableStream is not supported in this environment.');
  }

  return response.body;
}

// This was moved from bee-js, but unnecessary headers were removed
function prepareRequestHeaders(nullableOptions?: unknown): Record<string, string> {
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

  if (options.actPublisher) {
    const publisher =
      options.actPublisher instanceof PublicKey ? options.actPublisher : new PublicKey(options.actPublisher as string);
    headers['swarm-act-publisher'] = publisher.toCompressedHex();
    headers['swarm-act'] = 'true';
  }

  if (options.actHistoryAddress) {
    const history =
      options.actHistoryAddress instanceof Reference
        ? options.actHistoryAddress
        : new Reference(options.actHistoryAddress as string);
    headers['swarm-act-history-address'] = history.toHex();
    headers['swarm-act'] = 'true';
  }

  if (options.actTimestamp) {
    headers['swarm-act-timestamp'] = String(options.actTimestamp);
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

export async function downloadBrowser(
  bee: Bee,
  resources: DownloadResource[],
  endpoint: string,
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];

  await settlePromises(
    resources.map(async (r) => {
      const rawRef = await bee.downloadData(
        r.reference,
        { ...options, actHistoryAddress: r.actHistoryAddress, actPublisher: r.actPublisher },
        requestOptions,
      );

      const contentRef = new Reference(rawRef.toUint8Array());

      return await downloadReadableFetch(contentRef.toString(), bee.url, endpoint, options, requestOptions);
    }),
    (value, ix) => results.push({ path: resources[ix].path, result: value }),
    (reason, ix) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error(`downloadBrowser: failed to fetch ${resources[ix].path}: ${(reason as any)?.message || reason}`),
  );

  return results;
}
