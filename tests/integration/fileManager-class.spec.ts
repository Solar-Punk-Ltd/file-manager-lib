import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BeeDev, Reference } from '@upcoming/bee-js';

import { FileManager } from '../../src/fileManager';
import { OWNER_FEED_STAMP_LABEL, REFERENCE_LIST_TOPIC, SWARM_ZERO_ADDRESS } from '../../src/utils/constants';
import { StampError } from '../../src/utils/errors';
import { FileInfo } from '../../src/utils/types';
import { BEE_URL, buyStamp, getTestFile, MOCK_SIGNER, OTHER_BEE_URL, OTHER_MOCK_SIGNER } from '../utils';

describe('FileManager initialization', () => {
  beforeEach(async () => {
    const bee = new BeeDev(BEE_URL);
    await buyStamp(bee, OWNER_FEED_STAMP_LABEL);

    jest.resetAllMocks();
  });

  it('should create and initialize a new instance', async () => {
    const bee = new BeeDev(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });
    const fileManager = new FileManager(bee);
    try {
      await fileManager.initialize();
    } catch (error: any) {
      expect(error).toBeInstanceOf(StampError);
      expect(error.message).toContain('Owner stamp not found');
    }
    const stamps = await fileManager.getStamps();
    expect(stamps).toEqual([]);
    expect(fileManager.getFileInfoList()).toEqual([]);
    expect(fileManager.getSharedWithMe()).toEqual([]);
    expect(fileManager.getNodeAddresses().publicKey).not.toEqual(undefined);
  });

  it('should fetch the owner stamp and initialize the owner feed and topic', async () => {
    const bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    const batchId = await buyStamp(bee, OWNER_FEED_STAMP_LABEL);
    const fileManager = new FileManager(bee);
    await fileManager.initialize();
    const stamps = await fileManager.getStamps();
    const publsiherPublicKey = fileManager.getNodeAddresses().publicKey;

    expect(stamps[0].batchID).toEqual(batchId);
    expect(stamps[0].label).toEqual(OWNER_FEED_STAMP_LABEL);
    expect(fileManager.getFileInfoList()).toEqual([]);
    expect(fileManager.getSharedWithMe()).toEqual([]);

    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 0);
    const topicHistory = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 1);
    const topicHex = await bee.downloadData(new Reference(feedTopicData.payload), {
      actHistoryAddress: new Reference(topicHistory.payload),
      actPublisher: publsiherPublicKey,
    });

    expect(topicHex).not.toEqual(SWARM_ZERO_ADDRESS);
    // test re-initialization
    await fileManager.initialize();
    const reinitTopicHex = await bee.downloadData(new Reference(feedTopicData.payload), {
      actHistoryAddress: new Reference(topicHistory.payload),
      actPublisher: publsiherPublicKey,
    });

    expect(topicHex).toEqual(reinitTopicHex);
  });

  it('should throw an error if someone else than the owner tries to read the owner feed', async () => {
    const bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    const otherBee = new BeeDev(OTHER_BEE_URL, { signer: OTHER_MOCK_SIGNER });
    const fileManager = new FileManager(bee);
    await fileManager.initialize();
    const publsiherPublicKey = fileManager.getNodeAddresses().publicKey;

    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 0, MOCK_SIGNER.publicKey().address());
    const topicHistory = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, 1, MOCK_SIGNER.publicKey().address());

    try {
      await bee.downloadData(new Reference(feedTopicData.payload), {
        actHistoryAddress: new Reference(topicHistory.payload),
        actPublisher: OTHER_MOCK_SIGNER.publicKey(),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).stack?.includes('404')).toBeTruthy();
    }

    try {
      await otherBee.downloadData(new Reference(feedTopicData.payload), {
        actHistoryAddress: new Reference(topicHistory.payload),
        actPublisher: publsiherPublicKey,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).stack?.includes('500')).toBeTruthy();
    }
  });

  it('should upload a file and save it on swarm', async () => {
    const expectedFileData = getTestFile('fixtures/test.txt');
    const bee = new BeeDev(BEE_URL, { signer: MOCK_SIGNER });
    const testStampId = await buyStamp(bee, 'testStamp');
    let actualFileInfo: FileInfo;
    {
      const fileManager = new FileManager(bee);
      await fileManager.initialize();
      const publsiherPublicKey = fileManager.getNodeAddresses().publicKey;
      // TODO: readfile path handling
      await fileManager.upload(testStampId, '../../tests/fixtures/test.txt');

      const fileInfoList = fileManager.getFileInfoList();
      console.log('baogy test fileInfoList: ', fileInfoList);
      expect(fileInfoList.length).toEqual(1);

      actualFileInfo = fileInfoList[0];
      const actualFileData = await bee.downloadFile(actualFileInfo.eFileRef, undefined, {
        actHistoryAddress: actualFileInfo.historyRef as Reference,
        actPublisher: publsiherPublicKey,
      });

      expect(actualFileData.data.toUtf8()).toEqual(expectedFileData);
    }
    // re-init fileManager after it goes out of scope to test if the file is saved on the feed
    const fileManager = new FileManager(bee);
    await fileManager.initialize();
    const publsiherPublicKey = fileManager.getNodeAddresses().publicKey;

    const fileInfoList = fileManager.getFileInfoList();
    const downloadedFileInfo = fileInfoList[0];
    expect(fileInfoList.length).toEqual(1);
    expect(downloadedFileInfo).toEqual(actualFileInfo);

    const actualFileData = await bee.downloadFile(downloadedFileInfo.eFileRef, undefined, {
      actHistoryAddress: downloadedFileInfo.historyRef,
      actPublisher: publsiherPublicKey,
    });
    expect(actualFileData.data.toUtf8()).toEqual(expectedFileData);
  });
});
