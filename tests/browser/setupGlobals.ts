/// <reference lib="dom" />
/* eslint-env browser */
/* global  DataTransfer, DataTransferItemList, DataTransferItem, File, FileList, FileReader, ReadableStream, ReadableStreamDefaultController */

import crypto from 'crypto';
import { TextDecoder, TextEncoder } from 'util';

// Ensure process.browser is set
(process as any).browser = true;
process.env.BROWSER = 'true';

declare global {
  var TextDecoder: typeof TextDecoder;
  var TextEncoder: typeof TextEncoder;
  var DataTransfer: { new (): DataTransfer };
  var window: any;
  var crypto: any;
  // In case the DOM lib doesn’t provide these, we declare minimal versions:
  interface DataTransferItem {
    kind: string;
    type: string;
    getAsFile(): File | null;
  }
  interface DataTransferItemList {
    readonly length: number;
    item(index: number): DataTransferItem | null;
    add(data: File): void;
  }

  /* eslint-disable @typescript-eslint/no-empty-object-type */
  interface ReadableStream<_R = any> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type */
}

// Polyfill TextDecoder/TextEncoder if not present
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
}
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}

// Minimal polyfill for DataTransfer (only if not provided by the DOM lib)
if (typeof globalThis.DataTransfer === 'undefined') {
  class DataTransferPolyfill implements DataTransfer {
    private _files: File[] = [];

    get items(): DataTransferItemList {
      return {
        get length(): number {
          return this._files.length;
        },
        item: (index: number): DataTransferItem | null => {
          return this._files[index] || null;
        },
        add: (file: File): void => {
          this._files.push(file);
        },
      } as unknown as DataTransferItemList;
    }

    get files(): FileList {
      return this._files as unknown as FileList;
    }
  }
  globalThis.DataTransfer = DataTransferPolyfill as any;
}

// Ensure window exists
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

// Polyfill window.crypto if not available
if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues: (arr: Uint8Array): Uint8Array => crypto.randomFillSync(arr),
  };
}

// Polyfill File.prototype.arrayBuffer if not available
if (typeof File !== 'undefined' && !File.prototype.arrayBuffer) {
  File.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
    return new Promise((resolve, reject): void => {
      const reader = new FileReader();
      reader.onload = (): void => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(this);
    });
  };
}

// Polyfill File.prototype.stream if not available
if (typeof File !== 'undefined' && !File.prototype.stream) {
  File.prototype.stream = function (): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        try {
          const buffer = await this.arrayBuffer();
          controller.enqueue(new Uint8Array(buffer));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
  };
}
