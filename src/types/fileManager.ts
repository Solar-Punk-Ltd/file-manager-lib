import {
  type BatchId,
  type BeeRequestOptions,
  type DownloadOptions,
  type FeedIndex,
  type FileUploadOptions,
  type Identifier,
  type PostageBatch,
  type RedundancyLevel,
  type RedundantUploadOptions,
} from '@ethersphere/bee-js';

import { type EventEmitter } from '../eventEmitter';

import { type DownloadFilesResult, type DownloadResult } from './download';
import { type DriveInfo, type FileRecord, type FolderInfo, type ListDepth, type NodeEntry } from './info';
import { type UpdateItem, type UploadFilesResult, type UploadItem } from './upload';

/**
 * Interface representing a file manager with various file, folder and drive operations.
 */
export interface FileManager {
  /**
   * Initializes the file manager. Never rejects: failures are reported as `INITIALIZED false`, and
   * all partial state is rolled back so the call can simply be retried.
   * @emits FileManagerEvents.INITIALIZED
   * @emits FileManagerEvents.STATE_INVALID
   * @returns A promise that resolves when the initialization is complete.
   */
  initialize(): Promise<void>;

  /**
   * Bootstraps the admin state (drive registry) and creates the admin drive.
   *  It establishes the state feed and its empty admin manifest before registering the admin drive into it.
   * Regular drives are created with {@link createDrive} once this has succeeded.
   * @param batchId - The batch ID for the admin drive / state.
   * @param redundancyLevel - Optional redundancy level for the admin drive.
   * @param reset - Overwrite existing admin state with a freshly generated one (wipes local state
   *   and appends a new state pointer). Required when admin state already exists.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.DRIVE_CREATED
   * @returns The newly-created admin DriveInfo.
   * @throws {DriveError} If not initialized, or admin state already exists without `reset`.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {StampError} If the admin batch stamp is missing or not usable.
   */
  createAdminDrive(
    batchId: string | BatchId,
    redundancyLevel?: RedundancyLevel,
    reset?: boolean,
    requestOptions?: BeeRequestOptions,
  ): Promise<DriveInfo>;

  /**
   * Creates a new (non-admin) drive and registers it in the admin manifest. Requires the admin state
   * to already exist — call {@link createAdminDrive} first for initial setup.
   * @param batchId - The batch ID for the drive.
   * @param name - The name of the drive.
   * @param redundancyLevel - Optional redundancy level for the drive.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.DRIVE_CREATED
   * @returns The newly-created DriveInfo.
   * @throws {DriveError} If not initialized, admin state/manifest is not ready, or a drive with the
   *   same name or batchId already exists.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {StampError} If the batch stamp is missing or not usable.
   */
  createDrive(
    batchId: string | BatchId,
    name: string,
    redundancyLevel?: RedundancyLevel,
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
   * @throws {DriveError} If not initialized, driveId is not found, the target folder path does not
   *   exist, or a node already occupies `item.path` (fork keys are names, so names are unique
   *   within a folder — re-version with {@link updateFile} or relocate with {@link move}).
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileError} If the source is a directory, a node source path does not exist, or the content upload fails.
   * @throws {FileRecordError} If `item.path` is invalid or a folder along the path has no feed.
   * @throws {FolderError} If the path is under the reserved `.trash` folder.
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
   * Aborting rejects as soon as the signal is seen and no manifest is saved,
   * @param driveId - The ID of the drive to upload into.
   * @param items - The files to upload, each with a path relative to destinationPath.
   * @param destinationPath - Absolute path of the destination folder; defaults to the drive root.
   * @param uploadOptions - File-related upload options.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FOLDER_CREATED (per folder created)
   * @emits FileManagerEvents.FILE_UPLOADED (per file uploaded)
   * @emits FileManagerEvents.FILES_UPLOADED (once, with the batch summary)
   * @returns The succeeded FileRecords and any per-file failures.
   * @throws {FileRecordError} If no items are given, an item path is invalid, two items resolve to
   *   the same destination path, or a folder fork is malformed.
   * @throws {DriveError} If not initialized, driveId is not found, or a path segment is a file (not
   *   a folder).
   * @throws {FolderError} If a destination is under the reserved `.trash` folder.
   * @throws {SignerError} If the publisher/signer is unavailable.
   *   Note: per-file content-upload failures are collected in `failed`, not thrown — as is an item
   *   whose destination name is already taken in the drive. An aborted signal rejects instead.
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
   * @throws {FileRecordError} If neither new content (`item`) nor `customMetadata` is provided, the
   *   file is trashed, or the fork at the record's path belongs to a different node.
   * @throws {DriveError} If not initialized or driveId is not found.
   * @throws {FolderError} If no fork exists at the record's path.
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
   * Trashed files are skipped.
   * @param driveId - The ID of drive to download from.
   * @param path - Absolute path of the folder; defaults to the drive root.
   * @param options - Optional download options.
   * @param requestOptions - Additional Bee request options.
   * @returns A promise that resolves to DownloadFilesResult, marking per file success and failure in the subtree.
   * @throws {DriveError} If not initialized, driveId is not found, or the folder path does not exist.
   * @throws {FolderError} If the path is the reserved `.trash` folder.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If a folder feed is missing.
   *   Note: per-file download failures are logged, not thrown.
   */
  downloadFolder(
    driveId: string | Identifier,
    path?: string,
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadFilesResult>;

  /**
   * Downloads a single file the caller already holds as a FileRecord.
   * @param fileRecord - The file to fetch.
   * @param options - Optional download options.
   * @param requestOptions - Additional Bee request options.
   * @returns A promise that resolves to a single DownloadResult.
   * @throws {DriveError} If the FileManager is not initialized.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileError} If the content fetch fails.
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
   * @returns A promise that resolves to a DownloadFilesResult.
   * @throws {DriveError} If the FileManager is not initialized.
   * @throws {SignerError} If the publisher/signer is unavailable.
   *   Note: per-record fetch failures are logged, not thrown.
   */
  downloadFiles(
    fileRecords: FileRecord[],
    options?: DownloadOptions,
    requestOptions?: BeeRequestOptions,
  ): Promise<DownloadFilesResult>;

  /**
   * Lists entries in a folder (or drive root) in the drive manifest.
   * Also populates the recordList cache for any file entries encountered.
   * Trashed nodes are not returned: the reserved `.trash` folder is omitted from the drive root and
   * cannot be listed through this method — use {@link listTrash}.
   * @param driveId - The ID of the drive containing the folder.
   * @param path - Absolute path of the folder, or '/' for the drive root.
   * @param depth - Shallow (one level) or Deep (full BFS). Defaults to Shallow.
   * @param maxDepth - Maximum BFS levels when depth is Deep; must be positive, unlimited if omitted.
   * @param requestOptions - Additional Bee request options.
   * @returns Array of {@link NodeEntry} (FileRecord | FolderInfo) for every node found at or below the given path.
   * @throws {DriveError} If not initialized, driveId is not found, or a path segment does not exist.
   * @throws {FolderError} If the path is the reserved `.trash` folder, or `maxDepth` is not positive.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If a folder feed is missing.
   */
  listFolder(
    driveId: string | Identifier,
    path: string,
    depth?: ListDepth,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<NodeEntry[]>;

  /**
   * Soft-delete a file or folder: relocates its fork into the drive's reserved `.trash` folder.
   *
   * @param driveId - The drive containing the node.
   * @param path - Absolute path of the file or folder to trash.
   * @emits FileManagerEvents.FILE_TRASHED or FileManagerEvents.FOLDER_TRASHED
   * @throws {DriveError} If not initialized, the drive is not found, or a folder along the path does
   *   not exist.
   * @throws {FolderError} If the path is the drive root, is already under `.trash`, or the node
   *   itself does not exist.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If the fork carries no node metadata.
   */
  trash(driveId: string | Identifier, path: string, requestOptions?: BeeRequestOptions): Promise<void>;

  /**
   * Restore a trashed node to `toPath`, or back to the location it was trashed from when `toPath` is
   * omitted. Restores location only — the node's content and version are whatever they were.
   *
   * The recorded origin can go stale: if that folder has since been forgotten, moved or trashed,
   * resolution fails and the caller must pass an explicit `toPath`. An occupied destination is
   * refused rather than overwritten.
   * @param driveId - The drive containing the trashed node.
   * @param trashedPath - The node's trashed path (`.trash/<topic>`), as returned by {@link listTrash}.
   * @param toPath - Optional destination; defaults to the stamped origin path.
   * @returns The path the node was restored to.
   * @emits FileManagerEvents.FILE_RECOVERED or FileManagerEvents.FOLDER_RECOVERED
   * @throws {DriveError} If not initialized, the drive is not found, the destination is already
   *   occupied, or the destination's parent folder no longer exists.
   * @throws {FolderError} If the destination is under `.trash`.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If `trashedPath` is not a `.trash/<topic>` path, the destination path
   *   is invalid, the node is not in the trash, or it has no recorded origin and no `toPath` was given.
   */
  recover(
    driveId: string | Identifier,
    trashedPath: string,
    toPath?: string,
    requestOptions?: BeeRequestOptions,
  ): Promise<string>;

  /**
   * List a drive's trash. Walks the reserved `.trash` folder with the same machinery as
   * {@link listFolder}, so `depth` controls the cost: Shallow returns the trashed roots only, Deep
   * descends into trashed folders. Returns `[]` for a drive that has never had anything trashed.
   *
   * @param driveId - The drive whose trash to list.
   * @param depth - Shallow (trashed roots only) or Deep (full BFS). Defaults to Shallow.
   * @param maxDepth - Maximum BFS levels when depth is Deep; must be positive, unlimited if omitted.
   * @throws {DriveError} If the FileManager is not initialized or the drive is not found.
   * @throws {FolderError} If `maxDepth` is not positive.
   * @throws {SignerError} If the publisher/signer is unavailable.
   */
  listTrash(
    driveId: string | Identifier,
    depth?: ListDepth,
    maxDepth?: number,
    requestOptions?: BeeRequestOptions,
  ): Promise<NodeEntry[]>;

  /**
   * De-reference every node in a drive's trash in one manifest write. Like {@link forget}, the
   * content stays on Swarm until its stamp expires — this drops the references, it does not delete
   * the data.
   * @param driveId - The drive whose trash to empty.
   * @returns The number of trashed nodes that were de-referenced.
   * @emits FileManagerEvents.TRASH_EMPTIED
   * @throws {DriveError} If the FileManager is not initialized or the drive is not found.
   * @throws {SignerError} If the publisher/signer is unavailable.
   */
  emptyTrash(driveId: string | Identifier, requestOptions?: BeeRequestOptions): Promise<number>;

  /**
   * Hard-delete a file or folder at the given path from the drive manifest and in-memory state.
   * For folders, all descendant FileRecords are also purged from recordList.
   * @param driveId - The ID of the drive containing the path.
   * @param path - Absolute path of the file or folder to remove.
   * @param requestOptions - Additional Bee request options.
   * @emits FileManagerEvents.FILE_FORGOTTEN (file) or FileManagerEvents.FOLDER_FORGOTTEN (folder)
   * @throws {DriveError} If not initialized, driveId is not found, or a folder along the path does
   *   not exist.
   * @throws {FolderError} If the path is the drive root, or the reserved `.trash` folder — emptying
   *   the trash goes through {@link emptyTrash}.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If the path does not exist or a folder feed is missing.
   */
  forget(driveId: string | Identifier, path: string, requestOptions?: BeeRequestOptions): Promise<void>;

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
   * Returns a specific version of a file.
   *
   * @param record - The base FileRecord containing topic, owner and the node's current path.
   * @param version - Optional desired version slot as a FeedIndex or its 16-hex-character string. If omitted, fetches latest.
   * @returns The FileRecord corresponding to the requested version, either cached or fetched.
   * @throws {DriveError} If the FileManager is not initialized.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If the file feed is not found.
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
   * @throws {FolderError} If the file's fork cannot be found at its current path.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If the feed is not found, the restore version is undefined, it is the
   *   current head, or the fork at the resolved path belongs to a different node.
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
   * @throws {DriveError} If not initialized, a source/target driveId is not found, or a folder along
   *   either path does not exist.
   * @throws {FolderError} If the source is the root, the destination is invalid, source and
   *   destination are identical, the source does not exist, the destination is already occupied, or
   *   either path is under the reserved `.trash` folder — trashing goes through {@link trash}.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If a folder feed or the source file record is missing.
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
   * @throws {DriveError} If not initialized, driveId is not found, or the parent path does not exist.
   * @throws {FolderError} If the folder name is invalid or reserved (`.trash`), or a node already
   *   occupies that name.
   * @throws {SignerError} If the publisher/signer is unavailable.
   * @throws {FileRecordError} If a folder feed is missing.
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

  /**
   * Retrieves a list of drive information.
   * @returns An array of drive information objects.
   */
  readonly driveList: readonly DriveInfo[];

  /**
   * Retrieves a list of file records.
   * @returns An array of FileRecord objects.
   */
  readonly recordList: readonly FileRecord[];

  /**
   * Event emitter for handling file manager events.
   */
  readonly emitter: EventEmitter;

  /**
   * Indicates whether or not the FileManager instance is initialized.
   */
  readonly isInitialized: boolean;
}

export interface FileManagerConfig {
  uploadConcurrency?: number; // default MAX_CONCURRENT_UPLOADS (2)
  feedFetchConcurrency?: number; // default MAX_CONCURRENT_FEED_FETCHES (10)
}
