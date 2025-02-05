import {
  BatchId,
  Bee,
  BeeRequestOptions,
  Data,
  GetGranteesResult,
  GranteesResult,
  PostageBatch,
  PssSubscription,
  RedundancyLevel,
  Reference,
  Signer,
  STAMPS_DEPTH_MAX,
  Topic,
  Utils,
} from '@ethersphere/bee-js';
import { loadAllNodes, MantarayNode } from '@solarpunkltd/mantaray-js';
import { Wallet } from 'ethers';
import { readFileSync } from 'fs';
import path from 'path';

import {
  DEFAULT_FEED_TYPE,
  FILE_INFO_LOCAL_STORAGE,
  FILEIINFO_NAME,
  FILEIINFO_PATH,
  FILEINFO_HISTORY_PATH,
  OWNER_FEED_STAMP_LABEL,
  REFERENCE_LIST_TOPIC,
  SHARED_INBOX_TOPIC,
  SWARM_ZERO_ADDRESS,
} from './constants';
import { FetchFeedUpdateResponse, FileInfo, ReferenceWithHistory, ShareItem, WrappedMantarayFeed } from './types';
import {
  assertFileInfo,
  assertReference,
  assertReferenceWithHistory,
  assertShareItem,
  assertTopic,
  assertWrappedMantarayFeed,
  encodePathToBytes,
  getContentType,
  getRandomTopicHex,
  isNotFoundError,
  makeBeeRequestOptions,
  makeNumericIndex,
  numberToFeedIndex,
} from './utils';

export class FileManager {
  private bee: Bee;
  private wallet: Wallet;
  private signer: Signer;
  private stampList: PostageBatch[];
  private mantarayFeedList: WrappedMantarayFeed[];
  private fileInfoList: FileInfo[];
  private nextOwnerFeedIndex: number;
  private sharedWithMe: ShareItem[];
  private sharedSubscription: PssSubscription | undefined;
  private ownerFeedTopic: Topic;

  constructor(bee: Bee, privateKey: string) {
    console.log('Initializing Bee client...');
    this.bee = bee;
    this.sharedSubscription = undefined;
    this.wallet = new Wallet(privateKey);
    this.signer = {
      address: Utils.hexToBytes(this.wallet.address.slice(2)),
      sign: async (data: Data): Promise<string> => {
        return await this.wallet.signMessage(data);
      },
    };
    this.stampList = [];
    this.fileInfoList = [];
    this.mantarayFeedList = [];
    this.nextOwnerFeedIndex = 0;
    this.ownerFeedTopic = this.bee.makeFeedTopic(SWARM_ZERO_ADDRESS);
    this.sharedWithMe = [];
  }

  // Start init methods
  async initialize(): Promise<void> {
    await this.initStamps();
    await this.initOwnerFeedTopic();
    await this.initMantarayFeedList();
    await this.initFileInfoList();
  }

  private async initOwnerFeedTopic(): Promise<void> {
    const referenceListTopicHex = this.bee.makeFeedTopic(REFERENCE_LIST_TOPIC);
    const feedTopicData = await this.getFeedData(referenceListTopicHex, this.wallet.address, 0);

    if (feedTopicData.reference === SWARM_ZERO_ADDRESS) {
      const ownerFeedStamp = this.getOwnerFeedStamp();
      if (ownerFeedStamp === undefined) {
        throw 'Owner stamp not found';
      }

      this.ownerFeedTopic = getRandomTopicHex();
      const topicDataRes = await this.bee.uploadData(ownerFeedStamp.batchID, this.ownerFeedTopic, { act: true });
      const fw = this.bee.makeFeedWriter(DEFAULT_FEED_TYPE, referenceListTopicHex, this.signer);
      await fw.upload(ownerFeedStamp.batchID, topicDataRes.reference, { index: numberToFeedIndex(0) });
      await fw.upload(ownerFeedStamp.batchID, topicDataRes.historyAddress as Reference, {
        index: numberToFeedIndex(1),
      });
    } else {
      const topicHistory = await this.getFeedData(referenceListTopicHex, this.wallet.address, 1);
      const publicKey = (await this.bee.getNodeAddresses()).publicKey; // TODO: init pubkey once
      const options = makeBeeRequestOptions(topicHistory.reference, publicKey);

      const topicHex = (await this.bee.downloadData(feedTopicData.reference, options)).text();
      assertTopic(topicHex);
      this.ownerFeedTopic = topicHex;
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

  private async initMantarayFeedList(): Promise<void> {
    const latestFeedData = await this.getFeedData(this.ownerFeedTopic);
    if (latestFeedData.reference === SWARM_ZERO_ADDRESS) {
      console.log("Owner mantaray feed doesn't exist yet.");
      return;
    }

    this.nextOwnerFeedIndex = makeNumericIndex(latestFeedData.feedIndexNext);
    const refWithHistory = latestFeedData as unknown as ReferenceWithHistory;
    assertReferenceWithHistory(refWithHistory);
    // const ownerFeedRawData = await this.bee.downloadData(latestFeedData.reference);
    // const ownerFeedData = JSON.parse(ownerFeedRawData.text());
    // assertReferenceWithHistory(ownerFeedData);

    const publicKey = (await this.bee.getNodeAddresses()).publicKey;
    const options = makeBeeRequestOptions(refWithHistory.historyRef, publicKey);
    const mantarayFeedListRawData = await this.bee.downloadData(refWithHistory.reference, options);
    const mantarayFeedListData: WrappedMantarayFeed[] = JSON.parse(mantarayFeedListRawData.text());

    for (const wmf of mantarayFeedListData) {
      try {
        assertWrappedMantarayFeed(wmf);
        this.mantarayFeedList.push(wmf);
      } catch (error: any) {
        console.error(`Invalid WrappedMantarayFeed item, skipping it: ${error}`);
      }
    }

    console.log('Mantaray feed list fetched successfully.');
  }

  private async downloadFork(mantaray: MantarayNode, forkPAth: string, options?: BeeRequestOptions): Promise<string> {
    const fork = mantaray.getForkAtPath(encodePathToBytes(forkPAth));
    const entry = fork?.node.getEntry;
    if (entry === undefined) {
      throw `fork entry at ${forkPAth} is undefined`;
    }

    return (await this.bee.downloadData(entry, options)).text();
  }

  // TODO: at this point we already have the efilerRef, so we can use it to fetch the data
  // TODO: loadallnodes and deserialize works but load() doesn't work -> why ?
  // TODO: already unwrapped historyRef by bee ?
  private async initFileInfoList(): Promise<void> {
    // TODO: leave publickey get out of the for loop
    const publicKey = (await this.bee.getNodeAddresses()).publicKey;
    for (const mantaryFeedItem of this.mantarayFeedList) {
      console.log('bagoy mantaryFeedItem: ', mantaryFeedItem);
      // const feedOptions = makeBeeRequestOptions(mantaryFeedItem.historyRef, publicKey);
      const wrappedMantarayData = await this.getFeedData(
        mantaryFeedItem.reference,
        this.wallet.address,
        0, // TODO: if index is provided then it calls the chunk api, if undefined then it calls the feed api to lookup
        // feedOptions, // TODO: commented out the act options because it can download without it but whyy ? it was uploaded via act
      );
      try {
        console.log('bagoy wrappedMantarayData: ', wrappedMantarayData);
        assertReference(wrappedMantarayData.reference);
      } catch (error: any) {
        console.error(`Invalid wrappedMantarayData reference: ${wrappedMantarayData.reference}`);
        continue;
      }

      if (wrappedMantarayData.reference === SWARM_ZERO_ADDRESS) {
        console.log(`mantaryFeedItem not found, skipping it, reference: ${mantaryFeedItem.reference}`);
        continue;
      }

      // let options = makeBeeRequestOptions(mantaryFeedItem.historyRef, publicKey);
      const rootMantaray = (await this.bee.downloadData(wrappedMantarayData.reference)).hex();
      console.log('bagoy initFileInfoList rootMantaray: ', rootMantaray);
      const mantaray = await this.loadAllMantarayNodes(Buffer.from(rootMantaray, 'hex'));
      const historyRef = await this.downloadFork(mantaray, FILEINFO_HISTORY_PATH);
      try {
        assertReference(historyRef);
      } catch (error: any) {
        console.error(`Invalid history reference: ${historyRef}`);
        continue;
      }
      console.log('bagoy historyRef: ', historyRef);

      const options = makeBeeRequestOptions(historyRef, publicKey);
      const fileInfoRawData = await this.downloadFork(mantaray, FILEIINFO_PATH, options);
      const fileInfoData: FileInfo = JSON.parse(fileInfoRawData);
      console.log('bagoy fileInfoData: ', fileInfoData);

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
  // End getter methods

  // @upcoming/bee-js 0.03
  // TODO: use all the params of the currentfileinfo is exists?
  async upload(
    batchId: string | BatchId,
    mantaray: MantarayNode,
    file: string,
    currentFileInfo?: FileInfo,
    customMetadata?: Record<string, string>,
  ): Promise<void> {
    const redundancyLevel = currentFileInfo?.redundancyLevel || RedundancyLevel.MEDIUM;
    const uploadFileRes = await this.uploadFile(batchId, file, currentFileInfo);

    // TODO: store feed index in fileinfo to speed up upload? -> undifined == 0, index otherwise
    const fileInfo: FileInfo = {
      eFileRef: uploadFileRes.reference,
      batchId: batchId,
      fileName: path.basename(file),
      owner: this.wallet.address,
      shared: false,
      historyRef: uploadFileRes.historyRef,
      timestamp: new Date().getTime(),
      redundancyLevel: redundancyLevel,
      customMetadata: customMetadata,
    };

    const fileInfoRes = await this.uploadFileInfo(batchId, fileInfo);
    mantaray.addFork(encodePathToBytes(FILEIINFO_PATH), fileInfoRes.reference as Reference, {
      'Content-Type': 'application/json',
      Filename: FILEIINFO_NAME,
    });
    // TODO: is fileinfo ACT needed?
    const uploadHistoryRes = await this.uploadFileInfoHistory(batchId, fileInfoRes.historyRef, redundancyLevel);
    mantaray.addFork(encodePathToBytes(FILEINFO_HISTORY_PATH), uploadHistoryRes.historyRef as Reference);

    const wrappedMantarayRef = await this.saveMantaray(batchId, mantaray);
    console.log('bagoy saveMantaray wrappedMantarayRef: ', wrappedMantarayRef);
    const topic = currentFileInfo?.topic || getRandomTopicHex();
    console.log('bagoy wrapped mantaray feed topic: ', topic);
    assertTopic(topic);
    const wrappedFeedUpdateRes = await this.updateWrappedMantarayFeed(batchId, wrappedMantarayRef, topic);

    const feedUpdate: WrappedMantarayFeed = {
      reference: topic,
      historyRef: wrappedFeedUpdateRes.historyRef,
      eFileRef: fileInfoRes.reference, // TODO: why  fileInfoRes.reference instead of eFileRef ?
    };
    const ix = this.mantarayFeedList.findIndex((f) => f.reference === feedUpdate.reference);
    if (ix !== -1) {
      this.mantarayFeedList[ix] = { ...feedUpdate, eGranteeRef: this.mantarayFeedList[ix].eGranteeRef };
    } else {
      this.mantarayFeedList.push(feedUpdate);
    }

    await this.saveMantarayFeedList();
  }

  private async uploadFile(
    batchId: string | BatchId,
    file: string,
    currentFileInfo: FileInfo | undefined = undefined,
  ): Promise<ReferenceWithHistory> {
    console.log(`Uploading file: ${file}`);
    const filePath = path.resolve(__dirname, file);
    const fileData = new Uint8Array(readFileSync(filePath));
    const fileName = path.basename(file);
    const contentType = getContentType(file);

    try {
      const options = makeBeeRequestOptions(currentFileInfo?.historyRef);
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

      console.log(`File uploaded successfully: ${file}, Reference: ${uploadFileRes.reference}`);
      return { reference: uploadFileRes.reference, historyRef: uploadFileRes.historyAddress };
    } catch (error: any) {
      throw `Failed to upload file ${file}: ${error}`;
    }
  }

  private async uploadFileInfo(batchId: string | BatchId, fileInfo: FileInfo): Promise<ReferenceWithHistory> {
    try {
      const uploadInfoRes = await this.bee.uploadData(batchId, JSON.stringify(fileInfo), {
        act: true,
        redundancyLevel: fileInfo.redundancyLevel,
      });
      console.log('Fileinfo updated: ', uploadInfoRes.reference);

      this.fileInfoList.push(fileInfo);

      return { reference: uploadInfoRes.reference, historyRef: uploadInfoRes.historyAddress };
    } catch (error: any) {
      throw `Failed to save fileinfo: ${error}`;
    }
  }

  private async uploadFileInfoHistory(
    batchId: string | BatchId,
    hisoryRef: string,
    redundancyLevel: RedundancyLevel = RedundancyLevel.MEDIUM,
  ): Promise<ReferenceWithHistory> {
    try {
      const uploadHistoryRes = await this.bee.uploadData(batchId, hisoryRef, {
        redundancyLevel: redundancyLevel,
      });

      console.log('Fileinfo history updated: ', uploadHistoryRes.reference);

      return { reference: uploadHistoryRes.reference, historyRef: uploadHistoryRes.reference };
    } catch (error: any) {
      throw `Failed to save fileinfo history: ${error}`;
    }
  }

  private async updateWrappedMantarayFeed(
    batchId: string | BatchId,
    wrappedMantarayRef: Reference,
    topic: Topic,
  ): Promise<ReferenceWithHistory> {
    try {
      const fw = this.bee.makeFeedWriter(DEFAULT_FEED_TYPE, topic, this.signer);
      // const wrappedMantarayData = await this.bee.uploadData(batchId, wrappedMantarayRef, { act: true });
      // const uploadRes = await fw.upload(batchId, wrappedMantarayData.reference, {
      //   index: undefined, // todo: keep track of the latest index ??
      // });
      // const wrappedMantarayData = await this.bee.uploadData(batchId, wrappedMantarayRef);
      const uploadRes = await fw.upload(batchId, wrappedMantarayRef, {
        index: undefined, // todo: keep track of the latest index ??
        act: true, // bagoy: this shall call to /soc post api
      });
      console.log('bagoy updateWrappedMantarayFeed uploadres: ', uploadRes);
      // console.log('bagoy updateWrappedMantarayFeed wrappedMantarayData: ', wrappedMantarayData);
      console.log('bagoy updateWrappedMantarayFeed wrappedMantarayRef: ', wrappedMantarayRef);

      // return { reference: uploadRes.reference, historyRef: wrappedMantarayData.historyAddress };
      return { reference: uploadRes.reference, historyRef: uploadRes.historyAddress };
    } catch (error: any) {
      throw `Failed to wrapped mantaray feed: ${error}`;
    }
  }

  private async saveMantaray(batchId: string | BatchId, mantaray: MantarayNode): Promise<Reference> {
    const saveFunction = async (data: Uint8Array): Promise<Reference> => {
      const uploadResponse = await this.bee.uploadData(batchId, data);
      return uploadResponse.reference;
    };

    return mantaray.save(saveFunction);
  }

  private async loadMantaray(manifestReference: Reference, mantaray: MantarayNode): Promise<void> {
    const loadFunction = async (address: Reference): Promise<Uint8Array> => {
      return this.bee.downloadData(address);
    };

    mantaray.load(loadFunction, manifestReference);
  }

  // TODO: is obfuscationKey needed?
  private async loadAllMantarayNodes(data: Uint8Array): Promise<MantarayNode> {
    // const mantaray = initManifestNode({
    //   obfuscationKey: Utils.hexToBytes(getRandomTopicHex()),
    // });
    const mantaray = new MantarayNode();
    mantaray.deserialize(data);
    await loadAllNodes(async (address: Reference): Promise<Uint8Array> => {
      return this.bee.downloadData(address);
    }, mantaray);

    return mantaray;
  }

  // Start owner mantaray feed handler methods
  private async saveMantarayFeedList(): Promise<void> {
    const ownerFeedStamp = this.getOwnerFeedStamp();
    if (!ownerFeedStamp) {
      throw 'Owner feed stamp is not found.';
    }

    try {
      const mantarayFeedListData = await this.bee.uploadData(
        ownerFeedStamp.batchID,
        JSON.stringify(this.mantarayFeedList),
        {
          act: true,
        },
      );

      const ownerFeedData: ReferenceWithHistory = {
        reference: mantarayFeedListData.reference,
        historyRef: mantarayFeedListData.historyAddress,
      };
      console.log('bagoy first init ownerFeedData.reference: ', ownerFeedData.reference);
      console.log('bagoy first init ownerFeedData.historyRef: ', ownerFeedData.historyRef);

      const ownerFeedWriter = this.bee.makeFeedWriter(DEFAULT_FEED_TYPE, this.ownerFeedTopic, this.signer);
      const ownerFeedRawData = await this.bee.uploadData(ownerFeedStamp.batchID, JSON.stringify(ownerFeedData));
      const writeResult = await ownerFeedWriter.upload(ownerFeedStamp.batchID, ownerFeedRawData.reference, {
        index: this.nextOwnerFeedIndex,
      });
      // const checkData = await ownerFeedWriter.download();
      // console.log('bagoy checkData: ', checkData);

      console.log('bagoy first init ownerFeedRawData.reference: ', ownerFeedRawData.reference);
      this.nextOwnerFeedIndex += 1;
      console.log('Owner feed list updated: ', writeResult.reference);
    } catch (error: any) {
      throw `Failed to update owner feed list: ${error}`;
    }
  }
  // End owner mantaray feed handler methods

  // Start grantee handler methods
  // fetches the list of grantees who can access the file reference
  async getGranteesOfFile(eFileRef: string): Promise<GetGranteesResult> {
    const mf = this.mantarayFeedList.find((f) => f.eFileRef === eFileRef);
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
    console.log('Granting access to file: ', fileInfo.eFileRef);
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
      console.log('Access patched, grantee list reference: ', grantResult.ref);
    } else {
      if (grantees.add === undefined || grantees.add.length === 0) {
        throw `No grantees specified.`;
      }

      grantResult = await this.bee.createGrantees(fileInfo.batchId, grantees.add);
      console.log('Access granted, new grantee list reference: ', grantResult.ref);
    }

    return grantResult;
  }

  // End grantee handler methods

  // TODO: upload /soc wiht ACT and download: do not upload mantaraymanifref with ACT as data!
  public async getFeedData(
    topic: string,
    address?: string,
    index?: number,
    options?: BeeRequestOptions,
  ): Promise<FetchFeedUpdateResponse> {
    try {
      const feedReader = this.bee.makeFeedReader(DEFAULT_FEED_TYPE, topic, address || this.wallet.address, options);
      if (index !== undefined) {
        return await feedReader.download({ index: numberToFeedIndex(index) });
      }
      return await feedReader.download();
    } catch (error) {
      if (isNotFoundError(error)) {
        return { feedIndex: -1, feedIndexNext: (0).toString(), reference: SWARM_ZERO_ADDRESS as Reference };
      }
      throw error;
    }
  }

  // fileInfo might point to a folder, or a single file
  // could name downloadFiles as well, possibly
  // getDirectorStructure()
  async listFiles(fileInfo: FileInfo): Promise<string> {
    return fileInfo.eFileRef;
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

  getCachedStamp(batchId: string | BatchId): PostageBatch | undefined {
    return this.stampList.find((s) => s.batchID === batchId);
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

  async destroyVolume(batchId: string | BatchId): Promise<void> {
    if (batchId === this.getOwnerFeedStamp()?.batchID) {
      throw 'Cannot destroy owner stamp';
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
        const mfIx = this.mantarayFeedList.findIndex((mf) => mf.eFileRef === fileInfo.eFileRef);
        if (mfIx !== -1) {
          this.mantarayFeedList.splice(mfIx, 1);
        }
      }
    }

    this.saveMantarayFeedList();

    console.log(`Volume destroyed: ${batchId}`);
  }
  // End stamp methods

  // Start share methods
  subscribeToSharedInbox(topic: string, callback?: (data: ShareItem) => void): PssSubscription {
    console.log('Subscribing to shared inbox, topic: ', topic);
    this.sharedSubscription = this.bee.pssSubscribe(topic, {
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
      console.log('Unsubscribed from shared inbox, topic: ', this.sharedSubscription.topic);
      this.sharedSubscription.cancel();
    }
  }

  async shareItem(fileInfo: FileInfo, targetOverlays: string[], recipients: string[], message?: string): Promise<void> {
    const mfIx = this.mantarayFeedList.findIndex((mf) => mf.reference === fileInfo.eFileRef);
    if (mfIx === -1) {
      console.log('File reference not found in mantaray feed list.');
      return;
    }

    const grantResult = await this.handleGrantees(
      fileInfo,
      { add: recipients },
      this.mantarayFeedList[mfIx].eGranteeRef,
    );

    this.mantarayFeedList[mfIx] = {
      ...this.mantarayFeedList[mfIx],
      eGranteeRef: grantResult.ref,
    };

    this.saveMantarayFeedList();

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
