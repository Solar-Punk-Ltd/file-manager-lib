import {
  BatchId,
  BeeRequestOptions,
  Bytes,
  CollectionUploadOptions,
  DownloadOptions,
  EthAddress,
  FeedIndex,
  FileUploadOptions,
  GetGranteesResult,
  PublicKey,
  RedundancyLevel,
  RedundantUploadOptions,
  Reference,
  Topic,
} from '@ethersphere/bee-js';
import { ReadStream } from 'fs';

import { EventEmitter } from './eventEmitter';

/**
 * Interface representing a file manager with various file operations.
 */
export interface FileManager {
  /**
   * Initializes the file manager.
   * @returns A promise that resolves when the initialization is complete.
   */
  initialize(): Promise<void>;

  /**
   * Uploads a file with the given options.
   * @param infoOptions - The options for the file info upload.
   * @param uploadOptions - File and collection related upload options.
   * @param requestOptions - Additional Bee request options.
   * @returns A promise that resolves when the upload is complete.
   */
  upload(
    infoOptions: FileInfoOptions,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<void>;

  /**
   * Downloads a file using the given reference and options.
   * @param eRef - The encrypted reference to the file(s) to be downloaded.
   * @param paths - Optional array of fork paths to download.
   * @param options - Optional download options for ACT and redundancy.
   * @returns A promise that resolves to an array of strings representing the downloaded file(s).
   */
  download(
    fileInfo: FileInfo,
    paths?: string[],
    options?: DownloadOptions,
  ): Promise<ReadableStream<Uint8Array>[] | Bytes[]>;

  /**
   * Lists files based on the provided file information and options.
   * @param fileInfo - Information about the file(s) containing the encrypted reference and history.
   * @param options - Optional download options for ACT.
   * @returns A promise that resolves to an array of references with paths.
   */
  listFiles(fileInfo: FileInfo, options?: DownloadOptions): Promise<ReferenceWithPath[]>;

  /**
   * Destroys a volume identified by the given batch ID.
   * @param batchId - The ID of the batch to destroy.
   * @returns A promise that resolves when the volume is destroyed.
   */
  destroyVolume(batchId: BatchId): Promise<void>;

  /**
   * Shares a file information with the specified recipients.
   * @param fileInfo - Information about the file(s) to share.
   * @param targetOverlays - An array of target overlays.
   * @param recipients - An array of recipient overlay addresses.
   * @param message - Optional message to include with the share.
   * @returns A promise that resolves when the file is shared.
   */
  share(fileInfo: FileInfo, targetOverlays: string[], recipients: string[], message?: string): Promise<void>;

  /**
   * Subscribes to the shared inbox with the given topic and callback.
   * @param topic - The topic to subscribe to.
   * @param callback - Optional callback function to handle incoming shared items.
   * @returns A promise that resolves when the subscription is successful.
   */
  subscribeToSharedInbox(topic: string, callback?: (data: ShareItem) => void): Promise<void>;

  /**
   * Unsubscribes from the shared inbox.
   */
  unsubscribeFromSharedInbox(): void;

  /**
   * Retrieves the grantees of a file.
   * @param fileInfo - Information about the file.
   * @returns A promise that resolves to list of grantee public keys.
   */
  getGrantees(fileInfo: FileInfo): Promise<GetGranteesResult>;

  /**
   * How many versions exist for this file (0 = none).
   */
  getVersionCount(fileInfo: FileInfo): Promise<number>;

  /**
   * Load a single version's metadata for a file.
   */
  getVersion(filePath: string, version: number): Promise<FileVersionMetadata | null>;

  /**
   * Load every version's metadata, in order.
   */
  getHistory(fileInfo: FileInfo): Promise<FileVersionMetadata[]>;

  /**
   * Retrieves a list of file information.
   * @returns An array of file information objects.
   */
  fileInfoList: FileInfo[];

  /**
   * Retrieves a list of items shared with the user.
   * @returns An array of shared items.
   */
  sharedWithMe: ShareItem[];

  /**
   * Event emitter for handling file manager events.
   */
  emitter: EventEmitter;
}

export interface FileVersionMetadata {
  filePath: string;
  contentHash: string;
  size: number;
  timestamp: string;
  version: number;
  batchId: string;
  customMetadata?: Record<string, string>;
}

export interface FileVersionInfo {
  currentVersion: number;
  totalVersions: number;
  latestTimestamp: string;
  feedTopic: string;
}

export interface FileInfo {
  batchId: string | BatchId;
  file: ReferenceWithHistory;
  name: string;
  owner: string | EthAddress;
  actPublisher: string | PublicKey;
  topic: string | Topic;
  timestamp?: number;
  shared?: boolean;
  preview?: ReferenceWithHistory;
  index?: string | undefined;
  redundancyLevel?: RedundancyLevel;
  customMetadata?: Record<string, string>;
  versionInfo?: FileVersionInfo;
  isVersioned?: boolean;
}

export interface FileInfoOptions {
  batchId: BatchId;
  name: string;
  files?: File[] | FileList;
  path?: string;
  customMetadata?: Record<string, string>;
  infoTopic?: string;
  index?: string | undefined;
  preview?: File;
  previewPath?: string;
  onUploadProgress?: (progress: UploadProgress) => void;
}

export interface ShareItem {
  fileInfo: FileInfo;
  timestamp?: number;
  message?: string;
}

export interface ReferenceWithHistory {
  reference: string | Reference;
  historyRef: string | Reference;
}

export interface WrappedFileInfoFeed {
  topic: string | Topic;
  eGranteeRef?: string | Reference;
}

export interface ReferenceWithPath {
  reference: Reference;
  path: string;
}

export interface FileData {
  data: string | Uint8Array | ReadStream;
  name: string;
  contentType: string;
}

interface FeedUpdateHeaders {
  feedIndex: FeedIndex;
  feedIndexNext?: FeedIndex;
}
export interface FeedPayloadResult extends FeedUpdateHeaders {
  payload: Bytes;
}
export interface FeedReferenceResult extends FeedUpdateHeaders {
  reference: Reference;
}

export interface UploadProgress {
  total: number;
  processed: number;
}

export interface WrappedUploadResult {
  uploadFilesRes: Reference | string;
  uploadPreviewRes?: Reference | string;
}

export interface FileVersionMetadata {
  filePath: string;
  contentHash: string;
  size: number;
  timestamp: string;
  version: number;
  batchId: string;
  customMetadata?: Record<string, string>;
}
  