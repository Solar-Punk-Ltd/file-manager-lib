import { ROOT_PATH } from './constants';
import { FileRecordError } from './errors';

export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function normalizePath(path: string): string {
  return pathSegments(path).join('/');
}

export function splitPath(path: string): { parentPath: string; name: string } {
  const lastSlash = path.lastIndexOf('/');
  return {
    parentPath: lastSlash > 0 ? path.substring(0, lastSlash) : ROOT_PATH,
    name: lastSlash >= 0 ? path.substring(lastSlash + 1) : path,
  };
}

export function assertValidNodePath(path: string): void {
  const segments = pathSegments(path);
  if (!path || path.endsWith('/') || segments.length === 0 || segments.some((s) => s === '.' || s === '..')) {
    throw new FileRecordError(`Invalid path: "${path}"`);
  }
}

export function assertValidRelativePath(path: string): void {
  if (path.startsWith('/')) {
    throw new FileRecordError(`Invalid path: "${path}"`);
  }

  assertValidNodePath(path);
}
