import { BatchId, BeeDev, PrivateKey } from '@ethersphere/bee-js';

import { buyStamp, generateRandomBytes } from '../../src/utils/common';
import { ADMIN_STAMP_LABEL } from '../../src/utils/constants';
import { BEE_URL, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, DEFAULT_MOCK_SIGNER } from '../utils';

interface BeeWithStampAndSigner {
  bee: BeeDev;
  ownerStamp: BatchId;
  signer: PrivateKey;
}

let globalAdminStamp: BatchId | null = null;

export async function ensureUniqueSignerWithStamp(isNewSigner: boolean = true): Promise<BeeWithStampAndSigner> {
  const signerBytes = generateRandomBytes(PrivateKey.LENGTH);
  const signer = isNewSigner ? new PrivateKey(signerBytes) : DEFAULT_MOCK_SIGNER;

  const bee = new BeeDev(BEE_URL, { signer });

  if (!globalAdminStamp) {
    try {
      globalAdminStamp = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, ADMIN_STAMP_LABEL);
    } catch (error: any) {
      console.error('Failed to create/find owner stamp:', error);
      throw error;
    }
  }

  return { bee, ownerStamp: globalAdminStamp, signer };
}

export function resetGlobalStampState(): void {
  globalAdminStamp = null;
}
