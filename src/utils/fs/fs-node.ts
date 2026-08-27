import type { ReadStream } from 'fs';

import { FileError } from '../errors';

interface FileData {
  data: ReadStream;
  name: string;
}

export async function isDir(dirPath: string): Promise<boolean> {
  const { existsSync, lstatSync } = await import('fs');

  if (!existsSync(dirPath)) {
    throw new FileError(`Path ${dirPath} does not exist!`);
  }

  return lstatSync(dirPath).isDirectory();
}

export async function readFile(filePath: string): Promise<FileData> {
  const { createReadStream } = await import('fs');
  const { basename } = await import('path');

  const readable = createReadStream(filePath);
  const fileName = basename(filePath);

  return { data: readable, name: fileName };
}
