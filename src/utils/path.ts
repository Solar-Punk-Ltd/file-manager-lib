import { ROOT_PATH } from './constants';
import { FileRecordError } from './errors';

/** Split a path into its non-empty segments, tolerating leading/trailing/duplicate slashes. */
export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Collapse a path to its canonical form: no leading/trailing/duplicate slashes. */
export function normalizePath(path: string): string {
  return pathSegments(path).join('/');
}

/**
 * Split an absolute manifest path into its parent path and final segment.
 * A top-level entry ("foo" or "/foo") has {@link ROOT_PATH} as its parent.
 */
export function splitPath(path: string): { parentPath: string; name: string } {
  const lastSlash = path.lastIndexOf('/');
  return {
    parentPath: lastSlash > 0 ? path.substring(0, lastSlash) : ROOT_PATH,
    name: lastSlash >= 0 ? path.substring(lastSlash + 1) : path,
  };
}

/** Reject paths that are empty, absolute, contain "..", or end in a slash. */
export function assertValidRelativePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('..') || path.endsWith('/')) {
    throw new FileRecordError(`Invalid path: "${path}"`);
  }
}
