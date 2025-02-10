import { encodePathToBytes } from '../src/utils';

export const mockBatchId = 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';

export const fileInfoTxt = `[
  {
    "batchId": "ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51",
    "eFileRef": "src/folder/1.txt"
  },
  {
    "batchId": "ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51",
    "eFileRef": "src/folder/2.txt"
  }
]`;

export const extendedFileInfoTxt = `[{"batchId":"ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51","eFileRef":"src/folder/1.txt"},{"batchId":"ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51","eFileRef":"src/folder/2.txt"},{"batchId":"ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51","eFileRef":"src/folder/3.txt"}]`;

export const emptyFileInfoTxt = `[]`;

export function createMockMantarayNode(customForks: Record<string, any> = {}, excludeDefaultForks = false): any {
  const defaultForks: Record<string, any> = {
    file: {
      prefix: encodePathToBytes('file'),
      node: {
        forks: {
          '1.txt': {
            prefix: encodePathToBytes('1.txt'),
            node: {
              isValueType: () => true,
              getEntry: 'a'.repeat(64), // Valid Uint8Array
              getMetadata: {
                Filename: '1.txt',
                'Content-Type': 'text/plain',
              },
            },
          },
          '2.txt': {
            prefix: encodePathToBytes('2.txt'),
            node: {
              isValueType: () => true,
              getEntry: 'b'.repeat(64), // Valid Uint8Array
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

  // Conditionally include default forks
  const forks = excludeDefaultForks ? customForks : { ...defaultForks, ...customForks };

  return {
    forks,
    addFork: jest.fn((path: Uint8Array, reference: Uint8Array) => {
      const decodedPath = new TextDecoder().decode(path);
      console.log(`Mock addFork called with path: ${decodedPath}`);
      forks[decodedPath] = {
        prefix: path,
        node: { isValueType: () => true, getEntry: reference },
      };
    }),
    save: jest.fn(async (callback: any) => {
      console.log('Mock save called');
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
