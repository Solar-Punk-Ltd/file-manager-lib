import crypto from 'crypto';
import {
  Bee,
  BatchId,
  Topic,
  FeedIndex,
  Reference,
  PrivateKey,
} from '@ethersphere/bee-js';

import { FileVersionMetadata } from './types';
import { SWARM_ZERO_ADDRESS } from './constants';

/**
 * Derive a deterministic feed topic for version history of a given file path.
 */
export function generateFileFeedTopic(filePath: string): Topic {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const pathBuffer = Buffer.from(`file_version_${normalizedPath}`, 'utf-8');
  const hash = crypto.createHash('sha256').update(pathBuffer).digest();
  return new Topic(hash);
}

/**
 * Return the number of versions already written (>=0).
 * Uses the feedIndexNext from the latest download, treating undefined as zero.
 */
export async function getFileVersionCount(
  bee: Bee,
  topic: Topic,
  ownerAddress: string
): Promise<bigint> {
  const reader = bee.makeFeedReader(topic.toUint8Array(), ownerAddress);
  try {
    const result = await reader.download();
    // feedIndexNext may be undefined; default to zero
    return result.feedIndexNext?.toBigInt() ?? 0n;
  } catch (err: any) {
    if (err.status === 404) {
      return 0n;
    }
    throw err;
  }
}

/**
 * Read one particular version's metadata, or the latest if `version` omitted.
 */
export async function readFileVersionMetadata(
  bee: Bee,
  filePath: string,
  ownerAddress: string,
  version?: number
): Promise<FileVersionMetadata | null> {
  const topic  = generateFileFeedTopic(filePath);
  const reader = bee.makeFeedReader(topic.toUint8Array(), ownerAddress);

  try {
    let idx = version !== undefined
      ? BigInt(version)
      : await getFileVersionCount(bee, topic, ownerAddress) - 1n;

    if (idx < 0n) {
      return null;
    }

    const { payload } = await reader.download({ index: FeedIndex.fromBigInt(idx) });
    const raw = payload.toUint8Array();

    if (raw.length === 32) {
      const ref = new Reference(raw);
      if (!ref.equals(SWARM_ZERO_ADDRESS)) {
        const blob = await bee.downloadData(ref.toString());
        return JSON.parse(Buffer.from(blob.toUint8Array()).toString('utf-8'));
      }
    }
    return null;
  } catch (err: any) {
    if (err.status === 404) {
      return null;
    }
    throw err;
  }
}

async function getFileVersionHistory(
  bee: Bee,
  filePath: string,
  ownerAddress: string
): Promise<FileVersionMetadata[]> {
  const topic = generateFileFeedTopic(filePath)
  const count = await getFileVersionCount(bee, topic, ownerAddress)
  if (count === 0n) return []
  const versions = Array.from({ length: Number(count) }, (_, i) => i)
  const all = await Promise.all(
    versions.map((v) =>
      readFileVersionMetadata(bee, filePath, ownerAddress, v)
        .catch(() => null)
    )
  )
  return all.filter((m): m is FileVersionMetadata => m !== null)
}

export async function writeFileVersionMetadata(
  bee: Bee,
  signer: PrivateKey,
  filePath: string,
  batchId: BatchId,
  metadata: FileVersionMetadata
): Promise<number> {
  const topic        = generateFileFeedTopic(filePath).toUint8Array();
  const writer       = bee.makeFeedWriter(topic, signer);
  const ownerAddress = signer.publicKey().address().toString();

  const currentCount = await getFileVersionCount(
    bee,
    generateFileFeedTopic(filePath),
    ownerAddress
  );
  console.debug(`[verCtrl] currentCount =`, currentCount);

  let slot: bigint;
  if (metadata.customMetadata !== undefined && currentCount > 0n) {
    // fetch the *actual* history so we can optionally override
    const history = await getFileVersionHistory(bee, filePath, ownerAddress);
    const hit     = history.findIndex((h) => h.contentHash === metadata.contentHash);
    if (hit >= 0) {
      slot = BigInt(hit);
    } else {
      // no exact match → override the **last** entry
      slot = currentCount - 1n;
    }
    console.debug(`[verCtrl] override slot =`, slot);
  } else {
    // no tag → append
    slot = currentCount;
    console.debug(`[verCtrl] append slot =`, slot);
  }

  const toWrite: FileVersionMetadata = {
    ...metadata,
    version:   Number(slot),
    timestamp: new Date().toISOString(),
  };

  const payload   = Buffer.from(JSON.stringify(toWrite, null, 2), 'utf-8');
  const uploadRes = await bee.uploadData(batchId, payload, { pin: true });
  await writer.uploadReference(batchId, uploadRes.reference, {
    index: FeedIndex.fromBigInt(slot),
  });

  return Number(slot);
}
