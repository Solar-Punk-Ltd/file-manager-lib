import { BatchId, Bee, MantarayNode, PrivateKey } from '@upcoming/bee-js';
import { readFileSync } from 'fs';
import path from 'path';

export const BEE_URL = 'http://localhost:1633';
export const OTHER_BEE_URL = 'http://localhost:1733';
export const DEFAULT_BATCH_DEPTH = 21;
export const DEFAULT_BATCH_AMOUNT = '500000000';
export const MOCK_SIGNER = new PrivateKey('634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd');
export const OTHER_MOCK_SIGNER = new PrivateKey('734fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cd7');

export async function buyStamp(bee: Bee, label?: string): Promise<BatchId> {
  const ownerStamp = (await bee.getAllPostageBatch()).find(async (b) => {
    b.label === label;
  });
  if (ownerStamp && ownerStamp.usable) {
    return ownerStamp.batchID;
  }

  return await bee.createPostageBatch(DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, {
    waitForUsable: true,
    label: label,
  });
}

export function initTestMantarayNode(): MantarayNode {
  // return initManifestNode({ obfuscationKey: randomBytes(TOPIC_BYTES_LENGTH) as Bytes<32> });
  return new MantarayNode();
}

export function getTestFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, relativePath), 'utf-8');
}
