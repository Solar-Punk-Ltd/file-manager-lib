import { BatchId, Bee, PrivateKey } from '@ethersphere/bee-js';
import * as fs from 'fs';
import path from 'path';

import {
  BEE_URL,
  buyStampSerialized,
  createInitializedFileManager,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  DEFAULT_MOCK_SIGNER,
} from '../../utils';

import { FileManagerBase } from '@/fileManager';
import { DriveInfo } from '@/types';
import { ADMIN_STAMP_LABEL } from '@/utils/constants';
import { generateRandomBytes } from '@/utils/crypto';

interface BeeWithStampAndSigner {
  bee: Bee;
  ownerStamp: BatchId;
  signer: PrivateKey;
}

let globalAdminStamp: BatchId | null = null;

export async function ensureUniqueSignerWithStamp(isNewSigner: boolean = true): Promise<BeeWithStampAndSigner> {
  const signerBytes = generateRandomBytes(PrivateKey.LENGTH);
  const signer = isNewSigner ? new PrivateKey(signerBytes) : DEFAULT_MOCK_SIGNER;

  const bee = new Bee(BEE_URL, { signer });

  if (!globalAdminStamp) {
    try {
      globalAdminStamp = await buyStampSerialized(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, ADMIN_STAMP_LABEL);
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

export interface UserDriveFixture {
  bee: Bee;
  fileManager: FileManagerBase;
  drive: DriveInfo;
  ownerStamp: BatchId;
  batchId: BatchId;
  signer: PrivateKey;
}

export async function setupUserDrive(
  driveName: string,
  opts: { stampLabel?: string; reuseOwnerStamp?: boolean } = { reuseOwnerStamp: true },
): Promise<UserDriveFixture> {
  const { stampLabel = driveName, reuseOwnerStamp } = opts;

  const { bee, ownerStamp, signer } = await ensureUniqueSignerWithStamp();
  const fileManager = await createInitializedFileManager(bee, ownerStamp);

  const batchId = reuseOwnerStamp
    ? ownerStamp
    : await buyStampSerialized(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, stampLabel);

  await fileManager.createDrive(batchId, driveName);
  const drive = fileManager.driveList.find((d) => d.name === driveName);
  expect(drive).toBeDefined();

  return { bee, fileManager, drive: drive!, ownerStamp, batchId, signer };
}

export interface TempFileRegistry {
  writeTempFile: (name: string, content: string | Uint8Array) => string;
  writeTempDir: (dir: string, files: Record<string, string>) => string;
  cleanup: () => void;
}

export function tempFileRegistry(): TempFileRegistry {
  const paths: string[] = [];
  const track = (p: string): string => {
    paths.push(p);
    return p;
  };

  return {
    writeTempFile(name, content) {
      fs.writeFileSync(name, content);
      return track(name);
    },
    writeTempDir(dir, files) {
      fs.mkdirSync(dir, { recursive: true });
      for (const [relativePath, content] of Object.entries(files)) {
        const full = path.join(dir, relativePath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      return track(dir);
    },
    cleanup() {
      for (const p of paths) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    },
  };
}
