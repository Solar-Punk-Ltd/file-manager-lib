import { PrivateKey, Reference } from '@upcoming/bee-js';
import * as fs from 'fs';
import path from 'path';

import { FileManager } from '../src/fileManager';
import { FileInfo } from '../src/utils/types';

export const BEE_URL = 'http://localhost:1633';
export const OTHER_BEE_URL = 'http://localhost:1733';
export const DEFAULT_BATCH_DEPTH = 21;
export const DEFAULT_BATCH_AMOUNT = '500000000';
export const MOCK_SIGNER = new PrivateKey('634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd');
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
    expect(fiList.length).toEqual(expArr.length);
    return;
  }

  for (const [ix, fi] of fiList.entries()) {
    const fetchedFiles = await fileManager.downloadFiles(fi.file.reference as Reference, {
      actHistoryAddress: fi.file.historyRef,
      actPublisher: publicKey,
    });
    expect(expArr[ix]).toEqual(fetchedFiles);
  }
}
