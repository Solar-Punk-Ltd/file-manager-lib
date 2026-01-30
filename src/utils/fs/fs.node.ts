import { FileError } from '../errors';
import type { ReadStream } from 'fs';

export interface FileData {
  data: string | Uint8Array | ReadStream;
  name: string;
  contentType: string;
}

const contentTypes: Map<string, string> = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
]);

export async function getContentType(filePath: string): Promise<string> {
  const { extname } = await import('path');
  const ext = extname(filePath).toLowerCase();

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
