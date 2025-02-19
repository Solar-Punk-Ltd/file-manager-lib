import { Bytes, Reference } from '@upcoming/bee-js';

export const mockBatchId = 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';

export const fileInfoTxt = `[
  {
    "batchId": "${mockBatchId}",
    "file": {
      "reference": "1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68",
      "historyRef": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  },
  {
    "batchId": "${mockBatchId}",
    "file": {
      "reference": "2222222222222222222222222222222222222222222222222222222222222222",
      "historyRef": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  }
]`;

export const extendedFileInfoTxt = `[{"batchId":"${mockBatchId}","file":{"reference":"1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68","historyRef":"0000000000000000000000000000000000000000000000000000000000000000"}},{"batchId":"${mockBatchId}","file":{"reference":"2222222222222222222222222222222222222222222222222222222222222222","historyRef":"0000000000000000000000000000000000000000000000000000000000000000"}},{"batchId":"${mockBatchId}","file":{"reference":"3333333333333333333333333333333333333333333333333333333333333333","historyRef":"0000000000000000000000000000000000000000000000000000000000000000"}}]`;

export const emptyFileInfoTxt = `[]`;

export function createMockMantarayNode(customForks: Record<string, any> = {}, excludeDefaultForks = false): any {
  const defaultForks: Record<string, any> = {
    file: {
      prefix: Bytes.fromUtf8('file'),
      node: {
        forks: {
          '1.txt': {
            prefix: Bytes.fromUtf8('1.txt'),
            node: {
              isValueType: () => true,
              getEntry: 'a'.repeat(64),
              getMetadata: {
                Filename: '1.txt',
                'Content-Type': 'text/plain',
              },
            },
          },
          '2.txt': {
            prefix: Bytes.fromUtf8('2.txt'),
            node: {
              isValueType: () => true,
              getEntry: 'b'.repeat(64),
              getMetadata: {
                Filename: '2.txt',
                'Content-Type': 'text/plain',
              },
            },
          },
        },
        isValueType: () => false,
      },
    },
  };

  const forks = excludeDefaultForks ? customForks : { ...defaultForks, ...customForks };

  return {
    forks,
    addFork: jest.fn((path: Uint8Array, reference: Uint8Array) => {
      const decodedPath = new TextDecoder().decode(path);
      forks[decodedPath] = {
        prefix: path,
        node: { isValueType: () => true, getEntry: reference },
      };
    }),
    save: jest.fn(async (callback: any) => {
      const mockData = new Uint8Array(Buffer.from('mocked-mantaray-data'));
      return callback(mockData);
    }),
  };
}

export class MockLocalStorage {
  store: Record<string, string>;

  constructor() {
    this.store = {};
  }

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = value;
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

export function setupGlobalLocalStorage(): void {
  Object.defineProperty(global, 'localStorage', {
    value: new MockLocalStorage(),
    writable: true,
  });
}

export const refToPath = new Map<Reference, string>();
refToPath.set(new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68'), 'src/folder/1.txt');
refToPath.set(new Reference('2'.repeat(64)), 'src/folder/2.txt');
refToPath.set(new Reference('3'.repeat(64)), 'src/folder/3.txt');
refToPath.set(new Reference('4'.repeat(64)), 'src/folder/4.txt');

export const pathToRef = new Map<string, Reference>();
pathToRef.set('src/folder/1.txt', new Reference('1a9ad03aa993d5ee550daec2e4df4829fd99cc23993ea7d3e0797dd33253fd68'));
pathToRef.set('src/folder/2.txt', new Reference('2'.repeat(64)));
pathToRef.set('src/folder/3.txt', new Reference('3'.repeat(64)));
pathToRef.set('src/folder/4.txt', new Reference('4'.repeat(64)));

export const firstByteArray = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 87, 104, 179, 182,
  167, 219, 86, 210, 29, 26, 191, 244, 13, 65, 206, 191, 200, 52, 72, 254, 216, 215, 233, 176, 110, 192, 211, 176, 115,
  242, 143, 32, 26, 154, 208, 58, 169, 147, 213, 238, 85, 13, 174, 194, 228, 223, 72, 41, 253, 153, 204, 35, 153, 62,
  167, 211, 224, 121, 125, 211, 50, 83, 253, 104, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0,
]);

export const secondByteArray = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 87, 104, 179, 182,
  167, 219, 86, 210, 29, 26, 191, 244, 13, 65, 206, 191, 200, 52, 72, 254, 216, 215, 233, 176, 110, 192, 211, 176, 115,
  242, 143, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 16, 115, 114, 99, 47, 102, 111, 108, 100, 101, 114, 47, 49, 46, 116,
  120, 116, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 148, 0, 17, 119, 248, 231, 159, 158, 240, 146, 107, 58, 95, 110,
  135, 168, 220, 196, 216, 79, 98, 210, 143, 97, 225, 35, 59, 60, 200, 178, 218, 27,
]);
