import {
  BatchId,
  BeeRequestOptions,
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
import { DirectoryEntry } from '../utils/mantaray';

import { DownloadResult, DriveInfo, FileRecord, FolderInfo, ShareItem, UploadManyResult } from './info';
import { FileInfoOptions, ListDepth, UploadManyEntry } from './utils';

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
   *
   * For multi-file/folder uploads use uploadMany — passing multiple files here produces a
   * single opaque collection without per-file versioning, ACT, or listing.
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
   * Uploads multiple files, recreating their folder hierarchy as real folder-nodes under
   * destinationPath. Each file becomes its own node with per-file versioning and ACT, unlike a
   * single opaque collection upload via upload(). Missing folders are created as needed; each
   * touched parent manifest is saved once at the end. Tolerates partial failure: per-file errors
   * are collected rather than aborting the whole batch.
   * @param driveInfo - The drive to upload into.
   * @param entries - The files to upload, each with a path relative to destinationPath.
   * @param destinationPath - Absolute path of the destination folder, or '' / '/' for the drive root.
   * @param uploadOptions - File-related upload options.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FOLDER_CREATED (per folder created)
   * @emits FileManagerEvents.FILE_UPLOADED (per file uploaded)
   * @emits FileManagerEvents.FILES_UPLOADED (once, with the batch summary)
   * @returns The succeeded FileRecords and any per-file failures.
   */
  uploadMany(
    driveInfo: DriveInfo,
    entries: UploadManyEntry[],
    destinationPath?: string,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<UploadManyResult>;

  /**
   * Downloads files for all matching paths in a drive.
   * @param driveInfo - The drive to download from.
   * @param paths - Optional array of paths to filter by.
   * @param options - Optional download options.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FILE_DOWNLOADED
   * @returns A promise that resolves to an array of DownloadResult, one per matched file.
   */
  download(
    driveInfo: DriveInfo,
    paths?: string[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult[]>;

  /**
   * Lists entries in a folder (or drive root) in the drive manifest.
   * Also populates the fileInfoList cache for any file entries encountered.
   * @param driveInfo - The drive containing the folder.
   * @param folderPath - Absolute path of the folder, or '' / '/' for the drive root.
   * @param depth - Shallow (one level) or Deep (full BFS). Defaults to Shallow.
   * @param maxDepth - Maximum BFS levels when depth is Deep; unlimited if omitted.
   * @param requestOptions - Additional Bee request options.
   * @returns Array of DirectoryEntry objects for every node found at or below the given path.
   */
  listFolder(
    driveInfo: DriveInfo,
    folderPath: string,
    depth?: ListDepth,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<DirectoryEntry[]>;

  /**
   * Soft-delete: move a file to "trash" (it stays in Swarm but is hidden from your live list).
   * @param fileInfo - The file record describing the file to trash.
   * @emits FileManagerEvents.FILE_TRASHED
   * @returns A promise that resolves when the file has been trashed.
   */
  trashFile(fileInfo: FileRecord): Promise<void>;

  /**
   * Recover a previously trashed file back into your live list.
   * @param fileInfo - The file record describing the file to recover.
   * @emits FileManagerEvents.FILE_RECOVERED
   * @returns A promise that resolves when the file has been recovered.
   */
  recoverFile(fileInfo: FileRecord): Promise<void>;

  /**
   * Hard-delete a file or folder at the given path from the drive manifest and in-memory state.
   * For folders, all descendant FileRecords are also purged from fileInfoList.
   * @param driveInfo - The drive containing the path.
   * @param path - Absolute path of the file or folder to remove.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FILE_FORGOTTEN (file) or FileManagerEvents.FOLDER_FORGOTTEN (folder)
   */
  forget(driveInfo: DriveInfo, path: string, requestOptions?: BeeRequestOptions): Promise<void>;

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
   * Shares a file with the specified recipients.
   * @param fileInfo - The file record to share.
   * @param targetOverlays - An array of target overlays.
   * @param recipients - An array of recipient overlay addresses.
   * @param message - Optional message to include with the share.
   * @emits FileManagerEvents.SHARE_MESSAGE_SENT
   * @returns A promise that resolves when the file is shared.
   */
  share(fileInfo: FileRecord, targetOverlays: string[], recipients: string[], message?: string): Promise<void>;

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
   * @param fileInfo - The file record to query.
   * @returns A promise that resolves to list of grantee public keys.
   */
  getGrantees(fileInfo: FileRecord): Promise<GetGranteesResult>;

  /**
   * Returns a specific version of a file.
   *
   * @param fileInfo - The base FileRecord containing topic and owner fields.
   * @param version - Optional desired version slot as a FeedIndex or hex/string. If omitted, fetches latest.
   * @returns The FileRecord corresponding to the requested version, either cached or fetched.
   */
  getVersion(fileInfo: FileRecord, version?: FeedIndex): Promise<FileRecord>;

  /**
   * Restore a previous version of a file as the new "head" in your feed.
   *
   * @param versionToRestore - The FileRecord instance representing the version to restore.
   * @param requestOptions - Optional BeeRequestOptions for upload operations.
   * @emits FileManagerEvents.FILE_VERSION_RESTORED
   * @throws FileInfoError if no versions are found.
   */
  restoreVersion(versionToRestore: FileRecord, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Moves a file or folder within a drive from one path to another.
   *
   * @param fromPath - Absolute path of the entry within the drive manifest.
   * @param toPath - Destination path within the drive manifest.
   * @param sourceDriveInfo - The drive containing the source path.
   * @param targetDriveInfo - Optional target drive for cross-drive moves; defaults to sourceDriveInfo.
   * @param requestOptions - Optional BeeRequestOptions for upload operations.
   * @emits FileManagerEvents.FILE_MOVED
   */
  move(
    fromPath: string,
    toPath: string,
    sourceDriveInfo: DriveInfo,
    targetDriveInfo?: DriveInfo,
    requestOptions?: BeeRequestOptions,
  ): Promise<void>;

  /**
   * Creates a new empty folder within a drive.
   * @param driveInfo - The drive to create the folder in.
   * @param parentPath - Absolute path of the parent directory, or '' / '/' for the drive root.
   * @param folderName - Name of the new folder (must not contain '/').
   * @param redundancyLevel - Optional redundancy level; inherits from parent or drive if omitted.
   * @param requestOptions - Additional Bee request options.
   * @returns The FolderInfo for the newly created folder.
   */
  createFolder(
    driveInfo: DriveInfo,
    parentPath: string,
    folderName: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo>;

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
   * Retrieves a list of file records.
   * @returns An array of FileRecord objects.
   */
  fileInfoList: FileRecord[];

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
