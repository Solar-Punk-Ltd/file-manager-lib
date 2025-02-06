import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Bee, MantarayNode, Reference } from '@upcoming/bee-js';

import { OWNER_FEED_STAMP_LABEL, REFERENCE_LIST_TOPIC, SWARM_ZERO_ADDRESS } from '../../src/constants';
import { FileManager } from '../../src/fileManager';
import { FileInfo } from '../../src/types';
import { makeBeeRequestOptions } from '../../src/utils';
import { BEE_URL, buyStamp, getTestFile, MOCK_SIGNER, OTHER_BEE_URL, OTHER_MOCK_SIGNER } from '../utils';

describe('FileManager initialization', () => {
  beforeEach(async () => {
    const bee = new Bee(BEE_URL);
    await buyStamp(bee, OWNER_FEED_STAMP_LABEL);

    jest.resetAllMocks();
  });

  it('should create and initialize a new instance', async () => {
    const bee = new Bee(OTHER_BEE_URL);
    const fileManager = new FileManager(bee, OTHER_MOCK_SIGNER);
    try {
      await fileManager.initialize();
    } catch (error: any) {
      expect(error).toEqual('Owner stamp not found');
    }
    const stamps = await fileManager.getStamps();
    expect(stamps).toEqual([]);
    expect(fileManager.getFileInfoList()).toEqual([]);
    expect(fileManager.getSharedWithMe()).toEqual([]);
  });

  it('should fetch the owner stamp and initialize the owner feed and topic', async () => {
    const bee = new Bee(BEE_URL);
    const batchId = await buyStamp(bee, OWNER_FEED_STAMP_LABEL);
    const fileManager = new FileManager(bee, MOCK_SIGNER);
    await fileManager.initialize();
    const stamps = await fileManager.getStamps();
    const mockPubKey = (await bee.getNodeAddresses()).publicKey;

    expect(stamps[0].batchID).toEqual(batchId);
    expect(stamps[0].label).toEqual(OWNER_FEED_STAMP_LABEL);
    expect(fileManager.getCachedStamp(batchId)).toEqual(stamps[0]);
    expect(fileManager.getFileInfoList()).toEqual([]);
    expect(fileManager.getSharedWithMe()).toEqual([]);

    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 0);
    const topicHistory = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 1);
    const options = makeBeeRequestOptions(new Reference(topicHistory.payload), mockPubKey);
    const topicHex = await bee.downloadData(new Reference(feedTopicData.payload), options);

    expect(topicHex).not.toEqual(SWARM_ZERO_ADDRESS);
    // test re-initialization
    await fileManager.initialize();
    const reinitTopicHex = await bee.downloadData(new Reference(feedTopicData.payload), options);

    expect(topicHex).toEqual(reinitTopicHex);
  });

  it('should throw an error if someone else than the owner tries to read the owner feed', async () => {
    const bee = new Bee(BEE_URL);
    const otherBee = new Bee(OTHER_BEE_URL);
    const fileManager = new FileManager(bee, MOCK_SIGNER);
    await fileManager.initialize();
    const mockOtherPubKey = (await otherBee.getNodeAddresses()).publicKey;

    const feedTopicData = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 0);
    const topicHistory = await fileManager.getFeedData(REFERENCE_LIST_TOPIC, MOCK_SIGNER.publicKey().address(), 1);
    const otherOptions = makeBeeRequestOptions(new Reference(topicHistory.payload), mockOtherPubKey);

    try {
      await bee.downloadData(new Reference(feedTopicData.payload), otherOptions);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).stack?.includes('404')).toBeTruthy();
    }
  });

  it('should upload a file and save it on swarm', async () => {
    const expectedFileData = getTestFile('files/test.txt');
    const bee = new Bee(BEE_URL);
    const mockPubKey = (await bee.getNodeAddresses()).publicKey;
    const testStampId = await buyStamp(bee, 'testStamp');
    let actualFileInfo: FileInfo;
    {
      const fileManager = new FileManager(bee, MOCK_SIGNER);
      await fileManager.initialize();

      const testMantaray = new MantarayNode();
      await fileManager.upload(testStampId, testMantaray, '../tests/files/test.txt', undefined, undefined);

      const fileInfoList = fileManager.getFileInfoList();
      console.log('baogy test fileInfoList: ', fileInfoList);
      expect(fileInfoList.length).toEqual(1);

      actualFileInfo = fileInfoList[0];
      const options = makeBeeRequestOptions(actualFileInfo.historyRef, mockPubKey);
      const actualFileData = await bee.downloadFile(actualFileInfo.eFileRef, undefined, options);

      expect(actualFileData.data.toString()).toEqual(expectedFileData);
    }
    // re-init fileManager after it goes out of scope to test if the file is saved on the feed
    const fileManager = new FileManager(bee, MOCK_SIGNER);
    await fileManager.initialize();
    const fileInfoList = fileManager.getFileInfoList();
    const downloadedFileInfo = fileInfoList[0];
    expect(fileInfoList.length).toEqual(1);
    expect(downloadedFileInfo).toEqual(actualFileInfo);

    const options = makeBeeRequestOptions(downloadedFileInfo.historyRef, mockPubKey);
    const actualFileData = await bee.downloadFile(downloadedFileInfo.eFileRef, undefined, options);
    expect(actualFileData.data.toString()).toEqual(expectedFileData);
  });
});
