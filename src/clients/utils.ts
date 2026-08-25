import type { Bee, BeeRequestOptions, DownloadOptions, RedundancyLevel, RedundancyStrategy } from '@ethersphere/bee-js';
import { FeedIndex } from '@ethersphere/core-sdk';

import type { FeedIndexString, SwarmDownloadOptions, SwarmRequestOptions } from '../types/client/utils';
import { BeeVersionError } from '../utils/errors';

/**
 * Conversions from the backend-agnostic port vocabulary into **bee-js** types, for
 * {@link BeeClient} only. `SnahaClient` keeps its own equivalents as file-locals, because
 * `@snaha/swarm-id` exports several identically-named types (`DownloadOptions` above all) that are
 * *not* structurally interchangeable with bee-js's. Nothing here may reference the swarm-id SDK.
 */

export function toFeedIndex(index: FeedIndexString): FeedIndex {
  return FeedIndex.fromBigInt(BigInt(index));
}

export function toIndexString(index: FeedIndex): FeedIndexString {
  return index.toBigInt().toString();
}

export function toBeeRequestOptions(options?: SwarmRequestOptions): BeeRequestOptions | undefined {
  if (!options) return undefined;

  return { signal: options.signal, timeout: options.timeout, headers: options.headers };
}

export function toRedundancyLevel(level?: number): RedundancyLevel | undefined {
  return level === undefined ? undefined : (level as RedundancyLevel);
}

export function toDownloadOptions(options?: SwarmDownloadOptions): DownloadOptions | undefined {
  if (!options) return undefined;

  return {
    redundancyStrategy: options.redundancyStrategy as RedundancyStrategy | undefined,
    fallback: options.fallback,
  };
}

export async function verifySupportedBeeVersions(bee: Bee, requestOptions?: BeeRequestOptions): Promise<void> {
  const supportedApi = await bee.status.isSupportedApiVersion(requestOptions);

  if (!supportedApi) {
    throw new BeeVersionError('Bee or Bee API version not supported');
  }
}
