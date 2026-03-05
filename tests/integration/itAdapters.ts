/**
 * Environment adapters for integration tests.
 *
 * The spec file keeps all its Node-flavoured file-system setup (fs / path /
 * temp dirs).  The browser test project stubs `std-env` so that `isNode ===
 * false`.  These helpers intercept the upload / download calls and convert
 * them transparently:
 *
 * - `uploadWithAdapter(fm, drive, opts, ...)` — when `isNode === false`, reads
 *   the `path` / `previewPath` from opts, converts them to in-memory `File[]`
 *   objects and calls `fm.upload()` with `{ files }` / `{ preview }` instead.
 *   The existing Jest Node runtime can still use `fs.readFileSync` for this;
 *   it is only the option object sent to the FileManager that changes, which
 *   exercises `upload.browser.ts`.
 *
 * - `downloadAndNormalize(fm, fi, ...)` — after the download, converts any
 *   `ReadableStream<Uint8Array>` values (browser path) back to `Bytes` so
 *   that the existing `.toUtf8()` assertions work unchanged.
 *
 * - `downloadAndCompare(fm, pk, fiList, expArr)` — drop-in replacement for
 *   `dowloadAndCompareFiles` from tests/utils that uses the above.
 *
 * Low-level helpers (`createFileInput`, `createDirInput`, …) are also kept
 * for tests that want fine-grained control.
 */

import {
  BeeRequestOptions,
  Bytes,
  CollectionUploadOptions,
  DownloadOptions,
  FileUploadOptions,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isNode } from 'std-env';

import { DriveInfo, FileInfo, FileManager } from '@/types';
import { FileInfoOptions, NodeUploadOptions } from '@/types/utils';

// ---------------------------------------------------------------------------
// Types mirroring NodeUploadOptions / BrowserUploadOptions partial shapes
// ---------------------------------------------------------------------------

export type NodeInput = { path: string };
export type BrowserInput = { files: File[] };
export type UploadInput = NodeInput | BrowserInput;

export type NodePreviewInput = { previewPath: string };
export type BrowserPreviewInput = { preview: File };
export type PreviewInput = NodePreviewInput | BrowserPreviewInput;

export interface FileHandle {
  /** Spread into `fileManager.upload(drive, { name, ...input })` */
  input: UploadInput;
  cleanup: () => void;
}

export interface DirHandle {
  input: UploadInput;
  cleanup: () => void;
}

export interface PreviewHandle {
  previewInput: PreviewInput;
  cleanup: () => void;
}

// ---------------------------------------------------------------------------
// Internal: recursively read a directory from disk into File[]
// ---------------------------------------------------------------------------

function readDirAsFiles(dirPath: string): File[] {
  const files: File[] = [];
  const walk = (dir: string, base: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      // Build relative path with forward slashes (required for mantaray forks)
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        const content = fs.readFileSync(fullPath);
        files.push(new File([content], relPath));
      }
    }
  };
  walk(dirPath, '');
  return files;
}

// ---------------------------------------------------------------------------
// Core adapter: upload
// ---------------------------------------------------------------------------

/**
 * Wraps `fm.upload()` so that Node-style `{ path, previewPath }` options are
 * silently converted to browser-style `{ files, preview }` when
 * `isNode === false`.  All other call-site arguments pass through unchanged.
 */
export async function uploadWithAdapter(
  fm: FileManager,
  drive: DriveInfo,
  opts: FileInfoOptions,
  uploadOpts?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
  requestOpts?: BeeRequestOptions,
): Promise<void> {
  if (isNode) {
    // Node path: opts already has { path } — pass straight through.
    return fm.upload(drive, opts, uploadOpts, requestOpts);
  }

  // Browser path: convert { path, previewPath } → { files, preview }.
  const { path: nodePath, previewPath, ...rest } = opts as NodeUploadOptions & typeof opts;
  const browserOpts: FileInfoOptions = rest as FileInfoOptions;

  if (nodePath) {
    const stat = fs.statSync(nodePath);
    if (stat.isDirectory()) {
      (browserOpts as any).files = readDirAsFiles(nodePath);
    } else {
      const content = fs.readFileSync(nodePath);
      (browserOpts as any).files = [new File([content], path.basename(nodePath))];
    }
  }

  if (previewPath) {
    const stat = fs.statSync(previewPath);
    if (stat.isDirectory()) {
      const previewFiles = readDirAsFiles(previewPath);
      // For directories used as preview, pack the first file as the preview File.
      (browserOpts as any).preview = previewFiles[0] ?? new File([], path.basename(previewPath));
    } else {
      const content = fs.readFileSync(previewPath);
      (browserOpts as any).preview = new File([content], path.basename(previewPath));
    }
  }

  return fm.upload(drive, browserOpts, uploadOpts, requestOpts);
}

// ---------------------------------------------------------------------------
// Core adapter: download — normalise ReadableStream → Bytes
// ---------------------------------------------------------------------------

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Bytes> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new Bytes(Buffer.concat(chunks));
}

/**
 * Calls `fm.download()` and normalises the result to `Bytes[]` regardless of
 * the current environment.  In Node mode the cast is a no-op; in browser mode
 * each `ReadableStream<Uint8Array>` is drained and wrapped in `Bytes`.
 */
export async function downloadAndNormalize(
  fm: FileManager,
  fileInfo: FileInfo,
  paths?: string[],
  dlOpts?: DownloadOptions,
  requestOpts?: BeeRequestOptions,
): Promise<Bytes[]> {
  const result = await fm.download(fileInfo, paths, dlOpts, requestOpts);

  if (isNode) {
    return result as Bytes[];
  }

  // Browser: result is ReadableStream<Uint8Array>[]
  return Promise.all((result as ReadableStream<Uint8Array>[]).map(streamToBytes));
}

/**
 * Drop-in adapter-aware replacement for `dowloadAndCompareFiles` in
 * tests/utils.ts.  Works correctly for both Node and browser test projects.
 */
export async function downloadAndCompare(
  fm: FileManager,
  publicKey: string,
  fiList: FileInfo[],
  expArr: string[][],
): Promise<void> {
  if (fiList.length !== expArr.length) {
    expect(fiList).toHaveLength(expArr.length);
    return;
  }

  for (const [ix, fi] of fiList.entries()) {
    const fetched = await downloadAndNormalize(fm, fi, undefined, {
      actHistoryAddress: fi.file.historyRef,
      actPublisher: publicKey,
    });
    expect(expArr[ix]).toEqual(fetched.map((b) => b.toUtf8()));
  }
}

// ---------------------------------------------------------------------------
// Lower-level helpers (kept for fine-grained test control)
// ---------------------------------------------------------------------------

/**
 * Creates a single-file upload handle.
 * Node   → writes a temp file on disk, returns `{ path }`.
 * Browser → constructs an in-memory `File`, returns `{ files: [file] }`.
 */
export function createFileInput(content: string | Buffer, name: string): FileHandle {
  if (isNode) {
    const tmp = path.join(os.tmpdir(), `fm-it-${Date.now()}-${name}`);
    fs.writeFileSync(tmp, content);
    return {
      input: { path: tmp },
      cleanup: () => fs.rmSync(tmp, { force: true }),
    };
  }

  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const file = new File([new Uint8Array(buf)], name);
  return { input: { files: [file] }, cleanup: () => ({}) };
}

/**
 * Creates a multi-file upload handle from a flat map of
 * `{ 'relative/path.txt': 'content', ... }`.
 * Node   → writes a real temp directory tree, returns `{ path }`.
 * Browser → constructs `File[]` (filename = relative path), returns `{ files }`.
 */
export function createDirInput(files: Record<string, string>): DirHandle {
  if (isNode) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-it-dir-'));
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(tmp, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return {
      input: { path: tmp },
      cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    };
  }

  const fileList = Object.entries(files).map(([relPath, content]) => new File([content], relPath));
  return { input: { files: fileList }, cleanup: () => ({}) };
}

/**
 * Creates a preview upload handle.
 * Node   → writes a temp file on disk, returns `{ previewPath }`.
 * Browser → constructs a `File`, returns `{ preview: File }`.
 */
export function createPreviewInput(content: string, name: string): PreviewHandle {
  if (isNode) {
    const tmp = path.join(os.tmpdir(), `fm-it-prev-${Date.now()}-${name}`);
    fs.writeFileSync(tmp, content);
    return {
      previewInput: { previewPath: tmp },
      cleanup: () => fs.rmSync(tmp, { force: true }),
    };
  }

  const file = new File([content], name);
  return { previewInput: { preview: file }, cleanup: () => ({}) };
}

/**
 * Creates a large binary file for abort-timing tests.
 */
export function createLargeFileInput(bytes: number, name: string = 'large.bin'): FileHandle {
  const buf = Buffer.alloc(bytes, 'x');
  return createFileInput(buf, name);
}

/**
 * Reads downloaded content to UTF-8 string regardless of env.
 * Node   → `Bytes.toUtf8()`
 * Browser → drains `ReadableStream<Uint8Array>`
 */
export async function readDownloadItem(item: unknown): Promise<string> {
  if (item != null && typeof (item as any).toUtf8 === 'function') {
    return (item as any).toUtf8() as string;
  }

  if (item instanceof ReadableStream) {
    const bytes = await streamToBytes(item);
    return bytes.toUtf8();
  }

  throw new Error(`readDownloadItem: unrecognised type ${Object.prototype.toString.call(item)}`);
}
