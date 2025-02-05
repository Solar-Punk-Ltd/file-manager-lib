import { BatchId, Bee, Data, TOPIC_BYTES_LENGTH, Utils } from '@ethersphere/bee-js';
import { initManifestNode, MantarayNode } from '@solarpunkltd/mantaray-js';
import { randomBytes } from 'crypto';
import { Wallet } from 'ethers';
import { readFileSync } from 'fs';
import path from 'path';

import { Bytes } from '../src/types';

export const BEE_URL = 'http://localhost:1633';
export const OTHER_BEE_URL = 'http://localhost:1733';
export const DEFAULT_BATCH_DEPTH = 21;
export const DEFAULT_BATCH_AMOUNT = '500000000';
export const MOCK_PRIV_KEY = '634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd';
export const MOCK_WALLET = new Wallet(MOCK_PRIV_KEY);
export const OTHER_MOCK_PRIV_KEY = '734fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cd7';
export const OTHER_MOCK_WALLET = new Wallet(OTHER_MOCK_PRIV_KEY);
export const MOCK_SIGNER = {
  address: Utils.hexToBytes(MOCK_WALLET.address.slice(2)),
  sign: async (data: Data): Promise<string> => {
    return await MOCK_WALLET.signMessage(data);
  },
};

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
  return initManifestNode({ obfuscationKey: randomBytes(TOPIC_BYTES_LENGTH) as Bytes<32> });
}

export function getTestFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, relativePath), 'utf-8');
}
