import {
  BatchId,
  Bytes,
  DownloadOptions,
  EthAddress,
  FeedIndex,
  PublicKey,
  RedundancyLevel,
  Reference,
  Topic,
} from '@upcoming/bee-js';
import { ReadStream } from 'fs';

/**
 * Interface representing a file manager with various file operations.
 */
export interface IFileManager {
  /**
   * Uploads a file with the given options.
   * @param options - The options for the upload operation.
   * @returns A promise that resolves when the upload is complete.
   */
  upload(options: FileManagerUploadOptions): Promise<void>;

  /**
   * Downloads a file using the given reference and options.
   * @param eRef - The encrypted reference to the file(s) to be downloaded.
   * @param options - Optional download options for ACT.
   * @returns A promise that resolves to an array of strings representing the downloaded file(s).
   */
  download(eRef: Reference, options?: DownloadOptions): Promise<string[]>;

  /**
   * Lists files based on the provided file information and options.
   * @param fileInfo - Information about the file(s) containing the encrypted reference and history.
   * @param options - Optional download options for ACT.
   * @returns A promise that resolves to an array of references with paths.
   */
  listFiles(fileInfo: FileInfo, options?: DownloadOptions): Promise<ReferenceWithPath[]>;

  /**
   * Retrieves a list of file information.
   * @returns An array of file information objects.
   */
  getFileInfoList(): FileInfo[];

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
   * Retrieves a list of items shared with the user.
   * @returns An array of shared items.
   */
  getSharedWithMe(): ShareItem[];
}

export interface FileInfo {
  batchId: string | BatchId;
  file: ReferenceWithHistory;
  topic?: string | Topic;
  owner?: string | EthAddress;
  name?: string;
  timestamp?: number;
  shared?: boolean;
  preview?: ReferenceWithHistory;
  index?: number | undefined;
  redundancyLevel?: RedundancyLevel;
  customMetadata?: Record<string, string>;
}

export interface FileManagerUploadOptions {
  batchId: BatchId;
  name: string;
  files?: File[] | FileList;
  path?: string;
  customMetadata?: Record<string, string>;
  historyRef?: Reference;
  infoTopic?: string;
  index?: number | undefined;
  preview?: File;
  previewPath?: string;
  redundancyLevel?: RedundancyLevel;
  onUploadProgress?: (T: any) => void;
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
export interface FetchFeedUpdateResponse extends FeedUpdateHeaders {
  payload: Bytes;
}

export interface RequestOptions {
  historyRef?: Reference;
  publisher?: PublicKey;
  timestamp?: number;
  redundancyLevel?: RedundancyLevel;
}

export interface UploadProgress {
  total: number;
  processed: number;
}
