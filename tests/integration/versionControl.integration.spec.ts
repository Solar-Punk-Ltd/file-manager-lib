// tests/integration/versionControl.integration.spec.ts

import { BatchId, BeeDev, Reference } from '@ethersphere/bee-js';
import fs from 'fs/promises';
import path from 'path';

import { FileManagerBase as FileManager } from '../../src/fileManager';
import { OWNER_STAMP_LABEL as OWNER_FEED_STAMP_LABEL } from '../../src/utils/constants';
import { FileOperation } from '../../src/utils/types';
import { buyStamp } from '../../src/utils/common';
import {
  BEE_URL,
  DEFAULT_BATCH_AMOUNT,
  DEFAULT_BATCH_DEPTH,
  MOCK_SIGNER,
} from '../utils';

describe('Version Control Integration Tests (requires Bee node)', () => {
  let bee: BeeDev;
  let fileManager: FileManager;
  let batchId: BatchId;
  let testDir: string;

  beforeAll(async () => {
    // Use BeeDev like other integration tests
    bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });

    // Ensure the owner stamp is available (buy if needed, just like working tests)
    try {
      await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, OWNER_FEED_STAMP_LABEL);
    } catch (e) {
      // Stamp already exists; ignore error (same pattern as working tests)
      void e;
    }

    // Now initialize FileManager (this will succeed because owner stamp exists)
    fileManager = new FileManager(bee);
    await fileManager.initialize();

    // Purchase a test stamp for version control operations
    try {
      batchId = await buyStamp(bee, DEFAULT_BATCH_AMOUNT, DEFAULT_BATCH_DEPTH, 'versionControlTest');
    } catch (error) {
      // If stamp already exists, find an existing one
      const stamps = await fileManager.getStamps();
      if (stamps.length > 0) {
        batchId = stamps[0].batchID;
      } else {
        throw new Error('No usable stamps found and failed to create one');
      }
    }

    // Create test directory
    testDir = path.join(__dirname, 'test-files');
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    // Clean up test directory
    try {
      await fs.rmdir(testDir, { recursive: true });
    } catch (error) {
      console.warn('Failed to clean up test directory:', error);
    }
  });

  describe('End-to-End Version Control Workflow', () => {
    it('should demonstrate complete version control lifecycle', async () => {
      const fileName = 'integration-test.txt';
      const filePath = path.join(testDir, fileName);
      const logicalPath = `integration-tests/${fileName}`;

      // Step 1: Create initial file version
      console.log('📝 Step 1: Creating initial file version...');
      
      const initialContent = 'This is the initial content of the integration test file.\nVersion 1.0\n';
      await fs.writeFile(filePath, initialContent);

      await fileManager.uploadWithVersioning(
        batchId,
        filePath,
        logicalPath,
        FileOperation.CREATE,
        undefined, undefined, undefined, undefined, undefined,
        { author: 'integration-test', purpose: 'Testing version control' }
      );

      // Verify initial version exists
      const hasHistory1 = await fileManager.hasFileVersionHistory(logicalPath);
      expect(hasHistory1).toBe(true);

      // Check version info
      const versionInfo1 = await fileManager.getFileVersionInfoByPath(logicalPath);
      expect(versionInfo1).not.toBeNull();
      expect(versionInfo1!.currentVersion).toBe(0);
      expect(versionInfo1!.totalVersions).toBe(1);

      console.log('✅ Initial version created successfully');

      // Step 2: Modify file and create second version
      console.log('📝 Step 2: Creating modified version...');
      
      const modifiedContent = 'This is the updated content of the integration test file.\nVersion 2.0\nAdded new features!\n';
      await fs.writeFile(filePath, modifiedContent);

      const version2 = await fileManager.createFileVersion(
        batchId,
        filePath,
        logicalPath,
        FileOperation.MODIFY,
        { author: 'integration-test', change: 'Added new features', editor: 'test-user' }
      );

      expect(version2).toBe(1);

      // Verify second version
      const versionInfo2 = await fileManager.getFileVersionInfoByPath(logicalPath);
      expect(versionInfo2!.currentVersion).toBe(1);
      expect(versionInfo2!.totalVersions).toBe(2);

      console.log('✅ Modified version created successfully');

      // Step 3: Create third version
      console.log('📝 Step 3: Creating final version...');
      
      const finalContent = 'This is the final content of the integration test file.\nVersion 3.0\nFixed bugs and improved performance!\nReady for production.\n';
      await fs.writeFile(filePath, finalContent);

      const version3 = await fileManager.createFileVersion(
        batchId,
        filePath,
        logicalPath,
        FileOperation.MODIFY,
        { 
          author: 'integration-test', 
          change: 'Bug fixes and performance improvements',
          reviewer: 'senior-dev',
          approved: 'true'
        }
      );

      expect(version3).toBe(2);

      console.log('✅ Final version created successfully');

      // Step 4: Get complete version history
      console.log('📜 Step 4: Retrieving complete version history...');
      
      const history = await fileManager.getFileVersionHistoryByPath(logicalPath);
      expect(history).toHaveLength(3);

      // Verify version progression
      expect(history[0].operation).toBe(FileOperation.CREATE);
      expect(history[0].version).toBe(0);
      expect(history[0].customMetadata?.purpose).toBe('Testing version control');

      expect(history[1].operation).toBe(FileOperation.MODIFY);
      expect(history[1].version).toBe(1);
      expect(history[1].customMetadata?.change).toBe('Added new features');

      expect(history[2].operation).toBe(FileOperation.MODIFY);
      expect(history[2].version).toBe(2);
      expect(history[2].customMetadata?.approved).toBe('true');

      console.log('✅ Version history verified');

      // Step 5: Download and verify specific versions
      console.log('⬇️ Step 5: Testing version downloads...');

      // Download version 0 (original)
      const version0Content = await fileManager.downloadFileVersion(logicalPath, 0);
      expect(version0Content).not.toBeNull();
      const version0Text = Buffer.from(version0Content!).toString('utf-8');
      expect(version0Text).toContain('Version 1.0');
      expect(version0Text).toContain('initial content');

      // Download version 1 (first modification)
      const version1Content = await fileManager.downloadFileVersion(logicalPath, 1);
      expect(version1Content).not.toBeNull();
      const version1Text = Buffer.from(version1Content!).toString('utf-8');
      expect(version1Text).toContain('Version 2.0');
      expect(version1Text).toContain('Added new features');

      // Download latest version (should be version 2)
      const latestContent = await fileManager.downloadFileVersion(logicalPath);
      expect(latestContent).not.toBeNull();
      const latestText = Buffer.from(latestContent!).toString('utf-8');
      expect(latestText).toContain('Version 3.0');
      expect(latestText).toContain('Ready for production');

      console.log('✅ Version downloads verified');

      // Step 6: Test specific version metadata retrieval
      console.log('🔍 Step 6: Testing version metadata retrieval...');

      const version1Metadata = await fileManager.getFileVersion(logicalPath, 1);
      expect(version1Metadata).not.toBeNull();
      expect(version1Metadata!.version).toBe(1);
      expect(version1Metadata!.operation).toBe(FileOperation.MODIFY);
      expect(version1Metadata!.customMetadata?.editor).toBe('test-user');

      const latestMetadata = await fileManager.getLatestFileVersion(logicalPath);
      expect(latestMetadata).not.toBeNull();
      expect(latestMetadata!.version).toBe(2);
      expect(latestMetadata!.customMetadata?.reviewer).toBe('senior-dev');

      console.log('✅ Version metadata verified');

      // Step 7: Test file deletion versioning
      console.log('🗑️ Step 7: Testing deletion versioning...');

      const deleteVersion = await fileManager.deleteFileVersion(
        batchId,
        logicalPath,
        { 
          deletedBy: 'integration-test', 
          reason: 'Test file no longer needed',
          approved: 'true'
        }
      );

      expect(deleteVersion).toBe(3);

      // Verify deletion is recorded in history
      const historyAfterDelete = await fileManager.getFileVersionHistoryByPath(logicalPath);
      expect(historyAfterDelete).toHaveLength(4);

      const deleteEntry = historyAfterDelete[3];
      expect(deleteEntry.operation).toBe(FileOperation.DELETE);
      expect(deleteEntry.version).toBe(3);
      expect(deleteEntry.customMetadata?.reason).toBe('Test file no longer needed');

      // Trying to download deleted version should return null
      const deletedContent = await fileManager.downloadFileVersion(logicalPath, 3);
      expect(deletedContent).toBeNull();

      console.log('✅ Deletion versioning verified');

      // Step 8: Verify final state
      console.log('📊 Step 8: Verifying final state...');

      const finalVersionInfo = await fileManager.getFileVersionInfoByPath(logicalPath);
      expect(finalVersionInfo!.currentVersion).toBe(3);
      expect(finalVersionInfo!.totalVersions).toBe(4);

      // Can still download previous versions even after deletion
      const version0AfterDelete = await fileManager.downloadFileVersion(logicalPath, 0);
      expect(version0AfterDelete).not.toBeNull();

      console.log('✅ Final state verified');

      console.log('🎉 End-to-end version control test completed successfully!');

    }, 30000); // 30 second timeout for integration test

    it('should handle multiple files with independent version histories', async () => {
      console.log('📁 Testing multiple file version histories...');

      const file1Name = 'multi-test-1.txt';
      const file2Name = 'multi-test-2.json';
      const file1Path = path.join(testDir, file1Name);
      const file2Path = path.join(testDir, file2Name);
      const logical1 = `multi-test/${file1Name}`;
      const logical2 = `multi-test/${file2Name}`;

      // Create and version first file
      await fs.writeFile(file1Path, 'Text file content v1');
      await fileManager.uploadWithVersioning(
        batchId, file1Path, logical1, FileOperation.CREATE,
        undefined, undefined, undefined, undefined, undefined,
        { type: 'text', author: 'user1' }
      );

      // Create and version second file
      const jsonContent = { name: 'test', version: 1, features: ['basic'] };
      await fs.writeFile(file2Path, JSON.stringify(jsonContent, null, 2));
      await fileManager.uploadWithVersioning(
        batchId, file2Path, logical2, FileOperation.CREATE,
        undefined, undefined, undefined, undefined, undefined,
        { type: 'json', author: 'user2' }
      );

      // Modify both files independently
      await fs.writeFile(file1Path, 'Text file content v2 - updated');
      await fileManager.createFileVersion(
        batchId, file1Path, logical1, FileOperation.MODIFY,
        { type: 'text', author: 'user1', change: 'Updated content' }
      );

      jsonContent.version = 2;
      jsonContent.features.push('advanced');
      await fs.writeFile(file2Path, JSON.stringify(jsonContent, null, 2));
      await fileManager.createFileVersion(
        batchId, file2Path, logical2, FileOperation.MODIFY,
        { type: 'json', author: 'user2', change: 'Added features' }
      );

      // Verify independent histories
      const history1 = await fileManager.getFileVersionHistoryByPath(logical1);
      const history2 = await fileManager.getFileVersionHistoryByPath(logical2);

      expect(history1).toHaveLength(2);
      expect(history2).toHaveLength(2);

      // Verify content independence
      const file1v0 = await fileManager.downloadFileVersion(logical1, 0);
      const file1v1 = await fileManager.downloadFileVersion(logical1, 1);
      
      expect(Buffer.from(file1v0!).toString()).toContain('v1');
      expect(Buffer.from(file1v1!).toString()).toContain('v2 - updated');

      const file2v0 = await fileManager.downloadFileVersion(logical2, 0);
      const file2v1 = await fileManager.downloadFileVersion(logical2, 1);

      const json1 = JSON.parse(Buffer.from(file2v0!).toString());
      const json2 = JSON.parse(Buffer.from(file2v1!).toString());

      expect(json1.version).toBe(1);
      expect(json1.features).toEqual(['basic']);
      expect(json2.version).toBe(2);
      expect(json2.features).toEqual(['basic', 'advanced']);

      console.log('✅ Multiple file version histories verified');

    }, 20000);
  });

  describe('Version Control Edge Cases', () => {
    it('should handle non-existent file version requests gracefully', async () => {
      const nonExistentPath = 'non-existent-file.txt';
      
      // Should return null/false for non-existent files
      const hasHistory = await fileManager.hasFileVersionHistory(nonExistentPath);
      expect(hasHistory).toBe(false);

      const versionInfo = await fileManager.getFileVersionInfoByPath(nonExistentPath);
      expect(versionInfo).toBeNull();

      const history = await fileManager.getFileVersionHistoryByPath(nonExistentPath);
      expect(history).toEqual([]);

      const version = await fileManager.getFileVersion(nonExistentPath, 0);
      expect(version).toBeNull();

      const content = await fileManager.downloadFileVersion(nonExistentPath, 0);
      expect(content).toBeNull();
    });

    it('should handle invalid version numbers gracefully', async () => {
      const fileName = 'edge-case-test.txt';
      const filePath = path.join(testDir, fileName);
      const logicalPath = `edge-cases/${fileName}`;

      // Create a file with one version
      await fs.writeFile(filePath, 'Edge case test content');
      await fileManager.uploadWithVersioning(
        batchId, filePath, logicalPath, FileOperation.CREATE
      );

      // Try to access version that doesn't exist yet
      const futureVersion = await fileManager.getFileVersion(logicalPath, 999);
      expect(futureVersion).toBeNull();

      const futureContent = await fileManager.downloadFileVersion(logicalPath, 999);
      expect(futureContent).toBeNull();
    });
  });
});
