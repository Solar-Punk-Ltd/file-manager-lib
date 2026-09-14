import { type BatchId, Identifier, PrivateKey, Topic } from '@ethersphere/bee-js';

import { createInitializedFileManager, retryOnPropagationDelay, streamToUint8Array } from '../utils';

import { ensureUniqueSignerWithStamp, setupUserDrive, tempFileRegistry } from './setup/utils';

import { type BeeClient } from '@/clients';
import { type FileManagerBase } from '@/fileManager';
import {
  type DriveInfo,
  type FileRecord,
  ListDepth,
  type NodeEntry,
  NodeType,
  type ShareEntry,
  ShareGrade,
  type ShareHandle,
} from '@/types';
import { FileManagerEvents } from '@/utils';
import { getFeedData, openGrantBlob, readShareHead } from '@/utils/bee';
import { FEED_INDEX_NONE, ROOT_PATH } from '@/utils/constants';

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

  it('mints a grant for the drive root, emits SHARE_CREATED and lists its grantees', async () => {
    const handler = jest.fn();
    fileManager.emitter.on(FileManagerEvents.SHARE_CREATED, handler);

    try {
      const entry = await fileManager.share(drive.id, ROOT_PATH, ShareGrade.Read, [RECIPIENT_A]);

      expect(entry).toMatchObject({
        nodeTopic: drive.topic,
        driveId: drive.id,
        type: NodeType.Drive,
        path: ROOT_PATH,
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
      grade: ShareGrade.Read,
    });
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
    await expect(fileManager.share(drive.id, ROOT_PATH, ShareGrade.Read, [])).rejects.toThrow(
      'A share needs at least one recipient',
    );
    await expect(fileManager.share(drive.id, ROOT_PATH, ShareGrade.Open, [RECIPIENT_A])).rejects.toThrow(
      'shares a single file',
    );

    const ghostDrive = Identifier.fromString('ghost-drive').toString();
    await expect(fileManager.share(ghostDrive, ROOT_PATH, ShareGrade.Read, [RECIPIENT_A])).rejects.toThrow(
      `Drive with id ${ghostDrive.slice(0, 6)} not found`,
    );
  });

  it('a fresh instance loads the published share index', async () => {
    await fileManager.createFolder(drive.id, ROOT_PATH, 'persisted');
    const entry = await fileManager.share(drive.id, 'persisted', ShareGrade.List, [RECIPIENT_C]);

    const fresh = await retryOnPropagationDelay(async () => {
      const fm = await createInitializedFileManager(client, ownerStamp);
      if (!fm.shareList?.some((e) => e.id === entry.id)) {
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
  let recipientClient: BeeClient;
  let folderHandle: ShareHandle;
  let fileHandle: ShareHandle;
  let folderTopic: string;
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

    // The two identities share one Bee node, so ACT decryption succeeds for the publisher itself;
    // what this exercises is the grant blob, the share feed and the mount, not Bee's gating.
    const { client, ownerStamp } = await ensureUniqueSignerWithStamp();
    recipientClient = client;
    recipient = await createInitializedFileManager(client, ownerStamp);

    const folderEntry = await owner.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
    const fileEntry = await owner.share(drive.id, 'solo.txt', ShareGrade.Open, [RECIPIENT_A]);
    folderHandle = { shareTopic: folderEntry.shareTopic, owner: drive.owner };
    fileHandle = { shareTopic: fileEntry.shareTopic, owner: drive.owner };
  });

  afterAll(cleanup);

  /**
   * `acceptShare` mounts before it resolves the granted node, so a retry around it would hit
   * "already mounted" instead of the propagation delay. Warm every read it depends on first.
   */
  const acceptWhenReadable = async (handle: ShareHandle): Promise<NodeEntry> => {
    await retryOnPropagationDelay(async () => {
      const head = await readShareHead(recipientClient, handle);
      const blob = await openGrantBlob(recipientClient, head);
      const { feedIndex } = await getFeedData(recipientClient, new Topic(blob.topic), blob.owner);
      if (feedIndex.equals(FEED_INDEX_NONE)) {
        throw new Error('granted node feed not yet propagated');
      }
    });

    return await recipient.acceptShare(handle);
  };

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

  it('refuses to mount the same node twice', async () => {
    await expect(recipient.acceptShare(folderHandle)).rejects.toThrow(/already mounted at Docs/);
  });

  it('throws when the share feed has no head', async () => {
    await expect(
      recipient.acceptShare({ shareTopic: Topic.fromString('never-published').toString(), owner: drive.owner }),
    ).rejects.toThrow('Share feed has no head');
  });
});
