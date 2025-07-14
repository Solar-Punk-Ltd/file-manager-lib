import crypto from 'crypto';
import {
  Bee,
  BatchId,
  Topic,
  FeedIndex,
  Reference,
  PrivateKey,
} from '@ethersphere/bee-js';

import { FileVersionMetadata, FileVersionInfo } from './types';
import { SWARM_ZERO_ADDRESS } from './constants';

const MAX_VERSION_SCAN = 1000n;

export function generateFileFeedTopic(filePath: string): Topic {
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  const pathBuffer = Buffer.from(`file_version_${normalizedPath}`, 'utf-8');
  const hash = crypto.createHash('sha256').update(pathBuffer).digest();
  
  return new Topic(hash);
}

export async function getFileVersionCount(
  bee: Bee,
  topic: Topic,
  ownerAddress: string
): Promise<bigint> {
  const reader = bee.makeFeedReader(topic.toUint8Array(), ownerAddress);
  
  try {
    await reader.download({ index: FeedIndex.fromBigInt(0n) });
  } catch (err: any) {
    if (err.status === 404) {
      return -1n; // No versions exist yet
    }
    throw err;
  }
  
  let idx = 1n;
  while (idx < MAX_VERSION_SCAN) {
    try {
      await reader.download({ index: FeedIndex.fromBigInt(idx) });
      idx++;
    } catch (err: any) {
      if (err.status === 404) {
        return idx - 1n;
      }
      throw err;
    }
  }
  
  return idx - 1n;
}

export async function writeFileVersionMetadata(
  bee: Bee,
  signer: PrivateKey,
  filePath: string,
  batchId: BatchId,
  metadata: FileVersionMetadata
): Promise<number> {
  const topic = generateFileFeedTopic(filePath);
  const writer = bee.makeFeedWriter(topic.toUint8Array(), signer);
  const ownerAddress = signer.publicKey().address().toString();
  
  const currentVersionCount = await getFileVersionCount(bee, topic, ownerAddress);
  const nextIndex = currentVersionCount < 0n ? 0n : currentVersionCount + 1n;
  
  const versionedMetadata = {
    ...metadata,
    version: Number(nextIndex),
    timestamp: new Date().toISOString(),
  };
  
  const metadataJson = JSON.stringify(versionedMetadata, null, 2);
  const metadataBytes = Buffer.from(metadataJson, 'utf-8');
  
  const uploadResult = await bee.uploadData(batchId, metadataBytes, { pin: true });
  
  await writer.uploadReference(batchId, uploadResult.reference, {
    index: FeedIndex.fromBigInt(nextIndex)
  });
  
  return Number(nextIndex);
}

export async function readFileVersionMetadata(
  bee: Bee,
  filePath: string,
  ownerAddress: string,
  version?: number
): Promise<FileVersionMetadata | null> {
  const topic = generateFileFeedTopic(filePath);
  const reader = bee.makeFeedReader(topic.toUint8Array(), ownerAddress);
  
  try {
    let feedIndex: bigint;
    
    if (version !== undefined) {
      feedIndex = BigInt(version);
    } else {
      feedIndex = await getFileVersionCount(bee, topic, ownerAddress);
      if (feedIndex < 0n) {
        return null;
      }
    }
    
    const msg = await reader.download({ index: FeedIndex.fromBigInt(feedIndex) });
    const raw = msg.payload.toUint8Array();
    
    if (raw.length === 32) {
      const ref = new Reference(raw);
      if (!ref.equals(SWARM_ZERO_ADDRESS)) {
        const metadataData = await bee.downloadData(ref);
        const metadataJson = Buffer.from(metadataData.toUint8Array()).toString('utf-8');
        return JSON.parse(metadataJson) as FileVersionMetadata;
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

export async function getFileVersionHistory(
  bee: Bee,
  filePath: string,
  ownerAddress: string
): Promise<FileVersionMetadata[]> {
  const topic = generateFileFeedTopic(filePath);
  const maxVersion = await getFileVersionCount(bee, topic, ownerAddress);
  
  if (maxVersion < 0n) {
    return [];
  }
  
  const history: FileVersionMetadata[] = [];
  
  for (let version = 0n; version <= maxVersion; version++) {
    try {
      const metadata = await readFileVersionMetadata(bee, filePath, ownerAddress, Number(version));
      if (metadata) {
        history.push(metadata);
      }
    } catch (err) {
      console.warn(`Failed to read version ${version} for ${filePath}:`, err);
    }
  }
  
  return history;
}

export async function getFileVersionInfo(
  bee: Bee,
  filePath: string,
  ownerAddress: string
): Promise<FileVersionInfo | null> {
  const topic = generateFileFeedTopic(filePath);
  const maxVersion = await getFileVersionCount(bee, topic, ownerAddress);
  
  if (maxVersion < 0n) {
    return null;
  }
  
  const latestMetadata = await readFileVersionMetadata(bee, filePath, ownerAddress);
  
  return {
    currentVersion: Number(maxVersion),
    totalVersions: Number(maxVersion) + 1,
    latestTimestamp: latestMetadata?.timestamp || new Date().toISOString(),
    feedTopic: topic.toString(),
  };
}

export async function calculateContentHash(
  bee: Bee,
  batchId: BatchId,
  data: Uint8Array | Buffer
): Promise<string> {
  const dataAsUint8Array = data instanceof Buffer ? new Uint8Array(data) : data;
  const uploadResult = await bee.uploadData(batchId, dataAsUint8Array, { pin: true });
  return uploadResult.reference.toString();
}

export async function hasVersionHistory(
  bee: Bee,
  filePath: string,
  ownerAddress: string
): Promise<boolean> {
  const topic = generateFileFeedTopic(filePath);
  const versionCount = await getFileVersionCount(bee, topic, ownerAddress);
  return versionCount >= 0n;
} 
