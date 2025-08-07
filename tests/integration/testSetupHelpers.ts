import { BatchId, BeeDev } from '@ethersphere/bee-js';

import { buyStamp } from '../../src/utils/common';
import { OWNER_STAMP_LABEL } from '../../src/utils/constants';
import { BEE_URL, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, MOCK_SIGNER } from '../utils';

let globalOwnerStamp: BatchId | null = null;
let globalBee: BeeDev | null = null;

export async function ensureOwnerStamp(): Promise<{ bee: BeeDev; ownerStamp: BatchId }> {
  if (!globalBee) {
    globalBee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
  }

  if (!globalOwnerStamp) {
    try {
      globalOwnerStamp = await buyStamp(globalBee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_STAMP_LABEL);
    } catch (error: any) {
      console.error('Failed to create/find owner stamp:', error);
      throw error;
    }
  }

  return { bee: globalBee, ownerStamp: globalOwnerStamp };
}

export function resetGlobalStampState(): void {
  globalOwnerStamp = null;
  globalBee = null;
}
