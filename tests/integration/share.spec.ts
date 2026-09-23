import { type BatchId, Identifier, PrivateKey, Topic } from '@ethersphere/bee-js';

import { createInitializedFileManager, retryOnPropagationDelay, streamToUint8Array } from '../utils';

import { ensureUniqueSignerWithStamp, setupUserDrive, tempFileRegistry } from './setup/utils';

import { type BeeClient } from '@/clients';
import { type FileManagerBase } from '@/fileManager';
import {
  type DriveInfo,
  DriveKind,
  type FileRecord,
  ListDepth,
  type NodeEntry,
  NodeType,
  type ShareEntry,
  ShareGrade,
  type ShareHandle,
} from '@/types';
import { FileManagerEvents } from '@/utils';
import { readShareHead } from '@/utils/bee';
import { ROOT_PATH } from '@/utils/constants';

const RECIPIENT_A = new PrivateKey('11'.repeat(32)).publicKey().toCompressedHex();
const RECIPIENT_B = new PrivateKey('44'.repeat(32)).publicKey().toCompressedHex();
const RECIPIENT_C = new PrivateKey('55'.repeat(32)).publicKey().toCompressedHex();

const retryWhileGranteeSettles = <T>(fn: () => Promise<T>): Promise<T> => retryOnPropagationDelay(fn, 8, 1000);

describe('share', () => {
  let client: BeeClient;
  let fileManager: FileManagerBase;
  let drive: DriveInfo;
  let ownerStamp: BatchId;
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ client, fileManager, drive, ownerStamp } = await setupUserDrive('share', { stampLabel: 'shareIntegration' }));
    const src = writeTempFile('it-share-notes.txt', 'Share Notes Content');
    await fileManager.uploadFile(drive.id, { path: 'notes.txt', sourcePath: src });
  });

  afterAll(cleanup);

  it('mints a grant for a folder, emits SHARE_CREATED and lists its grantees', async () => {
    const handler = jest.fn();
    fileManager.emitter.on(FileManagerEvents.SHARE_CREATED, handler);

    try {
      const folder = await fileManager.createFolder(drive.id, ROOT_PATH, 'granted');
      const entry = await fileManager.share(drive.id, 'granted', ShareGrade.Read, [RECIPIENT_A]);

      expect(entry).toMatchObject({
        nodeTopic: folder.topic,
        driveId: drive.id,
        type: NodeType.Folder,
        path: 'granted',
        grade: ShareGrade.Read,
      });
      expect(entry.revokedAt).toBeUndefined();
      expect(entry.shareTopic).toHaveLength(64);
      expect(entry.publisher).toBeTruthy();
      expect(handler).toHaveBeenCalledWith({ entry: fileManager.shareList!.find((e) => e.id === entry.id) });

      expect(await fileManager.getShareGrantees(entry.id)).toEqual([RECIPIENT_A]);
    } finally {
      fileManager.emitter.off(FileManagerEvents.SHARE_CREATED, handler);
    }
  });

  it('publishes a head on the share feed that a recipient can read back', async () => {
    await fileManager.createFolder(drive.id, ROOT_PATH, 'published');
    const entry = await fileManager.share(drive.id, 'published', ShareGrade.Read, [RECIPIENT_A]);

    const head = await retryOnPropagationDelay(() =>
      readShareHead(client, { shareTopic: entry.shareTopic, owner: drive.owner }),
    );

    expect(head).toMatchObject({
      reference: entry.act.reference,
      historyRef: entry.act.historyRef,
      publisher: entry.publisher,
    });
    expect(head).not.toHaveProperty('grade');
  });

  it('adds recipients to the standing grant of the same node and grade', async () => {
    const handler = jest.fn();
    fileManager.emitter.on(FileManagerEvents.SHARE_AMENDED, handler);

    try {
      await fileManager.createFolder(drive.id, ROOT_PATH, 'amend');
      const first = await fileManager.share(drive.id, 'amend', ShareGrade.Read, [RECIPIENT_A]);
      const second = await retryWhileGranteeSettles(() =>
        fileManager.share(drive.id, 'amend', ShareGrade.Read, [RECIPIENT_B]),
      );

      // The handle the first recipients hold has to keep working.
      expect(second.id).toBe(first.id);
      expect(second.shareTopic).toBe(first.shareTopic);
      expect((await fileManager.getShareGrantees(second.id)).sort()).toEqual([RECIPIENT_A, RECIPIENT_B].sort());
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      fileManager.emitter.off(FileManagerEvents.SHARE_AMENDED, handler);
    }
  });

  it('mints a separate grant for a different grade of the same node', async () => {
    await fileManager.createFolder(drive.id, ROOT_PATH, 'grades');
    const read = await fileManager.share(drive.id, 'grades', ShareGrade.Read, [RECIPIENT_A]);
    const list = await fileManager.share(drive.id, 'grades', ShareGrade.List, [RECIPIENT_A]);

    expect(list.id).not.toBe(read.id);
    expect(list.shareTopic).not.toBe(read.shareTopic);
    expect(list.nodeTopic).toBe(read.nodeTopic);
  });

  it('shares a file as an open grant and refuses any other grade for it', async () => {
    const entry = await fileManager.share(drive.id, 'notes.txt', ShareGrade.Open, [RECIPIENT_A]);

    expect(entry).toMatchObject({ type: NodeType.File, path: 'notes.txt', grade: ShareGrade.Open });

    await expect(fileManager.share(drive.id, 'notes.txt', ShareGrade.Read, [RECIPIENT_A])).rejects.toThrow(
      'A file can only be shared as "open"',
    );
  });

  it('refuses an empty recipient list, an open grant of a container and an unknown drive', async () => {
    await fileManager.createFolder(drive.id, ROOT_PATH, 'refusals');

    await expect(fileManager.share(drive.id, 'refusals', ShareGrade.Read, [])).rejects.toThrow(
      'A share needs at least one recipient',
    );
    await expect(fileManager.share(drive.id, 'refusals', ShareGrade.Open, [RECIPIENT_A])).rejects.toThrow(
      'shares a single file',
    );

    const ghostDrive = Identifier.fromString('ghost-drive').toString();
    await expect(fileManager.share(ghostDrive, 'refusals', ShareGrade.Read, [RECIPIENT_A])).rejects.toThrow(
      `Drive with id ${ghostDrive.slice(0, 6)} not found`,
    );
  });

  it('refuses to share from the admin drive', async () => {
    const admin = fileManager.driveList.find((d) => d.kind === DriveKind.Admin)!;
    await expect(fileManager.share(admin.id, '.shares', ShareGrade.Read, [RECIPIENT_A])).rejects.toThrow(
      'Cannot share from the admin drive',
    );
  });

  it('refuses a grant on the drive root, however the path spells it', async () => {
    for (const path of [ROOT_PATH, '', '//']) {
      await expect(fileManager.share(drive.id, path, ShareGrade.Read, [RECIPIENT_A])).rejects.toThrow(
        'Cannot share a drive',
      );
    }

    expect(fileManager.shareList!.some((e) => e.nodeTopic === drive.topic)).toBe(false);
  });

  it('a fresh instance loads the published share index', async () => {
    await fileManager.createFolder(drive.id, ROOT_PATH, 'persisted');
    const entry = await fileManager.share(drive.id, 'persisted', ShareGrade.List, [RECIPIENT_C]);

    const fresh = await retryOnPropagationDelay(async () => {
      const fm = await createInitializedFileManager(client, ownerStamp);
      if (!(await fm.listShares()).some((e) => e.id === entry.id)) {
        throw new Error('share index not yet propagated to a fresh instance');
      }
      return fm;
    });

    const seen = fresh.shareList!.find((e) => e.id === entry.id)!;
    expect(seen.shareTopic).toBe(entry.shareTopic);
    expect(seen.nodeTopic).toBe(entry.nodeTopic);
    expect(seen.grade).toBe(ShareGrade.List);
    expect(await fresh.getShareGrantees(entry.id)).toEqual([RECIPIENT_C]);
  });
});

describe('revokeShare', () => {
  let fileManager: FileManagerBase;
  let drive: DriveInfo;

  beforeAll(async () => {
    ({ fileManager, drive } = await setupUserDrive('sharerevoke', { stampLabel: 'shareRevokeIntegration' }));
  });

  const grantFolder = async (name: string, recipients: string[]): Promise<ShareEntry> => {
    await fileManager.createFolder(drive.id, ROOT_PATH, name);

    return await fileManager.share(drive.id, name, ShareGrade.Read, recipients);
  };

  it('closes the grant, emits SHARE_REVOKED and lets a later share mint a fresh one', async () => {
    const handler = jest.fn();
    fileManager.emitter.on(FileManagerEvents.SHARE_REVOKED, handler);

    try {
      const entry = await grantFolder('revoke-all', [RECIPIENT_A, RECIPIENT_B]);

      const revoked = await retryWhileGranteeSettles(() => fileManager.revokeShare(entry.id));

      expect(revoked.revokedAt).toEqual(expect.any(Number));
      expect(await fileManager.getShareGrantees(entry.id)).toEqual([]);
      expect(handler).toHaveBeenCalledWith({ entry: revoked });

      // A revoked entry is never matched again, so the same subject mints a new grant.
      const reshared = await fileManager.share(drive.id, 'revoke-all', ShareGrade.Read, [RECIPIENT_C]);
      expect(reshared.id).not.toBe(entry.id);
      expect(reshared.shareTopic).not.toBe(entry.shareTopic);
      expect(await fileManager.getShareGrantees(reshared.id)).toEqual([RECIPIENT_C]);
    } finally {
      fileManager.emitter.off(FileManagerEvents.SHARE_REVOKED, handler);
    }
  });

  it('drops only the named recipients and keeps the grant open', async () => {
    const entry = await grantFolder('revoke-one', [RECIPIENT_A, RECIPIENT_B]);

    const amended = await retryWhileGranteeSettles(() => fileManager.revokeShare(entry.id, [RECIPIENT_A]));

    expect(amended.revokedAt).toBeUndefined();
    expect(await fileManager.getShareGrantees(entry.id)).toEqual([RECIPIENT_B]);
  });

  it('closes the grant when a partial revoke removes its last member', async () => {
    const entry = await grantFolder('revoke-last', [RECIPIENT_A]);

    const revoked = await retryWhileGranteeSettles(() => fileManager.revokeShare(entry.id, [RECIPIENT_A]));

    expect(revoked.revokedAt).toEqual(expect.any(Number));
    await expect(fileManager.revokeShare(entry.id)).rejects.toThrow(`Share ${entry.id.slice(0, 6)} is already revoked`);
  });

  it('refuses recipients the grant does not include', async () => {
    const entry = await grantFolder('revoke-stranger', [RECIPIENT_A]);

    await expect(fileManager.revokeShare(entry.id, [RECIPIENT_B])).rejects.toThrow(
      `Share ${entry.id.slice(0, 6)} grants none of the given recipients`,
    );
    expect(await fileManager.getShareGrantees(entry.id)).toEqual([RECIPIENT_A]);
  });
});

describe('acceptShare', () => {
  let owner: FileManagerBase;
  let drive: DriveInfo;
  let recipient: FileManagerBase;
  let folderHandle: ShareHandle;
  let fileHandle: ShareHandle;
  let listHandle: ShareHandle;
  let folderTopic: string;
  let shelfTopic: string;
  const FILE_CONTENT = 'Accepted Share Content';
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ fileManager: owner, drive } = await setupUserDrive('shareaccept', { stampLabel: 'shareAcceptIntegration' }));

    const inner = writeTempFile('it-share-inner.txt', FILE_CONTENT);
    const solo = writeTempFile('it-share-solo.txt', FILE_CONTENT);
    const folder = await owner.createFolder(drive.id, ROOT_PATH, 'Docs');
    folderTopic = folder.topic;
    await owner.uploadFile(drive.id, { path: 'Docs/inner.txt', sourcePath: inner });
    await owner.uploadFile(drive.id, { path: 'solo.txt', sourcePath: solo });

    const shelf = await owner.createFolder(drive.id, ROOT_PATH, 'Shelf');
    shelfTopic = shelf.topic;
    await owner.createFolder(drive.id, 'Shelf', 'Nested');
    await owner.uploadFile(drive.id, { path: 'Shelf/top.txt', sourcePath: inner });
    await owner.uploadFile(drive.id, { path: 'Shelf/Nested/deep.txt', sourcePath: inner });

    // The two identities share one Bee node, so ACT decryption succeeds for the publisher itself;
    // what this exercises is the grant blob, the share feed and the mount, not Bee's gating.
    const { client, ownerStamp } = await ensureUniqueSignerWithStamp();
    recipient = await createInitializedFileManager(client, ownerStamp);

    const folderEntry = await owner.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
    const fileEntry = await owner.share(drive.id, 'solo.txt', ShareGrade.Open, [RECIPIENT_A]);
    const listEntry = await owner.share(drive.id, 'Shelf', ShareGrade.List, [RECIPIENT_A]);
    folderHandle = { shareTopic: folderEntry.shareTopic, owner: drive.owner };
    fileHandle = { shareTopic: fileEntry.shareTopic, owner: drive.owner };
    listHandle = { shareTopic: listEntry.shareTopic, owner: drive.owner };
  });

  afterAll(cleanup);

  const acceptWhenReadable = (handle: ShareHandle): Promise<NodeEntry> =>
    retryOnPropagationDelay(() => recipient.acceptShare(handle));

  it('mounts a granted folder into sharedWithMe and reads what it contains', async () => {
    const handler = jest.fn();
    recipient.emitter.on(FileManagerEvents.SHARE_ACCEPTED, handler);

    try {
      const mounted = await acceptWhenReadable(folderHandle);

      expect(mounted).toMatchObject({
        type: NodeType.Folder,
        topic: folderTopic,
        owner: drive.owner,
        path: 'Docs',
        driveId: recipient.sharedWithMe!.id,
      });
      expect(handler).toHaveBeenCalledWith({ driveId: recipient.sharedWithMe!.id, entry: mounted });

      const entries = await retryOnPropagationDelay(() =>
        recipient.listFolder(recipient.sharedWithMe!.id, 'Docs', ListDepth.Shallow).then((r) => r.entries),
      );
      expect(entries.some((e) => e.type === NodeType.File && e.path === 'Docs/inner.txt')).toBe(true);
    } finally {
      recipient.emitter.off(FileManagerEvents.SHARE_ACCEPTED, handler);
    }
  });

  it('mounts an open file grant and downloads its bytes with the granted content key', async () => {
    const mounted = (await acceptWhenReadable(fileHandle)) as FileRecord;

    expect(mounted).toMatchObject({
      type: NodeType.File,
      owner: drive.owner,
      path: 'solo.txt',
      driveId: recipient.sharedWithMe!.id,
    });

    const downloaded = await retryOnPropagationDelay(() => recipient.downloadFile(mounted));
    expect(Buffer.from(await streamToUint8Array(downloaded.result)).toString('utf-8')).toBe(FILE_CONTENT);
  });

  it('mounts a list grant that walks the whole subtree without opening anything in it', async () => {
    const mounted = await acceptWhenReadable(listHandle);

    expect(mounted).toMatchObject({ type: NodeType.Folder, topic: shelfTopic, path: 'Shelf' });

    const { entries, failed } = await retryOnPropagationDelay(async () => {
      const listed = await recipient.listFolder(recipient.sharedWithMe!.id, 'Shelf', ListDepth.Deep);
      if (!listed.entries.some((e) => e.path === 'Shelf/Nested/deep.txt')) {
        throw new Error('list-granted subtree not yet propagated');
      }
      return listed;
    });

    // The whole subtree lists — the missing content key is not a failure, it is the grade.
    expect(failed).toEqual([]);
    expect(entries.map((e) => e.path).sort()).toEqual(['Shelf/Nested', 'Shelf/Nested/deep.txt', 'Shelf/top.txt']);

    const files = entries.filter((e): e is FileRecord => e.type === NodeType.File);
    expect(files.map((f) => f.name).sort()).toEqual(['deep.txt', 'top.txt']);
    for (const file of files) {
      // The fork metadata is the whole entry: no record feed was opened, so there is no content ref.
      expect(file.content).toBeUndefined();
      expect(file).toMatchObject({ owner: drive.owner, driveId: recipient.sharedWithMe!.id });
      expect(file.version).toEqual(expect.any(String));
    }

    // Reaching for the bytes fails where the key is missing, not at accept time.
    const { succeeded, failed: downloadFailed } = await recipient.downloadFiles(files);
    expect(succeeded).toEqual([]);
    expect(downloadFailed.map((f) => f.path).sort()).toEqual(['Shelf/Nested/deep.txt', 'Shelf/top.txt']);
  });

  it('refuses to open a file the list grant only listed', async () => {
    const { entries } = await recipient.listFolder(recipient.sharedWithMe!.id, 'Shelf', ListDepth.Deep);
    const file = entries.find((e): e is FileRecord => e.type === NodeType.File && e.path === 'Shelf/top.txt')!;

    await expect(recipient.downloadFile(file)).rejects.toThrow('Failed to download Shelf/top.txt');

    // Not the missing pointer but the key chain itself: the record feed is sealed under K_content.
    await expect(recipient.getFileVersion(file)).rejects.toThrow(/No content key for node .+ list grant/);
  });

  it('refuses to mount the same node twice', async () => {
    await expect(recipient.acceptShare(folderHandle)).rejects.toThrow(/already mounted at Docs/);
  });

  it('throws when the share feed has no head', async () => {
    await expect(
      recipient.acceptShare({ shareTopic: Topic.fromString('never-published').toString(), owner: drive.owner }),
    ).rejects.toThrow('Share feed has no head');
  });

  it('refuses to re-share a mounted node', async () => {
    await expect(recipient.share(recipient.sharedWithMe!.id, 'Docs', ShareGrade.Read, [RECIPIENT_B])).rejects.toThrow(
      /cannot be re-shared/,
    );
  });
});

describe('reading a revoked grant', () => {
  let owner: FileManagerBase;
  let drive: DriveInfo;
  let recipientClient: BeeClient;
  let recipientStamp: BatchId;
  let entry: ShareEntry;
  const BEFORE_CONTENT = 'Readable Before The Revoke';
  const AFTER_CONTENT = 'Written After The Revoke';
  const { writeTempFile, cleanup } = tempFileRegistry();

  beforeAll(async () => {
    ({ fileManager: owner, drive } = await setupUserDrive('sharerevoked', { stampLabel: 'shareRevokedIntegration' }));

    await owner.createFolder(drive.id, ROOT_PATH, 'Docs');
    await owner.uploadFile(drive.id, {
      path: 'Docs/A.pdf',
      sourcePath: writeTempFile('it-share-revoked-a.pdf', BEFORE_CONTENT),
    });

    ({ client: recipientClient, ownerStamp: recipientStamp } = await ensureUniqueSignerWithStamp());
    const recipient = await createInitializedFileManager(recipientClient, recipientStamp);

    entry = await owner.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
    await retryOnPropagationDelay(() => recipient.acceptShare({ shareTopic: entry.shareTopic, owner: drive.owner }));
  });

  afterAll(cleanup);
  // TODO: test access of the same identity of siblings if other grants are still live
  it('denies a revoked recipient the writes that land after the revoke', async () => {
    const revoked = await retryWhileGranteeSettles(() => owner.revokeShare(entry.id));
    expect(revoked.revokedAt).toEqual(expect.any(Number));
    expect(await owner.getShareGrantees(entry.id)).toEqual([]);

    await owner.uploadFile(drive.id, {
      path: 'Docs/C.pdf',
      sourcePath: writeTempFile('it-share-revoked-c.pdf', AFTER_CONTENT),
    });

    // Cold caches, same persisted keys: the recipient that comes back after the revoke.
    const returning = await createInitializedFileManager(recipientClient, recipientStamp);
    const sharedId = returning.sharedWithMe!.id;
    const listMount = async (): Promise<string[]> => {
      try {
        const { entries } = await returning.listFolder(sharedId, 'Docs', ListDepth.Shallow);
        return entries.map((e) => e.path);
      } catch {
        // A re-keyed subtree no longer opens at all, which is the outcome this asserts.
        return [];
      }
    };

    // Give the post-revoke write time to land before concluding it is invisible.
    let paths = await listMount();
    for (let attempt = 0; attempt < 8 && !paths.includes('Docs/C.pdf'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      paths = await listMount();
    }

    expect(paths).not.toContain('Docs/C.pdf');
  });
});
