import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Bytes,
  EthAddress,
  GetGranteesResult,
  GranteesResult,
  MantarayNode,
  NodeAddresses,
  NULL_TOPIC,
  PostageBatch,
  PrivateKey,
  PssSubscription,
  RedundancyLevel,
  Reference,
  STAMPS_DEPTH_MAX,
  Topic,
  UploadOptions,
  Utils,
} from '@upcoming/bee-js';
import { readFileSync } from 'fs';
import path from 'path';

import {
  FILE_INFO_LOCAL_STORAGE,
  OWNER_FEED_STAMP_LABEL,
  REFERENCE_LIST_TOPIC,
  SHARED_INBOX_TOPIC,
  SWARM_ZERO_ADDRESS,
} from './utils/constants';
import { BeeVersionError, StampError } from './utils/errors';
import { FetchFeedUpdateResponse, FileInfo, ReferenceWithHistory, ShareItem, WrappedFileInoFeed } from './utils/types';
import {
  assertFileInfo,
  assertReferenceWithHistory,
  assertShareItem,
  assertWrappedFileInoFeed,
  getContentType,
  getRandomTopic,
  isNotFoundError,
  makeBeeRequestOptions,
  makeNumericIndex,
  numberToFeedIndex,
} from './utils/utils';

export class FileManager {
  private bee: Bee;
  private signer: PrivateKey;
  private nodeAddresses: NodeAddresses;
  private stampList: PostageBatch[];
  private fileInfoFeedList: WrappedFileInoFeed[];
  private fileInfoList: FileInfo[];
  private nextOwnerFeedIndex: number;
  private sharedWithMe: ShareItem[];
  private sharedSubscription: PssSubscription | undefined;
  private ownerFeedTopic: Topic;

  constructor(bee: Bee) {
    this.bee = bee;
    if (!this.bee.signer) {
      throw new Error('Signer required');
    }
    this.signer = this.bee.signer;
    this.stampList = [];
    this.fileInfoList = [];
    this.fileInfoFeedList = [];
    this.nextOwnerFeedIndex = 0;
    this.ownerFeedTopic = NULL_TOPIC;
    this.sharedWithMe = [];
    this.sharedSubscription = undefined;
  }

  // Start init methods
  async initialize(): Promise<void> {
    await this.verifySupportedVersions();
    await this.initNodeAddresses();
    await this.initStamps();
    await this.initOwnerFeedTopic();
    await this.iniFileInfoFeedList();
    await this.initFileInfoList();
  }

  private async verifySupportedVersions(): Promise<void> {
    const beeVersions = await this.bee.getVersions();
    console.log(`Bee version: ${beeVersions.beeVersion}`);
    console.log(`Bee API version: ${beeVersions.beeApiVersion}`);
    const supportedBee = await this.bee.isSupportedExactVersion();
    const supportedApi = await this.bee.isSupportedApiVersion();
    const majorVersionMatch =
      beeVersions.beeVersion.substring(0, 4) === beeVersions.supportedBeeVersion.substring(0, 4);
    if ((!supportedBee && !majorVersionMatch) || !supportedApi) {
      console.log('Supported bee API version: ', beeVersions.supportedBeeApiVersion);
      console.log('Supported bee version: ', beeVersions.supportedBeeVersion);
      throw new BeeVersionError('Bee or Bee API version not supported');
    }
  }

  private async initNodeAddresses(): Promise<void> {
    this.nodeAddresses = await this.bee.getNodeAddresses();
  }

  private async initOwnerFeedTopic(): Promise<void> {
    const feedTopicData = await this.getFeedData(REFERENCE_LIST_TOPIC, 0);

    if (feedTopicData.payload === SWARM_ZERO_ADDRESS) {
      const ownerFeedStamp = this.getOwnerFeedStamp();
      if (ownerFeedStamp === undefined) {
        throw new StampError('Owner stamp not found');
      }

      this.ownerFeedTopic = getRandomTopic();
      const topicDataRes = await this.bee.uploadData(ownerFeedStamp.batchID, this.ownerFeedTopic.toUint8Array(), {
        act: true,
      });
      const fw = this.bee.makeFeedWriter(REFERENCE_LIST_TOPIC, this.signer);
      await fw.upload(ownerFeedStamp.batchID, topicDataRes.reference, { index: numberToFeedIndex(0) });
      await fw.upload(ownerFeedStamp.batchID, topicDataRes.historyAddress, {
        index: numberToFeedIndex(1),
      });
    } else {
      const topicHistory = await this.getFeedData(REFERENCE_LIST_TOPIC, 1);
      const options = makeBeeRequestOptions(new Reference(topicHistory.payload), this.nodeAddresses.publicKey);

      const topicBytes = await this.bee.downloadData(new Reference(feedTopicData.payload), options);
      this.ownerFeedTopic = new Topic(topicBytes);
    }
  }

  private async initStamps(): Promise<void> {
    try {
      this.stampList = await this.getUsableStamps();
      console.log('Usable stamps fetched successfully.');
    } catch (error: any) {
      console.error(`Failed to fetch stamps: ${error}`);
    }
  }

  private async iniFileInfoFeedList(): Promise<void> {
    const latestFeedData = await this.getFeedData(this.ownerFeedTopic);
    if (latestFeedData.payload === SWARM_ZERO_ADDRESS) {
      console.log("Owner fileInfo feed list doesn't exist yet.");
      return;
    }

    this.nextOwnerFeedIndex = makeNumericIndex(latestFeedData.feedIndexNext);
    const refWithHistory = latestFeedData.payload.toJSON() as ReferenceWithHistory;
    assertReferenceWithHistory(refWithHistory);

    const options = makeBeeRequestOptions(refWithHistory.historyRef as Reference, this.nodeAddresses.publicKey);
    const fileInfoFeedListRawData = await this.bee.downloadData(refWithHistory.reference, options);
    const fileInfoFeedListData = fileInfoFeedListRawData.toJSON() as WrappedFileInoFeed[];

    for (const feedItem of fileInfoFeedListData) {
      try {
        assertWrappedFileInoFeed(feedItem);
        this.fileInfoFeedList.push(feedItem);
      } catch (error: any) {
        console.error(`Invalid WrappedFileInoFeed item, skipping it: ${error}`);
      }
    }

    console.log('FileInfo feed list fetched successfully.');
  }

  // Start mantaray methods
  private async saveMantaray(batchId: BatchId, mantaray: MantarayNode, options?: UploadOptions): Promise<Reference> {
    return mantaray.saveRecursively(this.bee, batchId, options);
  }

  private async loadMantaray(mantarayRef: Reference): Promise<MantarayNode> {
    const mantaray = await MantarayNode.unmarshal(this.bee, mantarayRef);
    await mantaray.loadRecursively(this.bee);
    return mantaray;
  }
  // TODO: use node.find() - it does not seem to work - test it
  private async getForkData(mantaray: MantarayNode, forkPath: string, options?: BeeRequestOptions): Promise<Bytes> {
    const node = mantaray.collect().find((n) => n.fullPathString === forkPath);
    if (!node) return SWARM_ZERO_ADDRESS;
    const targetRef = new Reference(node.targetAddress);

    return await this.bee.downloadData(targetRef, options);
  }
  // End mantaray methods

  // TODO: at this point we already have the efilerRef, so we can use it to fetch the data
  // TODO: loadallnodes and deserialize works but load() doesn't work -> why ?
  // TODO: already unwrapped historyRef by bee ?
  private async initFileInfoList(): Promise<void> {
    // TODO: leave publickey get out of the for loop
    for (const feedItem of this.fileInfoFeedList) {
      console.log('bagoy feedItem: ', feedItem);
      // const feedOptions = makeBeeRequestOptions(feedItem.historyRef,  this.nodeAddresses.publicKey);
      const fileInfoFeedData = await this.getFeedData(
        feedItem.reference as Topic,
        0, // TODO: if index is provided then it calls the chunk api, if undefined then it calls the feed api to lookup
        // feedOptions, // TODO: commented out the act options because it can download without it but whyy ? it was uploaded via act
      );

      if (fileInfoFeedData.payload === SWARM_ZERO_ADDRESS) {
        console.log(`feedItem not found, skipping it, reference: ${feedItem.reference.toString()}`);
        continue;
      }

      const wrappedFileInfoRef = new Reference(fileInfoFeedData.payload);
      const wrappedFileInfoData = (await this.bee.downloadData(wrappedFileInfoRef)).toJSON() as ReferenceWithHistory;
      assertReferenceWithHistory(wrappedFileInfoData);

      const options = makeBeeRequestOptions(
        new Reference(wrappedFileInfoData.historyRef),
        this.nodeAddresses.publicKey,
      );
      const fileInfoData = (
        await this.bee.downloadData(wrappedFileInfoData.reference, options)
      ).toJSON() as ReferenceWithHistory;

      try {
        assertFileInfo(fileInfoData);
        this.fileInfoList.push(fileInfoData);
      } catch (error: any) {
        console.error(`Invalid FileInfo item, skipping it: ${error}`);
      }
    }

    console.log('File info list fetched successfully.');
  }

  // End init methods

  // Start getter methods
  getFileInfoList(): FileInfo[] {
    return this.fileInfoList;
  }

  getSharedWithMe(): ShareItem[] {
    return this.sharedWithMe;
  }

  getNodeAddresses(): NodeAddresses {
    return this.nodeAddresses;
  }
  // End getter methods

  // TODO: use all the params of the currentfileinfo if exists?
  // TODO: batchId vs currentFileInfo.batchId ?
  // TODO: assemble a mantaray structure from the filepath/folderpath
  async upload(batchId: BatchId, file: string, currentFileInfo?: FileInfo): Promise<void> {
    const redundancyLevel = currentFileInfo?.redundancyLevel || RedundancyLevel.MEDIUM;
    const uploadFileRes = await this.uploadFile(batchId, file, currentFileInfo);

    // TODO: store feed index in fileinfo to speed up upload? -> undifined == 0, index otherwise
    const topic = currentFileInfo?.topic || getRandomTopic();
    // need .toString() for the stringify
    const fileInfoResult = await this.uploadFileInfo({
      batchId: batchId.toString(),
      eFileRef: uploadFileRes.reference.toString(),
      topic: topic.toString(),
      historyRef: uploadFileRes.historyRef.toString(),
      owner: this.nodeAddresses.ethereum.toString(),
      fileName: path.basename(file),
      timestamp: new Date().getTime(),
      shared: false,
      preview: currentFileInfo?.preview,
      redundancyLevel: redundancyLevel,
      customMetadata: currentFileInfo?.customMetadata,
    });

    await this.updateFileInfoFeed(batchId, fileInfoResult, topic as Topic);

    await this.saveFileInfoFeedList();
  }

  private async uploadFile(
    batchId: BatchId,
    file: string,
    currentFileInfo: FileInfo | undefined = undefined,
  ): Promise<ReferenceWithHistory> {
    console.log(`Uploading file: ${file}`);
    const filePath = path.resolve(__dirname, file);
    const fileData = new Uint8Array(readFileSync(filePath));
    const fileName = path.basename(file);
    const contentType = getContentType(file);

    try {
      const options = makeBeeRequestOptions(currentFileInfo?.historyRef as Reference);
      const uploadFileRes = await this.bee.uploadFile(
        batchId,
        fileData,
        fileName,
        {
          act: true,
          redundancyLevel: currentFileInfo?.redundancyLevel || RedundancyLevel.MEDIUM,
          contentType: contentType,
        },
        options,
      );

      console.log(`File uploaded successfully: ${fileName}, Reference: ${uploadFileRes.reference.toString()}`);
      return { reference: uploadFileRes.reference, historyRef: new Reference(uploadFileRes.historyAddress) };
    } catch (error: any) {
      throw `Failed to upload file ${file}: ${error}`;
    }
  }

  private async uploadFileInfo(fileInfo: FileInfo): Promise<ReferenceWithHistory> {
    try {
      const uploadInfoRes = await this.bee.uploadData(fileInfo.batchId, JSON.stringify(fileInfo), {
        act: true,
        redundancyLevel: fileInfo.redundancyLevel,
      });
      console.log('Fileinfo updated: ', uploadInfoRes.reference.toString());

      this.fileInfoList.push(fileInfo);

      return { reference: uploadInfoRes.reference, historyRef: new Reference(uploadInfoRes.historyAddress) };
    } catch (error: any) {
      throw `Failed to save fileinfo: ${error}`;
    }
  }

  private async updateFileInfoFeed(
    batchId: BatchId,
    fileInfoResult: ReferenceWithHistory,
    topic: Topic,
    redundancyLevel: RedundancyLevel = RedundancyLevel.MEDIUM,
  ): Promise<void> {
    try {
      console.log('bagoy fileInfoResult.reference.toString(): ', fileInfoResult.reference.toString());
      console.log('bagoy fileInfoResult.historyRef.toString(): ', new Reference(fileInfoResult.historyRef).toString());
      // TODO: wrapper for uploadData
      const uploadInfoRes = await this.bee.uploadData(
        batchId,
        JSON.stringify({
          reference: fileInfoResult.reference.toString(),
          historyRef: fileInfoResult.historyRef.toString(),
        }),
        {
          redundancyLevel: redundancyLevel,
        },
      );
      const fw = this.bee.makeFeedWriter(topic, this.signer);
      const wrappedFeedUpdateRes = await fw.upload(batchId, uploadInfoRes.reference, {
        index: undefined, // todo: keep track of the latest index ??
        act: true, // TODO: shall this call to /soc post api ?
      });
      console.log('bagoy wrappedFeedUpdateRes.reference.toString(): ', wrappedFeedUpdateRes.reference.toString());
      console.log(
        'bagoy wrappedFeedUpdateRes.historyRef.toString(): ',
        new Reference(wrappedFeedUpdateRes.historyAddress).toString(),
      );
      const feedUpdate: WrappedFileInoFeed = {
        reference: topic.toString(),
        historyRef: wrappedFeedUpdateRes.historyAddress.toString(),
        eFileRef: fileInfoResult.reference.toString(), // TODO: why  fileInfoRes.reference instead of eFileRef ? -> might not be needed
      };

      const ix = this.fileInfoFeedList.findIndex((f) => f.reference === feedUpdate.reference);
      if (ix !== -1) {
        this.fileInfoFeedList[ix] = { ...feedUpdate, eGranteeRef: this.fileInfoFeedList[ix].eGranteeRef };
      } else {
        this.fileInfoFeedList.push(feedUpdate);
      }
    } catch (error: any) {
      throw `Failed to save wrapped fileInfo feed: ${error}`;
    }
  }

  // Start owner fileInfo feed handler methods
  private async saveFileInfoFeedList(): Promise<void> {
    const ownerFeedStamp = this.getOwnerFeedStamp();
    if (!ownerFeedStamp) {
      throw 'Owner feed stamp is not found.';
    }

    try {
      const fileInfoFeedListData = await this.bee.uploadData(
        ownerFeedStamp.batchID,
        JSON.stringify(this.fileInfoFeedList),
        {
          act: true,
        },
      );

      const fw = this.bee.makeFeedWriter(this.ownerFeedTopic, this.signer);
      const ownerFeedRawData = await this.bee.uploadData(
        ownerFeedStamp.batchID,
        JSON.stringify({
          reference: fileInfoFeedListData.reference.toString(),
          historyRef: fileInfoFeedListData.historyAddress.toString(),
        }),
      );
      const writeResult = await fw.upload(ownerFeedStamp.batchID, ownerFeedRawData.reference, {
        index: this.nextOwnerFeedIndex,
      });

      console.log('Owner feed list updated: ', writeResult.reference.toString());
      this.nextOwnerFeedIndex += 1;
    } catch (error: any) {
      throw `Failed to update owner feed list: ${error}`;
    }
  }
  // End owner fileInfo feed handler methods

  // Start grantee handler methods
  // fetches the list of grantees who can access the file reference
  async getGranteesOfFile(eFileRef: Reference): Promise<GetGranteesResult> {
    const mf = this.fileInfoFeedList.find((f) => f.eFileRef === eFileRef);
    if (mf?.eGranteeRef === undefined) {
      throw `Grantee list not found for file reference: ${eFileRef}`;
    }

    return this.bee.getGrantees(mf.eGranteeRef);
  }

  // TODO: only add is supported
  // updates the list of grantees who can access the file reference under the history reference
  private async handleGrantees(
    fileInfo: FileInfo,
    grantees: {
      add?: string[];
      revoke?: string[];
    },
    eGlRef?: string | Reference,
  ): Promise<GranteesResult> {
    console.log('Granting access to file: ', fileInfo.eFileRef.toString());
    const fIx = this.fileInfoList.findIndex((f) => f.eFileRef === fileInfo.eFileRef);
    if (fIx === -1) {
      throw `Provided file reference not found: ${fileInfo.eFileRef}`;
    }

    let grantResult: GranteesResult;
    if (eGlRef !== undefined) {
      // TODO: history ref should be optional in bee-js
      grantResult = await this.bee.patchGrantees(
        fileInfo.batchId,
        eGlRef,
        fileInfo.historyRef || SWARM_ZERO_ADDRESS,
        grantees,
      );
      console.log('Access patched, grantee list reference: ', grantResult.ref.toString());
    } else {
      if (grantees.add === undefined || grantees.add.length === 0) {
        throw `No grantees specified.`;
      }

      grantResult = await this.bee.createGrantees(fileInfo.batchId, grantees.add);
      console.log('Access granted, new grantee list reference: ', grantResult.ref.toString());
    }

    return grantResult;
  }

  // End grantee handler methods

  // TODO: upload /soc wiht ACT and download: do not upload mantaraymanifref with ACT as data!
  public async getFeedData(
    topic: Topic,
    index?: number,
    address?: EthAddress,
    options?: BeeRequestOptions,
  ): Promise<FetchFeedUpdateResponse> {
    try {
      const feedReader = this.bee.makeFeedReader(topic, address || this.signer.publicKey().address(), options);
      if (index !== undefined) {
        return await feedReader.download({ index: numberToFeedIndex(index) });
      }
      return await feedReader.download();
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          feedIndex: numberToFeedIndex(-1),
          feedIndexNext: numberToFeedIndex(0),
          payload: SWARM_ZERO_ADDRESS,
        };
      }
      throw error;
    }
  }

  // fileInfo might point to a folder, or a single file
  // could name downloadFiles as well, possibly
  // getDirectorStructure()
  async listFiles(fileInfo: FileInfo): Promise<Reference[]> {
    return [fileInfo.eFileRef as Reference];
  }

  // Start stamp methods
  private async getUsableStamps(): Promise<PostageBatch[]> {
    try {
      return (await this.bee.getAllPostageBatch()).filter((s) => s.usable);
    } catch (error: any) {
      console.error(`Failed to get usable stamps: ${error}`);
      return [];
    }
  }

  async filterBatches(ttl?: number, utilization?: number, capacity?: number): Promise<PostageBatch[]> {
    // TODO: clarify depth vs capacity
    return this.stampList.filter((s) => {
      if (utilization !== undefined && s.utilization <= utilization) {
        return false;
      }

      if (capacity !== undefined && s.depth <= capacity) {
        return false;
      }

      if (ttl !== undefined && s.batchTTL <= ttl) {
        return false;
      }

      return true;
    });
  }

  async getStamps(): Promise<PostageBatch[]> {
    return this.stampList;
  }

  getOwnerFeedStamp(): PostageBatch | undefined {
    return this.stampList.find((s) => s.label === OWNER_FEED_STAMP_LABEL);
  }

  async fetchStamp(batchId: string | { batchID: string }): Promise<PostageBatch | undefined> {
    try {
      const id = typeof batchId === 'string' ? batchId : batchId.batchID;
      const newStamp = await this.bee.getPostageBatch(id);
      if (newStamp?.exists && newStamp.usable) {
        this.stampList.push(newStamp);
        return newStamp;
      }
    } catch (error: any) {
      console.error(`Failed to get stamp with batchID ${batchId}: ${error.message}`);
    }
  }

  async destroyVolume(batchId: BatchId): Promise<void> {
    if (batchId === this.getOwnerFeedStamp()?.batchID) {
      throw `Cannot destroy owner stamp, batchId: ${batchId.toString()}`;
    }

    await this.bee.diluteBatch(batchId, STAMPS_DEPTH_MAX);

    for (let i = 0; i < this.stampList.length; i++) {
      if (this.stampList[i].batchID === batchId) {
        this.stampList.splice(i, 1);
        break;
      }
    }

    for (let i = 0; i < this.fileInfoList.length, ++i; ) {
      const fileInfo = this.fileInfoList[i];
      if (fileInfo.batchId === batchId) {
        this.fileInfoList.splice(i, 1);
        const mfIx = this.fileInfoFeedList.findIndex((mf) => mf.eFileRef === fileInfo.eFileRef);
        if (mfIx !== -1) {
          this.fileInfoFeedList.splice(mfIx, 1);
        }
      }
    }

    this.saveFileInfoFeedList();

    console.log(`Volume destroyed: ${batchId.toString()}`);
  }
  // End stamp methods

  // Start share methods
  subscribeToSharedInbox(topic: string, callback?: (data: ShareItem) => void): PssSubscription {
    console.log('Subscribing to shared inbox, topic: ', topic);
    this.sharedSubscription = this.bee.pssSubscribe(new Topic(Topic.fromString(topic)), {
      onMessage: (message) => {
        console.log('Received shared inbox message: ', message);
        assertShareItem(message);
        this.sharedWithMe.push(message);
        if (callback) {
          callback(message);
        }
      },
      onError: (e) => {
        console.log('Error received in shared inbox: ', e.message);
        throw e;
      },
    });

    return this.sharedSubscription;
  }

  unsubscribeFromSharedInbox(): void {
    if (this.sharedSubscription) {
      console.log('Unsubscribed from shared inbox, topic: ', this.sharedSubscription.topic.toString());
      this.sharedSubscription.cancel();
    }
  }

  async shareItem(fileInfo: FileInfo, targetOverlays: string[], recipients: string[], message?: string): Promise<void> {
    const mfIx = this.fileInfoFeedList.findIndex((mf) => mf.reference === fileInfo.eFileRef);
    if (mfIx === -1) {
      console.log('File reference not found in fileInfo feed list.');
      return;
    }

    const grantResult = await this.handleGrantees(
      fileInfo,
      { add: recipients },
      this.fileInfoFeedList[mfIx].eGranteeRef,
    );

    this.fileInfoFeedList[mfIx] = {
      ...this.fileInfoFeedList[mfIx],
      eGranteeRef: grantResult.ref,
    };

    this.saveFileInfoFeedList();

    const item: ShareItem = {
      fileInfo: fileInfo,
      timestamp: Date.now(),
      message: message,
    };

    this.sendShareMessage(targetOverlays, item, recipients);
  }

  // recipient is optional, if not provided the message will be broadcasted == pss public key
  private async sendShareMessage(targetOverlays: string[], item: ShareItem, recipients: string[]): Promise<void> {
    if (recipients.length === 0 || recipients.length !== targetOverlays.length) {
      console.log('Invalid recipients or  targetoverlays specified for sharing.');
      return;
    }

    for (let i = 0; i < recipients.length; i++) {
      try {
        // TODO: mining will take too long, 2 bytes are enough
        const target = Utils.makeMaxTarget(targetOverlays[i]);
        const msgData = new Uint8Array(Buffer.from(JSON.stringify(item)));
        this.bee.pssSend(item.fileInfo.batchId, SHARED_INBOX_TOPIC, target, msgData, recipients[i]);
      } catch (error: any) {
        console.log(`Failed to share item with recipient: ${recipients[i]}\n `, error);
      }
    }
  }
  // End share methods
  // TODO: saveFileInfo only exists for testing now
  async saveFileInfo(fileInfo: FileInfo): Promise<string> {
    try {
      if (!fileInfo || !fileInfo.batchId || !fileInfo.eFileRef) {
        throw new Error("Invalid fileInfo: 'batchId' and 'eFileRef' are required.");
      }

      const index = this.fileInfoList.length;
      this.fileInfoList.push(fileInfo);

      const data = JSON.stringify(this.fileInfoList);
      localStorage.setItem(FILE_INFO_LOCAL_STORAGE, data);

      return index.toString(16).padStart(64, '0');
    } catch (error) {
      console.error('Error saving file info:', error);
      throw error;
    }
  }
}
