import {
  BatchId,
  BeeRequestOptions,
  DownloadOptions,
  FeedIndex,
  FileUploadOptions,
  GetGranteesResult,
  Identifier,
  PostageBatch,
  RedundancyLevel,
  RedundantUploadOptions,
} from '@ethersphere/bee-js';

import { EventEmitter } from '../eventEmitter';

import { DownloadResult } from './download';
import { DriveInfo, FileRecord, FolderInfo, ListDepth, NodeEntry, ShareItem } from './info';
import { UpdateItem, UploadFilesResult, UploadItem } from './upload';

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
   * @returns The newly-created DriveInfo.
   * @throws {DriveError} If not initialized, admin state/manifest/stamp is not ready, an admin drive
   *   already exists, a drive with the same name or batchId exists, resetState is used on a non-admin
   *   drive, or admin state already exists without resetState.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {StampError} If the batch stamp is missing or not usable.
   */
  createDrive(
    batchId: string | BatchId,
    name: string,
    isAdmin: boolean,
    redundancyLevel?: RedundancyLevel,
    resetState?: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<DriveInfo>;

  /**
   * Uploads a NEW file with the given options — mints a fresh feed topic and adds a new fork to
   * the drive manifest. To re-version or change metadata of an existing file, use {@link updateFile}.
   *
   * For multi-file/folder uploads use  {@link uploadFiles} — passing multiple files here produces a
   * single opaque collection without per-file versioning, ACT, or listing.
   * @param driveId - The ID of the drive to upload into
   * @param item - The options for the file info upload (new content: path/file; no topic).
   * @param uploadOptions - File and collection related upload options.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FILE_UPLOADED
   * @returns The newly-created FileRecord.
   * @throws {DriveError} If not initialized, driveId is not found, or the target folder path does not exist.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileError} If the source is a directory, a node source path does not exist, or the content upload fails.
   * @throws {FileInfoError} If a folder along the path has no feed.
   */
  uploadFile(
    driveId: string | Identifier,
    item: UploadItem,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord>;

  /**
   * Uploads multiple files, recreating their folder hierarchy as real folder-nodes under
   * destinationPath. Each file becomes its own node with per-file versioning and ACT, unlike a
   * single opaque collection upload via  {@link uploadFile}. Missing folders are created as needed; each
   * touched parent manifest is saved once at the end. Tolerates partial failure: per-file errors
   * are collected rather than aborting the whole batch.
   * @param driveId - The ID of the drive to upload into.
   * @param items - The files to upload, each with a path relative to destinationPath.
   * @param destinationPath - Absolute path of the destination folder, or '/' for the drive root.
   * @param uploadOptions - File-related upload options.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FOLDER_CREATED (per folder created)
   * @emits FileManagerEvents.FILE_UPLOADED (per file uploaded)
   * @emits FileManagerEvents.FILES_UPLOADED (once, with the batch summary)
   * @returns The succeeded FileRecords and any per-file failures.
   * @throws {FileInfoError} If no items are given, an item path is invalid, or a folder fork is malformed.
   * @throws {DriveError} If not initialized, driveId is not found, or a path segment is a file (not a folder).
   * @throws {SignerError} If the publisher/signer is unavailable.
   *   Note: per-file content-upload failures are collected in `failed`, not thrown.
   */
  uploadFiles(
    driveId: string | Identifier,
    items: UploadItem[],
    destinationPath?: string,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<UploadFilesResult>;

  /**
   * Re-versions or changes metadata of an EXISTING file. Reuses the file's feed topic, writes a
   * new feed slot, and never touches the drive manifest (no rename — use  {@link move()} to relocate).
   * Everything derives from `record`, including the ACT-history continuation reference.
   * @param driveId - The ID of the drive the file belongs to.
   * @param record - The existing file's FileRecord (the single source of truth).
   * @param changes - `item` present = new bytes (browser File or node filesystem path); absent =
   *                  metadata-only. `customMetadata` is merged over the record's existing metadata.
   * @param uploadOptions - File-related upload options (actHistoryAddress is derived from record).
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FILE_UPDATED
   * @returns The newly-written FileRecord for the updated version.
   * @throws {FileInfoError} If neither new content (`item`) nor `customMetadata` is provided.
   * @throws {DriveError} If not initialized or driveId is not found.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileError} If the content upload fails.
   */
  updateFile(
    driveId: string | Identifier,
    record: FileRecord,
    changes: UpdateItem,
    uploadOptions?: RedundantUploadOptions | FileUploadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord>;

  /**
   * Downloads every file in a folder subtree of a drive (resolved fresh via  {@link listFolder}).
   * @param driveId - The ID of drive to download from.
   * @param path - Absolute path of the folder; omitted = the whole drive.
   * @param options - Optional download options.
   * @param requestOptions - Additional Bee request options.
   * @returns A promise that resolves to an array of DownloadResult, one per file in the subtree.
   * @throws {DriveError} If not initialized, driveId is not found, or the folder path does not exist.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If a folder feed is missing.
   *   Note: per-file download failures are logged, not thrown.
   */
  downloadFolder(
    driveId: string | Identifier,
    path?: string,
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult[]>;

  /**
   * Downloads a single file the caller already holds as a FileRecord.
   * @param fileRecord - The file to fetch.
   * @param options - Optional download options.
   * @param requestOptions - Additional Bee request options.
   * @returns A promise that resolves to a single DownloadResult.
   * @throws {DriveError} If the FileManager is not initialized.
   * @throws {SignerError} If the publisher/signer is unavailable.
   *   Note: content-fetch failures are logged, not thrown.
   */
  downloadFile(
    record: FileRecord,
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult>;

  /**
   * Downloads files whose FileRecords the caller already holds — no drive traversal or hydration.
   * Fetches exactly the passed records; does not re-resolve them against current drive state.
   * @param fileRecords - The FileRecords to fetch content for.
   * @param options - Optional download options.
   * @param requestOptions - Additional Bee request options.
   * @returns A promise that resolves to an array of DownloadResult, one per record.
   * @throws {DriveError} If the FileManager is not initialized.
   * @throws {SignerError} If the publisher/signer is unavailable.
   *   Note: per-record fetch failures are logged, not thrown.
   */
  downloadFiles(
    fileRecords: FileRecord[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadResult[]>;

  /**
   * Lists entries in a folder (or drive root) in the drive manifest.
   * Also populates the fileInfoList cache for any file entries encountered.
   * @param driveId - The ID of the drive containing the folder.
   * @param path - Absolute path of the folder, or '/' for the drive root.
   * @param depth - Shallow (one level) or Deep (full BFS). Defaults to Shallow.
   * @param maxDepth - Maximum BFS levels when depth is Deep; unlimited if omitted.
   * @param requestOptions - Additional Bee request options.
   * @returns Array of {@link NodeEntry} (FileRecord | FolderInfo) for every node found at or below the given path.
   * @throws {DriveError} If not initialized, driveId is not found, or a path segment does not exist.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If a folder feed is missing.
   */
  listFolder(
    driveId: string | Identifier,
    path: string,
    depth?: ListDepth,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<NodeEntry[]>;

  /**
   * Soft-delete: record a file in the drive's owner-private trash overlay so it is hidden from the
   * active list. This is metadata-only — it does not touch the file's own feed or content, and the
   * trash state is never visible to grantees. Recover with {@link recoverFile}.
   * @param record - The file record describing the file to trash.
   * @emits FileManagerEvents.FILE_TRASHED
   * @throws {DriveError} If the FileManager is not initialized or the drive is not found.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If the file is already trashed.
   */
  trashFile(record: FileRecord, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Recover a previously trashed file back into the active list (removes it from the trash overlay).
   * @param record - The file record describing the file to recover.
   * @emits FileManagerEvents.FILE_RECOVERED
   * @throws {DriveError} If the FileManager is not initialized or the drive is not found.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If the file is not currently trashed.
   */
  recoverFile(record: FileRecord, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Soft-delete a folder: record only the folder's own topic in the drive's owner-private trash
   * overlay. NO propagation — the subtree is untouched and costs a single overlay entry regardless
   * of depth. The active {@link listFolder} hides the folder and stops descending into it; its
   * contents reappear on {@link recoverFolder}.
   * @param folder - The folder to trash (e.g. from {@link listFolder}).
   * @emits FileManagerEvents.FOLDER_TRASHED
   * @throws {DriveError} If the FileManager is not initialized or the drive is not found.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If the folder is already trashed.
   */
  trashFolder(folder: FolderInfo, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Recover a previously trashed folder (removes its topic from the trash overlay). Its subtree,
   * which was never modified, becomes visible again.
   * @param folder - The folder to recover (e.g. from {@link listTrash}).
   * @emits FileManagerEvents.FOLDER_RECOVERED
   * @throws {DriveError} If the FileManager is not initialized or the drive is not found.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If the folder is not currently trashed.
   */
  recoverFolder(folder: FolderInfo, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * List a drive's trashed nodes (files and folders), hydrated into full {@link NodeEntry} objects
   * with `status` = trashed. Reads straight from the owner-private overlay with no tree walk, so the
   * cost is proportional to the number of trashed roots, not the drive size.
   * Recovery is honored per topic so visibility also requires ancestors to be recovered.
   * @param driveId - The drive whose trash to list.
   * @returns The trashed files and folders; pass one back to {@link recoverFile}/{@link recoverFolder}.
   * @throws {DriveError} If the FileManager is not initialized or the drive is not found.
   * @throws {SignerError} If the publisher/signer is unavailable.
   */
  listTrash(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<NodeEntry[]>;

  /**
   * Hard-delete a file or folder at the given path from the drive manifest and in-memory state.
   * For folders, all descendant FileRecords are also purged from fileInfoList.
   * @param driveId - The ID of the drive containing the path.
   * @param path - Absolute path of the file or folder to remove.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FILE_FORGOTTEN (file) or FileManagerEvents.FOLDER_FORGOTTEN (folder)
   * @throws {DriveError} If not initialized, driveId is not found, the path is the drive root, or the path does not exist.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If a folder feed is missing.
   */
  forget(driveId: string | Identifier, path: string, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Destroys a drive identified by the given drive ID.
   * Dilutes the drive stamp and shortens its duration (min. 24, max 47 hours) depending on the original TTL.
   * @param driveId - The ID of the drive to destroy.
   * @emits FileManagerEvents.DRIVE_DESTROYED
   * @returns A promise that resolves when the drive is destroyed.
   * @throws {DriveError} If not initialized, driveId is not found, or the target is the admin drive.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {StampError} If the admin stamp is missing, or the drive's stamp cannot be fetched / is not usable.
   */
  destroyDrive(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Removes the drive and all of its file metadata from local state and persists the updated drive list.
   * Does NOT touch the underlying Swarm batch (no dilution).
   * @param driveId - The ID of the drive to forget.
   * @emits FileManagerEvents.DRIVE_FORGOTTEN
   * @returns A promise that resolves when the drive is forgotten.
   * @throws {DriveError} If not initialized, driveId is not found, or the target is the admin drive.
   * @throws {SignerError} If the publisher/signer is unavailable.
   */
  forgetDrive(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Shares a file with the specified recipients.
   * @param record - The file record to share.
   * @param targetOverlays - An array of target overlays.
   * @param recipients - An array of recipient overlay addresses.
   * @param message - Optional message to include with the share.
   * @emits FileManagerEvents.SHARE_MESSAGE_SENT
   * @returns A promise that resolves when the file is shared.
   * @throws {SendShareMessageError} Always — not yet implemented in the node-based model.
   */
  share(
    record: FileRecord,
    targetOverlays: string[],
    recipients: string[],
    message?: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<void>;

  /**
   * Subscribes to the shared inbox with the given topic and callback.
   * @param topic - The topic to subscribe to.
   * @param callback - Optional callback function to handle incoming shared items.
   * @returns A promise that resolves when the subscription is successful.
   * @throws {SubscriptionError} Always — not yet implemented in the node-based model.
   */
  subscribeToSharedInbox(topic: string, callback?: (data: ShareItem) => void): Promise<void>;

  /**
   * Unsubscribes from the shared inbox.
   * @throws {SubscriptionError} Always — not yet implemented in the node-based model.
   */
  unsubscribeFromSharedInbox(): void;

  /**
   * Retrieves the grantees of a file.
   * @param record - The file record to query.
   * @returns A promise that resolves to list of grantee public keys.
   * @throws {GranteeError} Always — not yet migrated to the mantaray model.
   */
  getGrantees(record: FileRecord): Promise<GetGranteesResult>;

  /**
   * Returns a specific version of a file.
   *
   * @param record - The base FileRecord containing topic and owner fields.
   * @param version - Optional desired version slot as a FeedIndex or hex/string. If omitted, fetches latest.
   * @returns The FileRecord corresponding to the requested version, either cached or fetched.
   * @throws {DriveError} If the FileManager is not initialized.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If the file feed is not found.
   */
  getFileVersion(
    record: FileRecord,
    version?: string | FeedIndex,
    requestOptions?: BeeRequestOptions,
  ): Promise<FileRecord>;

  /**
   * Restore a previous version of a file as the new "head" in your feed.
   *
   * @param versionToRestore - The FileRecord instance representing the version to restore.
   * @param requestOptions - Optional BeeRequestOptions for upload operations.
   * @emits FileManagerEvents.FILE_VERSION_RESTORED
   * @throws {DriveError} If the FileManager is not initialized.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If the feed is not found, the restore version is undefined, or it is the current head.
   */
  restoreFileVersion(versionToRestore: FileRecord, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Moves a file or folder within a drive from one path to another.
   *
   * @param fromPath - Absolute path of the entry within the drive manifest.
   * @param toPath - Destination path within the drive manifest.
   * @param sourceDriveId - The ID of the drive containing the source path.
   * @param targetDriveId - Optional target ID drive for cross-drive moves; defaults to sourceDriveInfo.
   * @param requestOptions - Optional BeeRequestOptions for upload operations.
   * @emits FileManagerEvents.FILE_MOVED
   * @throws {DriveError} If not initialized, a source/target driveId is not found, the source is the
   *   root, the destination is invalid, source and destination are identical, or a path does not exist.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If a folder feed or the source file record is missing.
   */
  move(
    fromPath: string,
    toPath: string,
    sourceDriveId: string | Identifier,
    targetDriveId?: string | Identifier,
    requestOptions?: BeeRequestOptions,
  ): Promise<void>;

  /**
   * Creates a new empty folder within a drive.
   * @param driveId - The ID of the drive to create the folder in.
   * @param parentPath - Absolute path of the parent directory, or '/' for the drive root.
   * @param folderName - Name of the new folder (must not contain '/').
   * @param redundancyLevel - Optional redundancy level; inherits from parent or drive if omitted.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FOLDER_CREATED
   * @returns The FolderInfo for the newly created folder.
   * @throws {DriveError} If not initialized, driveId is not found, the folder name is invalid, or the parent path does not exist.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileInfoError} If a folder feed is missing.
   */
  createFolder(
    driveId: string | Identifier,
    parentPath: string,
    folderName: string,
    redundancyLevel?: RedundancyLevel,
    requestOptions?: BeeRequestOptions,
  ): Promise<FolderInfo>;

  /**
   * Admin postage batch used for drive management operations.
   * @returns The admin postage batch, or undefined if not set.
   */
  readonly adminStamp: PostageBatch | undefined;

  // TODO: consider using: Readonly<DriveInfo>
  /**
   * Retrieves a list of drive information.
   * @returns An array of drive information objects.
   */
  readonly driveList: DriveInfo[];

  // TODO: consider using: Readonly<FileRecord>
  // TODO: consider renaming to fileList and also maybe use folderlist
  /**
   * Retrieves a list of file records.
   * @returns An array of FileRecord objects.
   */
  readonly fileInfoList: FileRecord[];

  /**
   * Retrieves a list of items shared with the user.
   * @returns An array of shared items.
   */
  readonly sharedWithMe: ShareItem[];

  /**
   * Event emitter for handling file manager events.
   */
  readonly emitter: EventEmitter;
}
