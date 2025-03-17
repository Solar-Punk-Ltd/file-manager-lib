import { Bytes } from '@ethersphere/bee-js';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import Path from 'path';

import { FileError } from './errors';
import { FileData } from './types';

export function getContentType(filePath: string): string {
  const ext = Path.extname(filePath).toLowerCase();
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

export function isDir(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) throw new FileError(`Path ${dirPath} does not exist!`);
  return fs.lstatSync(dirPath).isDirectory();
}

export function readFile(filePath: string): FileData {
  const readable = fs.createReadStream(filePath);
  const fileName = Path.basename(filePath);
  const contentType = getContentType(filePath);

  return { data: readable, name: fileName, contentType };
}

export function getRandomBytes(len: number): Bytes {
  return new Bytes(randomBytes(len));
}
