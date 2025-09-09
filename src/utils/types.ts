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
   * Soft-delete: move a file to “trash” (it stays in Swarm but is hidden from your live list).
   * @param fileInfo - The file info describing the file to trash.
   * @returns A promise that resolves when the file has been trashed.
   */
  trashFile(fileInfo: FileInfo): Promise<void>;

  /**
   * Recover a previously trashed file back into your live list.
   * @param fileInfo - The file info describing the file to recover.
   * @returns A promise that resolves when the file has been recovered.
   */
  recoverFile(fileInfo: FileInfo): Promise<void>;

  /**
   * Hard‐delete: remove from your owner‐feed and in-memory lists.
   * @param fileInfo - The file info describing the file to forget.
   * @returns A promise that resolves when the file has been forgotten.
   */
  forgetFile(fileInfo: FileInfo): Promise<void>;

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
   * Returns a specific version of a file.
   *
   * @param fileInfo - The base FileInfo containing topic and owner fields.
   * @param version - Optional desired version slot as a FeedIndex or hex/string. If omitted, fetches latest.
   * @returns The FileInfo corresponding to the requested version, either cached or fetched.
   */
  getVersion(fileInfo: FileInfo, version?: string | FeedIndex): Promise<FileInfo>;

  /**
   * Restore a previous version of a file as the new “head” in your feed.
   *
   * @param versionToRestore - The FileInfo instance representing the version to restore.
   * @param requestOptions - Optional BeeRequestOptions for upload operations.
   * @throws FileInfoError if no versions are found.
   */
  restoreVersion(versionToRestore: FileInfo, requestOptions?: BeeRequestOptions): Promise<void>;

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

export enum FileStatus { Active = 'active', Trashed = 'trashed' }

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
  version?: string | undefined;
  redundancyLevel?: RedundancyLevel;
  customMetadata?: Record<string, string>;
  status?: FileStatus;
}

export interface PartialFileInfo extends Omit<FileInfo, 'owner' | 'actPublisher' | 'file' | 'topic'> {
  owner?: string | EthAddress;
  actPublisher?: string | PublicKey;
  file?: ReferenceWithHistory;
  topic?: string | Topic;
}

export interface FileInfoOptions {
  info: PartialFileInfo;
  files?: File[] | FileList;
  path?: string;
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
export interface FeedResultWithIndex extends FeedPayloadResult {
  feedIndexNext: FeedIndex;
}
export interface UploadProgress {
  total: number;
  processed: number;
}

export interface WrappedUploadResult {
  uploadFilesRes: Reference | string;
  uploadPreviewRes?: Reference | string;
}
