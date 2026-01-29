import { FileError } from '../errors';
import type { ReadStream } from 'fs';

export interface FileData {
  data: string | Uint8Array | ReadStream;
  name: string;
  contentType: string;
}

// TODO: extend this to support more file types
export async function getContentType(filePath: string): Promise<string> {
  const { extname } = await import('path');
  const ext = extname(filePath).toLowerCase();
  const contentTypes: Map<string, string> = new Map([
    ['.txt', 'text/plain'],
    ['.json', 'application/json'],
    ['.html', 'text/html'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
  ]);

  return contentTypes.get(ext) || 'application/octet-stream';
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
  const contentType = await getContentType(filePath);

  return { data: readable, name: fileName, contentType };
}
