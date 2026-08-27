import { ROOT_PATH, TRASH_FOLDER_NAME } from './constants';
import { FileRecordError, FolderError } from './errors';

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

export function isTrashPath(path: string): boolean {
  return pathSegments(path)[0] === TRASH_FOLDER_NAME;
}

export function assertNotTrashPath(path: string): void {
  if (isTrashPath(path)) {
    throw new FolderError(`"${TRASH_FOLDER_NAME}" is reserved — use trash/recover and listTrash`);
  }
}

export function trashPathOf(topic: string): string {
  return `${TRASH_FOLDER_NAME}/${topic}`;
}
