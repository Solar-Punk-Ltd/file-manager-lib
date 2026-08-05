import { BatchId, Bee, BeeRequestOptions, PrivateKey, RedundancyLevel } from '@ethersphere/bee-js';
import * as fs from 'fs';
import path from 'path';

import { EventEmitter } from '@/eventEmitter';
import { FileManagerBase } from '@/fileManager';
import { BeeClient } from '@/swarm';
import { FileManagerEvents } from '@/utils';

// bee-factory queen node
export const BEE_URL = 'http://127.0.0.1:1633';
// bee-factory worker 1 — a non-admin peer
export const OTHER_BEE_URL = 'http://127.0.0.1:1635';
export const DEFAULT_BATCH_DEPTH = 21;
export const DEFAULT_BATCH_AMOUNT = '500000000';
export const DEFAULT_MOCK_SIGNER = new PrivateKey('634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd');
export const OTHER_MOCK_SIGNER = new PrivateKey('734fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cd7');
export const DUMMY_BATCH_ID = 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';

export function getTestFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8');
}

export async function readFilesOrDirectory(fullPath: string, name?: string): Promise<string[]> {
  const isDir = fs.lstatSync(fullPath).isDirectory();
  if (!isDir) {
    if (!name) return [fullPath];
    return [fullPath.substring(fullPath.indexOf(name))];
  }

  const subdirs = await fs.promises.readdir(fullPath, {
    withFileTypes: true,
    encoding: 'utf-8',
  });
  const files = await Promise.all(
    subdirs.map(async (subdir) => {
      const res = path.resolve(fullPath, subdir.name);
      if (subdir.isDirectory()) {
        return readFilesOrDirectory(res, name);
      } else {
        return res;
      }
    }),
  );
  const relativeFilePaths = files.flat().map((f) => {
    if (!name) return f;
    return f.substring(f.indexOf(name));
  });
  return relativeFilePaths;
}

export async function streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const buffer = await new Response(stream).arrayBuffer();

  return new Uint8Array(buffer);
}

export async function retryOnPropagationDelay<T>(fn: () => Promise<T>, attempts = 5, delayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export async function createInitializedFileManager(
  client: BeeClient = new BeeClient(new Bee(BEE_URL), DEFAULT_MOCK_SIGNER),
  batchId?: string | BatchId,
  emitter?: EventEmitter,
): Promise<FileManagerBase> {
  const fm = new FileManagerBase(client, emitter);

  let isFirstInit = true;
  fm.emitter.on(FileManagerEvents.INITIALIZED, (ok: boolean) => {
    if (isFirstInit) {
      expect(ok).toBe(true);
      isFirstInit = false;
    }
  });

  await fm.initialize();

  if (!fm.driveList.some((d) => d.isAdmin)) {
    await fm.createAdminDrive(batchId ?? DUMMY_BATCH_ID, RedundancyLevel.MEDIUM);
  }

  return fm;
}

export async function buyStamp(
  bee: Bee,
  amount: string | bigint,
  depth: number,
  label?: string,
  requestOptions?: BeeRequestOptions,
): Promise<BatchId> {
  const stamp = (await bee.getPostageBatches(requestOptions)).find((b) => b.label === label);
  if (stamp && stamp.usable) {
    return stamp.batchID;
  }

  return await bee.createPostageBatch(amount, depth, {
    waitForUsable: true,
    label,
  });
}
