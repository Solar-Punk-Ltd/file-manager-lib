import { Reference } from '@upcoming/bee-js';
import nock from 'nock';

export const MOCK_SERVER_URL = 'http://localhost:1633';

// Endpoints
const FEED_ENDPOINT = '/feeds';
const SOC_ENDPOINT = '/soc';
const CHUNK_ENDPOINT = '/chunks';
const BYTES_ENDPOINT = '/bytes';

export function assertAllIsDone(): void {
  if (!nock.isDone()) {
    throw new Error('Some expected request was not performed!');
  }
}

export function fetchFeedUpdateMock(address: string, hashedTopic: string): nock.Interceptor {
  return nock(MOCK_SERVER_URL)
    .defaultReplyHeaders({
      'swarm-feed-index': '0',
      'swarm-feed-index-next': '1',
    })
    .get(`${FEED_ENDPOINT}/${address}/${hashedTopic}`);
  //.get(`${FEED_ENDPOINT}/${address}/${hashedTopic}?type=${type}`);
}

export function downloadDataMock(reference: Reference | string): nock.Interceptor {
  return nock(MOCK_SERVER_URL).get(`${BYTES_ENDPOINT}/${reference}`);
}

export function fetchChunkMock(reference: Reference | string): nock.Interceptor {
  return nock(MOCK_SERVER_URL).get(`${CHUNK_ENDPOINT}/${reference}`);
}

interface UploadOptions {
  name?: string;
  tag?: number;
  pin?: boolean;
  encrypt?: boolean;
  collection?: boolean;
  indexDocument?: string;
  errorDocument?: string;
}

function camelCaseToDashCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function uploadDataMock(
  batchId: string,
  options?: UploadOptions,
  extraHeaders?: Record<string, string>,
): nock.Interceptor {
  // Prefixes the options with `swarm-` so the object can be used for required headers
  const headers = Object.entries(options || {}).reduce<Record<string, string>>((prev, curr) => {
    prev[`swarm-${camelCaseToDashCase(curr[0])}`] = curr[1];

    return prev;
  }, {});

  return nock(MOCK_SERVER_URL, {
    reqheaders: { 'swarm-postage-batch-id': batchId, ...headers, ...extraHeaders },
  }).post(`${BYTES_ENDPOINT}`);
}

export function socPostMock(
  batchId: string,
  address: string,
  identifier: string,
  options?: UploadOptions,
  extraHeaders?: Record<string, string>,
): nock.Interceptor {
  // Prefixes the options with `swarm-` so the object can be used for required headers
  const headers = Object.entries(options || {}).reduce<Record<string, string>>((prev, curr) => {
    prev[`swarm-${camelCaseToDashCase(curr[0])}`] = curr[1];

    return prev;
  }, {});

  return nock(MOCK_SERVER_URL, {
    reqheaders: { 'swarm-postage-batch-id': batchId, ...headers, ...extraHeaders },
  })
    .defaultReplyHeaders({
      'swarm-tag': '123',
    })
    .post(`${SOC_ENDPOINT}/${address}/${identifier}`)
    .query((obj) => {
      return typeof obj.sig === 'string' && obj.sig.length > 0;
    });
}
