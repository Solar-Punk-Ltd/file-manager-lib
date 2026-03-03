import {
  BatchId,
  BeeRequestOptions,
  Bytes,
  CollectionUploadOptions,
  DownloadOptions,
  FeedIndex,
  FileUploadOptions,
  GetGranteesResult,
  PostageBatch,
  RedundancyLevel,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';

import { EventEmitter } from '../eventEmitter';

import { DriveInfo, FileInfo, ShareItem } from './info';
import { FileInfoOptions } from './utils';

/**
 * Interface representing a file manager with various file operations.
 */
export interface FileManager {
  /**
   * Initializes the file manager.
   * @emits FileManagerEvents.INITIALIZED
   * @emits FileManagerEvents.STATE_INVALID
   * @returns A promise that resolves when the initialization is complete.
   */
  initialize(): Promise<void>;

  /**
   * Creates a new drive with the specified options.
   * @param batchId - The batch ID for the drive.
   * @param name - The name of the drive.
   * @param isAdmin - Indicates if the drive is an admin drive.
   * @param redundancyLevel - Optional redundancy level for the drive.
   * @param resetState - Optional flag to reset the state, if it is invalid/ no stamp is found for it.
   *                   - It enables the creation of a new admin drive.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.DRIVE_CREATED
   * @returns A promise that resolves when the drive is created.
   */
  createDrive(
    batchId: string | BatchId,
    name: string,
    isAdmin: boolean,
    redundancyLevel?: RedundancyLevel,
    resetState?: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<void>;

  /**
   * Uploads a file with the given options.
   * @param infoOptions - The options for the file info upload.
   * @param uploadOptions - File and collection related upload options.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FILE_UPLOADED
   * @returns A promise that resolves when the upload is complete.
   */
  upload(
    driveInfo: DriveInfo,
    infoOptions: FileInfoOptions,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions | CollectionUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<void>;

  /**
   * Downloads a file using the given reference and options.
   * @param eRef - The encrypted reference to the file(s) to be downloaded.
   * @param paths - Optional array of fork paths to download.
   * @param options - Optional download options for ACT and redundancy.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FILE_DOWNLOADED
   * @returns A promise that resolves to an array of strings representing the downloaded file(s).
   */
  download(
    fileInfo: FileInfo,
    paths?: string[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<ReadableStream<Uint8Array>[] | Bytes[]>;

  /**
   * Lists files based on the provided file information and options.
   * @param fileInfo - Information about the file(s) containing the encrypted reference and history.
   * @param paths - Optional array of fork paths to list.
   * @param requestOptions - Additional Bee request options.
   * @param options - Optional download options for ACT.
   * @returns A promise that resolves to an array of references with paths.
   */
  listFiles(
    fileInfo: FileInfo,
    paths?: string[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<Record<string, string>>;

  /**
   * Soft-delete: move a file to “trash” (it stays in Swarm but is hidden from your live list).
   * @param fileInfo - The file info describing the file to trash.
   * @emits FileManagerEvents.FILE_TRASHED
   * @returns A promise that resolves when the file has been trashed.
   */
  trashFile(fileInfo: FileInfo): Promise<void>;

  /**
   * Recover a previously trashed file back into your live list.
   * @param fileInfo - The file info describing the file to recover.
   * @emits FileManagerEvents.FILE_RECOVERED
   * @returns A promise that resolves when the file has been recovered.
   */
  recoverFile(fileInfo: FileInfo): Promise<void>;

  /**
   * Hard‐delete: remove from your owner‐feed and in-memory lists.
   * @param fileInfo - The file info describing the file to forget.
   * @emits FileManagerEvents.FILE_FORGOTTEN
   * @returns A promise that resolves when the file has been forgotten.
   */
  forgetFile(fileInfo: FileInfo): Promise<void>;

  /**
   * Destroys a drive identified by the given batch ID.
   * Dilutes the stamp and shortens its duration (min. 24, max 47 hours) depending on the original TTL.
   * @param driveInfo - The drive to destroy.
   * @emits FileManagerEvents.DRIVE_DESTROYED
   * @returns A promise that resolves when the drive is destroyed.
   */
  destroyDrive(driveInfo: DriveInfo, stamp: PostageBatch): Promise<void>;

  /**
   * Removes the drive and all of its file metadata from local state and persists the updated drive list.
   * Does NOT touch the underlying Swarm batch (no dilution).
   * @param driveInfo - The drive to forget.
   * @emits FileManagerEvents.DRIVE_FORGOTTEN
   * @returns A promise that resolves when the drive is forgotten.
   */
  forgetDrive(driveInfo: DriveInfo): Promise<void>;

  /**
   * Shares a file information with the specified recipients.
   * @param fileInfo - Information about the file(s) to share.
   * @param targetOverlays - An array of target overlays.
   * @param recipients - An array of recipient overlay addresses.
   * @param message - Optional message to include with the share.
   * @emits FileManagerEvents.SHARE_MESSAGE_SENT
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
  getVersion(fileInfo: FileInfo, version?: FeedIndex): Promise<FileInfo>;

  /**
   * Restore a previous version of a file as the new “head” in your feed.
   *
   * @param versionToRestore - The FileInfo instance representing the version to restore.
   * @param requestOptions - Optional BeeRequestOptions for upload operations.
   * @emits FileManagerEvents.FILE_VERSION_RESTORED
   * @throws FileInfoError if no versions are found.
   */
  restoreVersion(versionToRestore: FileInfo, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Admin postage batch used for drive management operations.
   * @returns The admin postage batch, or undefined if not set.
   */
  adminStamp: PostageBatch | undefined;

  /**
   * Retrieves a list of drive information.
   * @returns An array of drive information objects.
   */
  driveList: DriveInfo[];

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
