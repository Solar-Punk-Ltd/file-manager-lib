import { BatchId, Bee, Bytes, Reference, UploadResult } from '@ethersphere/bee-js';
import { Optional } from 'cafe-utility';
import fs from 'fs';
import path from 'path';

import { FileManagerBase } from '../../src/index';
import { FileOperation, FileVersionMetadata } from '../../src/utils/types';
import { SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import {
  createInitializedFileManager,
  createInitMocks,
  MOCK_BATCH_ID,
} from '../mockHelpers';
import { BEE_URL, MOCK_SIGNER } from '../utils';

jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('FileManagerBase Version Control', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    // stub fs
    const mockBuf = Buffer.from('test file content');
    mockedFs.readFileSync = jest.fn().mockReturnValue(mockBuf);
    mockedFs.statSync = jest.fn().mockReturnValue({
      isDirectory: () => false,
      size: mockBuf.length,
    } as any);
  });

  describe('uploadWithVersioning', () => {
    it('should upload file and create version metadata', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const batch = new BatchId(MOCK_BATCH_ID);
      const resolved = './test-file.txt';
      const logical = 'test.txt';

      jest.spyOn(fm, 'upload').mockResolvedValue();
      const mockUR: UploadResult = {
        reference: new Reference('a'.repeat(64)),
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
      };
      jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue(mockUR);
      jest
        .spyOn(Bee.prototype, 'makeFeedWriter')
        .mockReturnValue({ uploadReference: jest.fn().mockResolvedValue(mockUR) } as any);
      jest
        .spyOn(Bee.prototype, 'makeFeedReader')
        .mockReturnValue({ download: jest.fn().mockRejectedValue({ status: 404 }) } as any);

      await fm.uploadWithVersioning(
        batch,
        resolved,
        logical,
        FileOperation.CREATE,
        undefined, // previewPath
        undefined, // historyRef
        undefined, // infoTopic
        undefined, // index
        undefined, // redundancyLevel
        { author: 'test-user' },
      );

      // The real call uses 8 positional args:
      expect(fm.upload).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: batch, path: resolved, name: path.basename(resolved), customMetadata: { author: 'test-user' } }),
        expect.objectContaining({ redundancyLevel: undefined, actHistoryAddress: undefined }),
      );
    });

    it('should handle version creation failure gracefully', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const batch = new BatchId(MOCK_BATCH_ID);
      jest.spyOn(fm, 'upload').mockResolvedValue();
      jest.spyOn(Bee.prototype, 'uploadData').mockRejectedValue(new Error('oops'));
      jest.spyOn(console, 'warn').mockImplementation();

      await expect(
        fm.uploadWithVersioning(batch, './x', 'x', FileOperation.CREATE)
      ).resolves.toBeUndefined();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create version for x'),
        expect.any(Error),
      );
    });
  });

  describe('getFileVersionHistoryByPath', () => {
    it('should return version history for a file', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const filePath = 'test.txt';

      const expected: FileVersionMetadata[] = [
        {
          filePath,
          contentHash: 'abc123',
          size: 1024,
          timestamp: '2024-01-15T10:30:00.000Z',
          operation: FileOperation.CREATE,
          version: 0,
          batchId: MOCK_BATCH_ID,
        },
        {
          filePath,
          contentHash: 'def456',
          size: 1536,
          timestamp: '2024-01-15T11:30:00.000Z',
          operation: FileOperation.MODIFY,
          version: 1,
          batchId: MOCK_BATCH_ID,
        },
      ];

      // reader.download: version 0/1 exist, 2→404, then payloads for 0/1
      const rd = jest
        .fn()
        .mockResolvedValueOnce({}) // v0 exist
        .mockResolvedValueOnce({}) // v1 exist
        .mockRejectedValueOnce({ status: 404 }) // v2 missing
        .mockResolvedValueOnce({ // payload v0
          payload: new Bytes(new Reference('a'.repeat(64)).toUint8Array()),
        })
        .mockResolvedValueOnce({ // payload v1
          payload: new Bytes(new Reference('b'.repeat(64)).toUint8Array()),
        });
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({ download: rd } as any);

      jest
        .spyOn(Bee.prototype, 'downloadData')
        .mockResolvedValueOnce(new Bytes(Buffer.from(JSON.stringify(expected[0]), 'utf-8')))
        .mockResolvedValueOnce(new Bytes(Buffer.from(JSON.stringify(expected[1]), 'utf-8')));

      const history = await fm.getFileVersionHistoryByPath(filePath);
      expect(history).toEqual(expected);
    });

    it('throws if not initialized', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManagerBase(bee);
      await expect(fm.getFileVersionHistoryByPath('x')).rejects.toThrow();
    });
  });

  describe('getFileVersionInfoByPath', () => {
    it('should return version info summary', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const filePath = 'test.txt';
      const meta: FileVersionMetadata = {
        filePath,
        contentHash: 'xyz789',
        size: 2048,
        timestamp: '2024-01-15T12:30:00.000Z',
        operation: FileOperation.MODIFY,
        version: 2,
        batchId: MOCK_BATCH_ID,
      };

      let calls = 0;
      const rd = jest.fn().mockImplementation(() => {
        calls++;
        if (calls <= 3) return Promise.resolve({});
        if (calls === 4) return Promise.reject({ status: 404 });
        return Promise.resolve({ payload: new Bytes(new Reference('f'.repeat(64)).toUint8Array()) });
      });
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({ download: rd } as any);
      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(
        new Bytes(Buffer.from(JSON.stringify(meta), 'utf-8'))
      );

      const info = await fm.getFileVersionInfoByPath(filePath);
      expect(info).toEqual({
        currentVersion: 2,
        totalVersions: 3,
        latestTimestamp: meta.timestamp,
        feedTopic: expect.any(String),
      });
    });
  });

  describe('getFileVersion', () => {
    it('should return specific version metadata', async () =>{
      createInitMocks();
      const fm = await createInitializedFileManager();
      const filePath = 'test.txt';
      const version = 1;
      const expected: FileVersionMetadata = {
        filePath,
        contentHash: 'abc123',
        size: 1024,
        timestamp: '2024-01-15T10:30:00.000Z',
        operation: FileOperation.MODIFY,
        version,
        batchId: MOCK_BATCH_ID,
      };

      jest
        .spyOn(Bee.prototype, 'makeFeedReader')
        .mockReturnValue({ download: jest.fn().mockResolvedValue({
          payload: new Bytes(new Reference('e'.repeat(64)).toUint8Array())
        }) } as any);
      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(
        new Bytes(Buffer.from(JSON.stringify(expected), 'utf-8'))
      );

      const res = await fm.getFileVersion(filePath, version);
      expect(res).toEqual(expected);
    });
  });

  describe('downloadFileVersion', () => {
    it('should download and return file content', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const filePath = 'test.txt';
      const version = 1;
      const meta: FileVersionMetadata = {
        filePath,
        contentHash: 'hash',
        size: 1024,
        timestamp: '2024-01-15T10:30:00.000Z',
        operation: FileOperation.MODIFY,
        version,
        batchId: MOCK_BATCH_ID,
      };
      const body = new Uint8Array(Buffer.from('hello'));

      jest
        .spyOn(Bee.prototype, 'makeFeedReader')
        .mockReturnValue({ download: jest.fn().mockResolvedValue({
          payload: new Bytes(new Reference('f'.repeat(64)).toUint8Array())
        }) } as any);
      jest
        .spyOn(Bee.prototype, 'downloadData')
        .mockResolvedValueOnce(new Bytes(Buffer.from(JSON.stringify(meta), 'utf-8')))
        .mockResolvedValueOnce(new Bytes(body));

      const out = await fm.downloadFileVersion(filePath, version);
      expect(out).toEqual(body);
    });

    it('returns null for DELETE op', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const filePath = 'test.txt';
      const del: FileVersionMetadata = {
        filePath,
        contentHash: '',
        size: 0,
        timestamp: 't',
        operation: FileOperation.DELETE,
        version: 2,
        batchId: MOCK_BATCH_ID,
      };

      jest
        .spyOn(Bee.prototype, 'makeFeedReader')
        .mockReturnValue({ download: jest.fn().mockResolvedValue({
          payload: new Bytes(new Reference('0'.repeat(64)).toUint8Array())
        }) } as any);
      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(
        new Bytes(Buffer.from(JSON.stringify(del), 'utf-8'))
      );

      const out = await fm.downloadFileVersion(filePath);
      expect(out).toBeNull();
    });

    it('handles download errors', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const filePath = 'test.txt';
      const meta: FileVersionMetadata = {
        filePath,
        contentHash: 'bad',
        size: 1,
        timestamp: 't',
        operation: FileOperation.MODIFY,
        version: 1,
        batchId: MOCK_BATCH_ID,
      };
      jest
        .spyOn(Bee.prototype, 'makeFeedReader')
        .mockReturnValue({ download: jest.fn().mockResolvedValue({
          payload: new Bytes(new Reference('1'.repeat(64)).toUint8Array())
        }) } as any);
      jest
        .spyOn(Bee.prototype, 'downloadData')
        .mockResolvedValueOnce(new Bytes(Buffer.from(JSON.stringify(meta), 'utf-8')))
        .mockRejectedValueOnce(new Error('boom'));
      jest.spyOn(console, 'error').mockImplementation();

      const out = await fm.downloadFileVersion(filePath, 1);
      expect(out).toBeNull();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(`Failed to download version content for ${filePath}`),
        expect.any(Error),
      );
    });
  });

  describe('hasFileVersionHistory', () => {
    it('true if exists', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({ download: jest.fn().mockResolvedValue({}) } as any);
      expect(await fm.hasFileVersionHistory('x')).toBe(true);
    });

    it('false if none', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({ download: jest.fn().mockRejectedValue({ status: 404 }) } as any);
      expect(await fm.hasFileVersionHistory('x')).toBe(false);
    });

    it('throws if not initialized', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManagerBase(bee);
      await expect(fm.hasFileVersionHistory('x')).rejects.toThrow();
    });
  });

  describe('createFileVersion & deleteFileVersion & getVersionedFiles', () => {
    it('createFileVersion throws if not initialized', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const fm = new FileManagerBase(bee);
      await expect(
        fm.createFileVersion(new BatchId(MOCK_BATCH_ID), './x', 'x')
      ).rejects.toThrow('FileManager not initialized');
    });

    it('deleteFileVersion records delete', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      const batch = new BatchId(MOCK_BATCH_ID);
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue({
        download: jest.fn()
          .mockResolvedValueOnce({}) // v0
          .mockResolvedValueOnce({}) // v1
          .mockRejectedValue({ status: 404 }), // v2 missing
      } as any);
      const up: UploadResult = {
        reference: new Reference('c'.repeat(64)),
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
      };
      jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue(up);
      jest.spyOn(Bee.prototype, 'makeFeedWriter').mockReturnValue({ uploadReference: jest.fn().mockResolvedValue(up) } as any);

      const v = await fm.deleteFileVersion(batch, 'x.txt', { why: 'none' });
      expect(v).toBe(2);
    });

    it('getVersionedFiles filters correctly', async () => {
      createInitMocks();
      const fm = await createInitializedFileManager();
      (fm as any).fileInfoList = [
        { name: 'a', isVersioned: true },
        { name: 'b', isVersioned: false },
        { name: 'c', isVersioned: true },
      ];
      expect(await fm.getVersionedFiles()).toEqual(['a', 'c']);
    });
  });
});
