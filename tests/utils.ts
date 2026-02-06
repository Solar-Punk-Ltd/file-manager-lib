import { BatchId, Bee, Bytes, MantarayNode, PrivateKey } from '@ethersphere/bee-js';
import * as fs from 'fs';
import path from 'path';

import { FileInfo, FileManager } from '@/types';
import { ReferenceWithHistory, WrappedUploadResult } from '@/types/utils';
import { SWARM_ZERO_ADDRESS } from '@/utils/constants';

export const BEE_URL = 'http://127.0.0.1:1633';
export const OTHER_BEE_URL = 'http://127.0.0.1:1733';
export const DEFAULT_BATCH_DEPTH = 21;
export const DEFAULT_BATCH_AMOUNT = '500000000';
export const DEFAULT_MOCK_SIGNER = new PrivateKey('634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd');
export const OTHER_MOCK_SIGNER = new PrivateKey('734fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cd7');

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

export async function dowloadAndCompareFiles(
  fileManager: FileManager,
  publicKey: string,
  fiList: FileInfo[],
  expArr: string[][],
): Promise<void> {
  if (fiList.length !== expArr.length) {
    expect(fiList).toHaveLength(expArr.length);
    return;
  }

  for (const [ix, fi] of fiList.entries()) {
    const fetchedFiles = (await fileManager.download(fi, undefined, {
      actHistoryAddress: fi.file.historyRef,
      actPublisher: publicKey,
    })) as Bytes[];
    const fetchedFilesStrings = fetchedFiles.map((f) => f.toUtf8());
    expect(expArr[ix]).toEqual(fetchedFilesStrings);
  }
}

export async function createWrappedData(bee: Bee, batchId: BatchId, node: MantarayNode): Promise<ReferenceWithHistory> {
  const manatarayResult = await node.saveRecursively(bee, batchId);
  const wrappedData: WrappedUploadResult = {
    uploadFilesRes: manatarayResult.reference.toString(),
    uploadPreviewRes: SWARM_ZERO_ADDRESS.toString(),
  };
  const wrappedRes = await bee.uploadData(batchId, JSON.stringify(wrappedData), { act: true });
  return {
    reference: wrappedRes.reference.toString(),
    historyRef: wrappedRes.historyAddress.getOrThrow().toString(),
  };
}
