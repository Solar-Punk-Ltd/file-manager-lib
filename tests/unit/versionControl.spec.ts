import {
  Bee,
  BatchId,
  Topic,
  Reference,
  FeedIndex,
  Bytes,
  UploadResult,
} from '@ethersphere/bee-js';
import { Optional } from 'cafe-utility';

import {
  generateFileFeedTopic,
  getFileVersionCount,
  writeFileVersionMetadata,
  readFileVersionMetadata,
  getFileVersionHistory,
  getFileVersionInfo,
  calculateContentHash,
  hasVersionHistory,
} from '../../src/utils/versionControl';
import { FileVersionMetadata, FileOperation } from '../../src/utils/types';
import { SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { BEE_URL, MOCK_SIGNER } from '../utils';

describe('Version Control Utilities', () => {
  const MOCK_BATCH_ID = 'ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51';
  const mockOwnerAddress = '0x' + '1'.repeat(40);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('generateFileFeedTopic', () => {
    it('should generate deterministic topic for the same file path', () => {
      const filePath = 'documents/test.txt';
      const topic1 = generateFileFeedTopic(filePath);
      const topic2 = generateFileFeedTopic(filePath);
      
      expect(topic1.toString()).toBe(topic2.toString());
    });

    it('should generate different topics for different file paths', () => {
      const topic1 = generateFileFeedTopic('documents/test1.txt');
      const topic2 = generateFileFeedTopic('documents/test2.txt');
      
      expect(topic1.toString()).not.toBe(topic2.toString());
    });

    it('should normalize path separators', () => {
      const topic1 = generateFileFeedTopic('documents/test.txt');
      const topic2 = generateFileFeedTopic('documents\\test.txt');
      
      expect(topic1.toString()).toBe(topic2.toString());
    });

    it('should include file_version prefix in hash', () => {
      const filePath = 'test.txt';
      const topic = generateFileFeedTopic(filePath);
      
      expect(topic).toBeInstanceOf(Topic);
      expect(topic.toString()).toHaveLength(64); // 32 bytes = 64 hex chars
    });
  });

  describe('getFileVersionCount', () => {
    it('should return -1 if no versions exist', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const topic = generateFileFeedTopic('test.txt');
      
      const mockFeedReader = {
        download: jest.fn().mockRejectedValue({ status: 404 }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const count = await getFileVersionCount(bee, topic, mockOwnerAddress);
      
      expect(count).toBe(-1n);
      expect(mockFeedReader.download).toHaveBeenCalledWith({ index: FeedIndex.fromBigInt(0n) });
    });

    it('should return 0 if only version 0 exists', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const topic = generateFileFeedTopic('test.txt');
      
      const mockFeedReader = {
        download: jest.fn()
          .mockResolvedValueOnce({}) // version 0 exists
          .mockRejectedValue({ status: 404 }), // version 1 doesn't exist
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const count = await getFileVersionCount(bee, topic, mockOwnerAddress);
      
      expect(count).toBe(0n);
    });

    it('should return correct count for multiple versions', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const topic = generateFileFeedTopic('test.txt');
      
      const mockFeedReader = {
        download: jest.fn()
          .mockResolvedValueOnce({}) // version 0
          .mockResolvedValueOnce({}) // version 1
          .mockResolvedValueOnce({}) // version 2
          .mockRejectedValue({ status: 404 }), // version 3 doesn't exist
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const count = await getFileVersionCount(bee, topic, mockOwnerAddress);
      
      expect(count).toBe(2n);
    });

    it('should propagate non-404 errors', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const topic = generateFileFeedTopic('test.txt');
      
      const mockFeedReader = {
        download: jest.fn().mockRejectedValue(new Error('Network error')),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      await expect(getFileVersionCount(bee, topic, mockOwnerAddress)).rejects.toThrow('Network error');
    });
  });

  describe('writeFileVersionMetadata', () => {
    it('should write metadata to feed and return version number', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const signer = MOCK_SIGNER;
      const filePath = 'test.txt';
      const batchId = new BatchId(MOCK_BATCH_ID);
      
      const metadata: FileVersionMetadata = {
        filePath,
        contentHash: 'abc123',
        size: 1024,
        timestamp: '',
        operation: FileOperation.CREATE,
        version: 0,
        batchId: batchId.toString(),
      };

      // Mock getFileVersionCount to return -1 (no versions)
      const mockFeedReader = {
        download: jest.fn().mockRejectedValue({ status: 404 }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      // Mock uploadData
      const mockUploadResult: UploadResult = {
        reference: new Reference('a'.repeat(64)),
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
      };
      jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue(mockUploadResult);

      // Mock makeFeedWriter
      const mockFeedWriter = {
        uploadReference: jest.fn().mockResolvedValue(mockUploadResult),
      };
      jest.spyOn(Bee.prototype, 'makeFeedWriter').mockReturnValue(mockFeedWriter as any);

      const version = await writeFileVersionMetadata(bee, signer, filePath, batchId, metadata);
      
      expect(version).toBe(0);
      expect(mockFeedWriter.uploadReference).toHaveBeenCalledWith(
        batchId,
        mockUploadResult.reference,
        { index: FeedIndex.fromBigInt(0n) }
      );
    });

    it('should increment version number for subsequent writes', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const signer = MOCK_SIGNER;
      const filePath = 'test.txt';
      const batchId = new BatchId(MOCK_BATCH_ID);
      
      const metadata: FileVersionMetadata = {
        filePath,
        contentHash: 'abc123',
        size: 1024,
        timestamp: '',
        operation: FileOperation.MODIFY,
        version: 0,
        batchId: batchId.toString(),
      };

      // Mock getFileVersionCount to return 1 (version 0 exists)
      const mockFeedReader = {
        download: jest.fn()
          .mockResolvedValueOnce({}) // version 0 exists
          .mockRejectedValue({ status: 404 }), // version 1 doesn't exist
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const mockUploadResult: UploadResult = {
        reference: new Reference('b'.repeat(64)),
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
      };
      jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue(mockUploadResult);

      const mockFeedWriter = {
        uploadReference: jest.fn().mockResolvedValue(mockUploadResult),
      };
      jest.spyOn(Bee.prototype, 'makeFeedWriter').mockReturnValue(mockFeedWriter as any);

      const version = await writeFileVersionMetadata(bee, signer, filePath, batchId, metadata);
      
      expect(version).toBe(1);
      expect(mockFeedWriter.uploadReference).toHaveBeenCalledWith(
        batchId,
        mockUploadResult.reference,
        { index: FeedIndex.fromBigInt(1n) }
      );
    });

    it('should set timestamp in metadata', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const signer = MOCK_SIGNER;
      const filePath = 'test.txt';
      const batchId = new BatchId(MOCK_BATCH_ID);
      
      const metadata: FileVersionMetadata = {
        filePath,
        contentHash: 'abc123',
        size: 1024,
        timestamp: '',
        operation: FileOperation.CREATE,
        version: 0,
        batchId: batchId.toString(),
      };

      const mockFeedReader = {
        download: jest.fn().mockRejectedValue({ status: 404 }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      let uploadedData: string;
      jest.spyOn(Bee.prototype, 'uploadData').mockImplementation(async (batchId, data) => {
        uploadedData = Buffer.from(data as Uint8Array).toString('utf-8');
        return {
          reference: new Reference('c'.repeat(64)),
          historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
        };
      });

      const mockFeedWriter = {
        uploadReference: jest.fn().mockResolvedValue({
          reference: new Reference('c'.repeat(64)),
          historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
        }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedWriter').mockReturnValue(mockFeedWriter as any);

      await writeFileVersionMetadata(bee, signer, filePath, batchId, metadata);
      
      const uploadedMetadata = JSON.parse(uploadedData!);
      expect(uploadedMetadata.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO timestamp format
      expect(uploadedMetadata.version).toBe(0);
    });
  });

  describe('readFileVersionMetadata', () => {
    it('should return null if no versions exist', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const mockFeedReader = {
        download: jest.fn().mockRejectedValue({ status: 404 }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const result = await readFileVersionMetadata(bee, filePath, mockOwnerAddress);
      
      expect(result).toBeNull();
    });

    it('should return metadata for specific version', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const expectedMetadata: FileVersionMetadata = {
        filePath,
        contentHash: 'abc123',
        size: 1024,
        timestamp: '2024-01-15T10:30:00.000Z',
        operation: FileOperation.CREATE,
        version: 0,
        batchId: MOCK_BATCH_ID,
      };

      const mockFeedReader = {
        download: jest.fn().mockResolvedValue({
          payload: new Bytes(new Reference('d'.repeat(64)).toUint8Array()),
        }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(
        new Bytes(Buffer.from(JSON.stringify(expectedMetadata), 'utf-8'))
      );

      const result = await readFileVersionMetadata(bee, filePath, mockOwnerAddress, 0);
      
      expect(result).toEqual(expectedMetadata);
      expect(mockFeedReader.download).toHaveBeenCalledWith({ index: FeedIndex.fromBigInt(0n) });
    });

    it('should return latest version when no version specified', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const expectedMetadata: FileVersionMetadata = {
        filePath,
        contentHash: 'xyz789',
        size: 2048,
        timestamp: '2024-01-15T11:30:00.000Z',
        operation: FileOperation.MODIFY,
        version: 1,
        batchId: MOCK_BATCH_ID,
      };

      // Mock version count check
      const mockFeedReader = {
        download: jest.fn()
          .mockResolvedValueOnce({}) // version 0 exists
          .mockRejectedValueOnce({ status: 404 }) // version 1 doesn't exist (for count check)
          .mockResolvedValueOnce({ // actual download for version 0 (latest)
            payload: new Bytes(new Reference('e'.repeat(64)).toUint8Array()),
          }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(
        new Bytes(Buffer.from(JSON.stringify(expectedMetadata), 'utf-8'))
      );

      const result = await readFileVersionMetadata(bee, filePath, mockOwnerAddress);
      
      expect(result).toEqual(expectedMetadata);
    });

    it('should return null for SWARM_ZERO_ADDRESS reference', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const mockFeedReader = {
        download: jest.fn().mockResolvedValue({
          payload: new Bytes(SWARM_ZERO_ADDRESS),
        }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const result = await readFileVersionMetadata(bee, filePath, mockOwnerAddress, 0);
      
      expect(result).toBeNull();
    });
  });

  describe('getFileVersionHistory', () => {
    it('should return empty array if no versions exist', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const mockFeedReader = {
        download: jest.fn().mockRejectedValue({ status: 404 }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const history = await getFileVersionHistory(bee, filePath, mockOwnerAddress);
      
      expect(history).toEqual([]);
    });

    it('should return complete history for all versions', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const version0: FileVersionMetadata = {
        filePath,
        contentHash: 'abc123',
        size: 1024,
        timestamp: '2024-01-15T10:30:00.000Z',
        operation: FileOperation.CREATE,
        version: 0,
        batchId: MOCK_BATCH_ID,
      };

      const version1: FileVersionMetadata = {
        filePath,
        contentHash: 'def456',
        size: 1536,
        timestamp: '2024-01-15T11:30:00.000Z',
        operation: FileOperation.MODIFY,
        version: 1,
        batchId: MOCK_BATCH_ID,
      };

      // Mock version count check
      const mockFeedReader = {
        download: jest.fn()
          .mockResolvedValueOnce({}) // version 0 exists
          .mockResolvedValueOnce({}) // version 1 exists
          .mockRejectedValueOnce({ status: 404 }) // version 2 doesn't exist
          .mockResolvedValueOnce({ // download version 0
            payload: new Bytes(new Reference('f'.repeat(64)).toUint8Array()),
          })
          .mockResolvedValueOnce({ // download version 1
            payload: new Bytes(new Reference('0123456789abcdef'.repeat(4)).toUint8Array()),
          }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      jest.spyOn(Bee.prototype, 'downloadData')
        .mockResolvedValueOnce(new Bytes(Buffer.from(JSON.stringify(version0), 'utf-8')))
        .mockResolvedValueOnce(new Bytes(Buffer.from(JSON.stringify(version1), 'utf-8')));

      const history = await getFileVersionHistory(bee, filePath, mockOwnerAddress);
      
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual(version0);
      expect(history[1]).toEqual(version1);
    });
  });

  describe('getFileVersionInfo', () => {
    it('should return null if no versions exist', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const mockFeedReader = {
        download: jest.fn().mockRejectedValue({ status: 404 }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const info = await getFileVersionInfo(bee, filePath, mockOwnerAddress);
      
      expect(info).toBeNull();
    });

    it('should return correct version info', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const latestMetadata: FileVersionMetadata = {
        filePath,
        contentHash: 'xyz789',
        size: 2048,
        timestamp: '2024-01-15T12:30:00.000Z',
        operation: FileOperation.MODIFY,
        version: 2,
        batchId: MOCK_BATCH_ID,
      };

      // Mock version count (3 versions: 0, 1, 2)
      let callCount = 0;
      const mockFeedReader = {
        download: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount <= 3) {
            return Promise.resolve({}); // versions 0, 1, 2 exist
          } else if (callCount === 4) {
            return Promise.reject({ status: 404 }); // version 3 doesn't exist
          } else {
            // download latest version (2)
            return Promise.resolve({
              payload: new Bytes(new Reference('fedcba9876543210'.repeat(4)).toUint8Array()),
            });
          }
        }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      jest.spyOn(Bee.prototype, 'downloadData').mockResolvedValue(
        new Bytes(Buffer.from(JSON.stringify(latestMetadata), 'utf-8'))
      );

      const info = await getFileVersionInfo(bee, filePath, mockOwnerAddress);
      
      expect(info).toEqual({
        currentVersion: 2,
        totalVersions: 3,
        latestTimestamp: '2024-01-15T12:30:00.000Z',
        feedTopic: generateFileFeedTopic(filePath).toString(),
      });
    });
  });

  describe('calculateContentHash', () => {
    it('should upload data and return reference', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const batchId = new BatchId(MOCK_BATCH_ID);
      const data = Buffer.from('test content', 'utf-8');
      
      const expectedReference = new Reference('abcdef1234567890'.repeat(4));
      jest.spyOn(Bee.prototype, 'uploadData').mockResolvedValue({
        reference: expectedReference,
        historyAddress: Optional.of(new Reference(SWARM_ZERO_ADDRESS)),
      });

      const hash = await calculateContentHash(bee, batchId, data);
      
      expect(hash).toBe(expectedReference.toString());
      expect(Bee.prototype.uploadData).toHaveBeenCalledWith(batchId, new Uint8Array(data), { pin: true });
    });
  });

  describe('hasVersionHistory', () => {
    it('should return false if no versions exist', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const mockFeedReader = {
        download: jest.fn().mockRejectedValue({ status: 404 }),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const hasHistory = await hasVersionHistory(bee, filePath, mockOwnerAddress);
      
      expect(hasHistory).toBe(false);
    });

    it('should return true if versions exist', async () => {
      const bee = new Bee(BEE_URL, { signer: MOCK_SIGNER });
      const filePath = 'test.txt';
      
      const mockFeedReader = {
        download: jest.fn().mockResolvedValue({}),
      };
      jest.spyOn(Bee.prototype, 'makeFeedReader').mockReturnValue(mockFeedReader as any);

      const hasHistory = await hasVersionHistory(bee, filePath, mockOwnerAddress);
      
      expect(hasHistory).toBe(true);
    });
  });
}); 
