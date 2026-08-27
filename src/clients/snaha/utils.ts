import type { DownloadOptions } from '@snaha/swarm-id';
import type { Readable } from 'stream';

import type { SwarmDownloadOptions, SwarmRequestOptions } from '../../types/utils';
import { isNotFoundError } from '../../utils/common';
import { FileError } from '../../utils/errors';

/**
 * Options passed to `@snaha/swarm-id`. Structurally what its `RequestOptions` is today, declared
 * locally so the value-level package never has to be imported — see the packaging note on
 * {@link SnahaClient}.
 */
export interface SnahaRequestOptions {
  timeout?: number;
  headers?: Record<string, string>;
}

/**
 * swarm-id prefixes feed payloads with a timestamp unless told otherwise. fm-lib needs its payloads
 * back byte-for-byte, so it is disabled on both the read and the write side.
 */
export const HAS_TIMESTAMP = false;

/**
 * An empty sequential feed reports its own message rather than a 404 — a missing update at an
 * explicitly requested index still surfaces as one.
 */
export function isFeedNotFound(err: unknown): boolean {
  return isNotFoundError(err) || (err as Error)?.message?.includes('Sequential feed has no updates');
}

export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/** swarm-id takes bytes only — `File`/`Blob` sources have to be buffered up front. */
export async function toBytesAsync(data: Uint8Array | string | Blob | Readable): Promise<Uint8Array> {
  if (typeof data === 'string' || data instanceof Uint8Array) {
    return toBytes(data);
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  // The Node upload path cannot reach this backend — swarm-id needs a browser to host its iframe.
  throw new FileError('Node streams are not supported by the Swarm ID backend');
}

export function toStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(data);
      controller.close();
    },
  });
}

export function toSnahaRequestOptions(options?: SwarmRequestOptions): SnahaRequestOptions | undefined {
  // `signal` is deliberately dropped — swarm-id has no equivalent across the postMessage boundary.
  if (!options) return undefined;

  return { timeout: options.timeout, headers: options.headers };
}

/**
 * The port types redundancy strategy as a plain `number` while swarm-id narrows it to the literal
 * union `0 | 1 | 2 | 3`, so that one field needs a cast. Everything else checks normally — the ACT
 * fields are simply left unset, since protected reads go through `actDownloadData` instead.
 */
export function toDownloadOptions(options?: SwarmDownloadOptions): DownloadOptions | undefined {
  if (!options) return undefined;

  return {
    redundancyStrategy: options.redundancyStrategy as NonNullable<DownloadOptions>['redundancyStrategy'],
    fallback: options.fallback,
  };
}
