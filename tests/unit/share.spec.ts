import {
  BatchId,
  Bee,
  Bytes,
  FeedIndex,
  Identifier,
  PrivateKey,
  PublicKey,
  Reference,
  Topic,
  type UploadResult,
} from '@ethersphere/bee-js';
import { Optional } from 'cafe-utility';

import { BEE_URL, createInitializedFileManager, makeUploadSource } from '../utils';

import { applyDefaultMocks, createMockFeedReader } from './mock';

import { type FileManagerBase } from '@/fileManager';
import {
  type DriveInfo,
  DriveKind,
  type FolderInfo,
  type GrantBlob,
  NodeType,
  ShareGrade,
  type ShareHandle,
  type ShareOptions,
} from '@/types';
import { DriveError, FileManagerEvents } from '@/utils';
import { getFeedData } from '@/utils/bee';
import {
  FEED_INDEX_ZERO,
  MANIFEST_METADATA_KEY_GEN,
  MANIFEST_METADATA_PARENT_GEN,
  ROOT_PATH,
  SWARM_ZERO_ADDRESS,
} from '@/utils/constants';
import { getAllNodeEntries } from '@/utils/mantaray';

const RECIPIENT_A = new PrivateKey('11'.repeat(32)).publicKey().toCompressedHex();
const RECIPIENT_B = new PrivateKey('44'.repeat(32)).publicKey().toCompressedHex();
const RECIPIENT_C = new PrivateKey('55'.repeat(32)).publicKey().toCompressedHex();

describe('Sharing', () => {
  let fm: FileManagerBase;
  let drive: DriveInfo;
  let folder: FolderInfo;

  // Bee merges grantee lists node-side, so the mock keeps the membership a real list would.
  const granteeLists = new Map<string, string[]>();
  let granteeListSeq = 0;

  const toHexKeys = (keys: unknown): string[] => (keys as string[]).map((k) => new PublicKey(k).toCompressedHex());

  const mockGranteeApi = (): void => {
    const grantee = Object.getPrototypeOf(new Bee(BEE_URL).grantee);

    jest.spyOn(grantee, 'create').mockImplementation(async (...args: unknown[]) => {
      const ref = new Reference((++granteeListSeq).toString(16).padStart(64, '0'));
      granteeLists.set(ref.toString(), toHexKeys(args[1]));

      return { status: 200, statusText: 'OK', ref, historyref: SWARM_ZERO_ADDRESS };
    });

    jest.spyOn(grantee, 'patch').mockImplementation(async (...args: unknown[]) => {
      const ref = new Reference(args[1] as string);
      const { add, revoke } = args[3] as { add?: string[]; revoke?: string[] };
      const members = new Set(granteeLists.get(ref.toString()) ?? []);
      for (const key of toHexKeys(add ?? [])) members.add(key);
      for (const key of toHexKeys(revoke ?? [])) members.delete(key);
      granteeLists.set(ref.toString(), [...members]);

      return { status: 200, statusText: 'OK', ref, historyref: SWARM_ZERO_ADDRESS };
    });

    jest.spyOn(grantee, 'get').mockImplementation(async (...args: unknown[]) => ({
      status: 200,
      statusText: 'OK',
      grantees: (granteeLists.get(new Reference(args[0] as string).toString()) ?? []).map((k) => new PublicKey(k)),
    }));
  };

  const captureBlobUploads = (): string[] => {
    const blobs: string[] = [];
    jest
      .spyOn(Object.getPrototypeOf(new Bee(BEE_URL).data), 'upload')
      .mockImplementation(async (...args: unknown[]) => {
        const data = args[1];
        if (typeof data === 'string' && data.startsWith('{')) {
          blobs.push(data);
        }

        return {
          reference: SWARM_ZERO_ADDRESS,
          historyAddress: Optional.of(SWARM_ZERO_ADDRESS),
        } as unknown as UploadResult;
      });

    return blobs;
  };

  beforeEach(async () => {
    applyDefaultMocks();
    granteeLists.clear();
    granteeListSeq = 0;
    mockGranteeApi();

    fm = await createInitializedFileManager();
    [drive] = await fm.createDrives([{ batchId: new BatchId('4'.repeat(64)), name: 'Test Drive' }]);
    await fm.uploadFile(drive.id, { path: 'notes.txt', ...makeUploadSource('package.json') });
    folder = await fm.createFolder(drive.id, '', 'Docs');
  });

  describe('share', () => {
    it('mints a grant for a folder and emits SHARE_CREATED', async () => {
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.SHARE_CREATED, handler);

      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);

      expect(entry).toMatchObject({
        nodeTopic: folder.topic,
        driveId: drive.id,
        type: NodeType.Folder,
        path: 'Docs',
        grade: ShareGrade.Read,
      });
      expect(entry.revokedAt).toBeUndefined();
      expect(entry.shareTopic).toHaveLength(64);
      expect(entry.publisher).toBeTruthy();
      expect(fm.shareList).toHaveLength(1);
      expect(handler).toHaveBeenCalledWith({ entry: fm.shareList![0] });
    });

    it('adds recipients to the standing grant of the same node and grade', async () => {
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.SHARE_AMENDED, handler);

      const first = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
      const second = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_B]);

      // The handle the first recipients hold has to keep working.
      expect(second.id).toBe(first.id);
      expect(second.shareTopic).toBe(first.shareTopic);
      expect(fm.shareList).toHaveLength(1);
      expect(await fm.getShareGrantees(second.id)).toEqual([RECIPIENT_A, RECIPIENT_B]);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('mints a separate grant for a different grade of the same node', async () => {
      const read = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
      const list = await fm.share(drive.id, 'Docs', ShareGrade.List, [RECIPIENT_A]);

      expect(list.id).not.toBe(read.id);
      expect(list.shareTopic).not.toBe(read.shareTopic);
      expect(fm.shareList).toHaveLength(2);
    });

    it('shares a file as an open grant and refuses any other grade for it', async () => {
      const entry = await fm.share(drive.id, 'notes.txt', ShareGrade.Open, [RECIPIENT_A]);

      expect(entry).toMatchObject({ type: NodeType.File, path: 'notes.txt', grade: ShareGrade.Open });

      await expect(fm.share(drive.id, 'notes.txt', ShareGrade.Read, [RECIPIENT_A])).rejects.toThrow(
        'A file can only be shared as "open"',
      );
    });

    it('refuses an empty recipient list, an open grant of a container and an unknown drive', async () => {
      await expect(fm.share(drive.id, 'Docs', ShareGrade.Read, [])).rejects.toThrow(
        'A share needs at least one recipient',
      );
      await expect(fm.share(drive.id, 'Docs', ShareGrade.Open, [RECIPIENT_A])).rejects.toThrow('shares a single file');

      const ghostDrive = Identifier.fromString('ghost-drive').toString();
      await expect(fm.share(ghostDrive, 'Docs', ShareGrade.Read, [RECIPIENT_A])).rejects.toThrow(
        `Drive with id ${ghostDrive.slice(0, 6)} not found`,
      );
    });

    it('refuses a grant on the drive root, however the path spells it', async () => {
      for (const path of [ROOT_PATH, '', '//']) {
        await expect(fm.share(drive.id, path, ShareGrade.Read, [RECIPIENT_A])).rejects.toThrow('Cannot share a drive');
      }

      expect(fm.shareList).toHaveLength(0);
    });

    it('refuses to share from the admin drive', async () => {
      const admin = fm.driveList.find((d) => d.kind === DriveKind.Admin)!;

      const attempt = fm.share(admin.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
      await expect(attempt).rejects.toThrow(DriveError);
      await expect(attempt).rejects.toThrow('Cannot share from the admin drive');
      expect(fm.shareList).toHaveLength(0);
    });
  });

  describe('getShareGrantees', () => {
    it('returns the members of the grant and throws for an unknown share', async () => {
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A, RECIPIENT_B, RECIPIENT_A]);

      // Duplicates are collapsed before the grant is minted.
      expect(await fm.getShareGrantees(entry.id)).toEqual([RECIPIENT_A, RECIPIENT_B]);

      const ghost = 'f'.repeat(64);
      await expect(fm.getShareGrantees(ghost)).rejects.toThrow(`Share ${ghost.slice(0, 6)} not found`);
    });
  });

  describe('revokeShare', () => {
    it('closes the grant, emits SHARE_REVOKED and lets a later share mint a fresh one', async () => {
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.SHARE_REVOKED, handler);
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A, RECIPIENT_B]);

      const revoked = await fm.revokeShare(entry.id);

      expect(revoked.revokedAt).toEqual(expect.any(Number));
      expect(await fm.getShareGrantees(entry.id)).toEqual([]);
      expect(handler).toHaveBeenCalledWith({ entry: revoked });

      // A revoked entry is never matched again, so the same subject mints a new grant.
      const reshared = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_C]);
      expect(reshared.id).not.toBe(entry.id);
      expect(fm.shareList).toHaveLength(2);
    });

    it('drops only the named recipients and keeps the grant open', async () => {
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A, RECIPIENT_B]);

      const amended = await fm.revokeShare(entry.id, [RECIPIENT_A]);

      expect(amended.revokedAt).toBeUndefined();
      expect(await fm.getShareGrantees(entry.id)).toEqual([RECIPIENT_B]);
      expect(fm.shareList).toHaveLength(1);
    });

    it('closes the grant when a partial revoke removes its last member', async () => {
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);

      const revoked = await fm.revokeShare(entry.id, [RECIPIENT_A]);

      expect(revoked.revokedAt).toEqual(expect.any(Number));
    });

    it('refuses a double revoke and recipients the grant does not include', async () => {
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);

      await expect(fm.revokeShare(entry.id, [RECIPIENT_B])).rejects.toThrow(
        `Share ${entry.id.slice(0, 6)} grants none of the given recipients`,
      );

      await fm.revokeShare(entry.id);
      await expect(fm.revokeShare(entry.id)).rejects.toThrow(`Share ${entry.id.slice(0, 6)} is already revoked`);
    });

    it('leaves the index as persisted when its save fails, so a retry completes the revoke', async () => {
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
      jest.spyOn((fm as any).store, 'saveControlDocument').mockRejectedValueOnce(new Error('batch full'));

      await expect(fm.revokeShare(entry.id)).rejects.toThrow('share index was not saved');
      expect(fm.shareList![0].revokedAt).toBeUndefined();

      const revoked = await fm.revokeShare(entry.id);
      expect(fm.shareList![0].revokedAt).toEqual(revoked.revokedAt);
    });
  });

  describe('key rotation', () => {
    const forkMeta = (hostTopic: string, name: string): Record<string, string> =>
      (fm as any).store.getManifestCache(hostTopic).find(name).metadata;

    it('rotates the shared node on a revoke and leaves everything below it for later', async () => {
      const sub = await fm.createFolder(drive.id, 'Docs', 'Sub');
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);

      await fm.revokeShare(entry.id);

      expect(forkMeta(drive.topic, 'Docs')[MANIFEST_METADATA_KEY_GEN]).toBe('1');
      expect(forkMeta(folder.topic, 'Sub')[MANIFEST_METADATA_KEY_GEN]).toBe('0');
      expect((fm as any).store.keyring.isStale(sub.topic)).toBe(true);
    });

    it('re-issues a partially revoked grant at the new generation, to those still on it', async () => {
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A, RECIPIENT_B]);
      const blobs = captureBlobUploads();

      const amended = await fm.revokeShare(entry.id, [RECIPIENT_A]);

      expect(amended.gen).toBe(1);
      expect(amended.grantees).toEqual([RECIPIENT_B]);
      expect(await fm.getShareGrantees(entry.id)).toEqual([RECIPIENT_B]);
      expect(blobs.map((b) => (JSON.parse(b) as GrantBlob).gen)).toEqual([1]);
    });

    it('rotates a stale node on its first write, and re-issues the grant rooted there', async () => {
      const sub = await fm.createFolder(drive.id, 'Docs', 'Sub');
      const outer = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
      const inner = await fm.share(drive.id, 'Docs/Sub', ShareGrade.Read, [RECIPIENT_B]);
      await fm.revokeShare(outer.id);

      await fm.createFolder(drive.id, 'Docs/Sub', 'Later');

      expect(forkMeta(folder.topic, 'Sub')[MANIFEST_METADATA_KEY_GEN]).toBe('1');
      expect(forkMeta(sub.topic, 'Later')[MANIFEST_METADATA_PARENT_GEN]).toBe('1');
      expect((fm as any).store.keyring.isStale(sub.topic)).toBe(false);
      expect(fm.shareList!.find((e) => e.id === inner.id)!.gen).toBe(1);
    });

    it('rotates a node moved to another folder, so readers of its old place stop following it', async () => {
      await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
      const privateFolder = await fm.createFolder(drive.id, '', 'Private');
      await fm.uploadFile(drive.id, { path: 'Docs/report.txt', ...makeUploadSource('package.json') });

      await fm.move('Docs/report.txt', 'Private/report.txt', drive.id);

      expect(forkMeta(privateFolder.topic, 'report.txt')[MANIFEST_METADATA_KEY_GEN]).toBe('1');
    });

    it('refuses a write to a node that is due a rotation', async () => {
      const sub = await fm.createFolder(drive.id, 'Docs', 'Sub');
      const entry = await fm.share(drive.id, 'Docs', ShareGrade.Read, [RECIPIENT_A]);
      await fm.revokeShare(entry.id);

      const store = (fm as any).store;
      await expect(store.saveMantarayNode(store.getManifestCache(sub.topic), sub)).rejects.toThrow(
        'due a key rotation',
      );
    });
  });

  describe('acceptShare', () => {
    const serveShareFeed = (topic?: string, head?: Uint8Array): void => {
      jest
        .spyOn(Object.getPrototypeOf(new Bee(BEE_URL).feed), 'makeReader')
        .mockImplementation((...args: unknown[]) => ({
          ...createMockFeedReader(),
          downloadPayload: jest.fn(async () => {
            if (!head || new Topic(args[0] as Uint8Array).toString() !== topic) {
              throw Object.assign(new Error('Not Found'), { status: 404 });
            }

            return { payload: new Bytes(head), feedIndex: FEED_INDEX_ZERO, feedIndexNext: FeedIndex.fromBigInt(1n) };
          }),
        }));
    };

    const serveGrantBlob = (json: string): void => {
      jest.spyOn(Object.getPrototypeOf(new Bee(BEE_URL).data), 'download').mockResolvedValue(Bytes.fromUtf8(json));
    };

    /** Publishes a real grant, then wires back what the recipient reads and downloads. */
    const publishFolderGrant = async (
      grade: ShareGrade = ShareGrade.Read,
      options?: ShareOptions,
    ): Promise<{ handle: ShareHandle; blob: GrantBlob }> => {
      const blobs = captureBlobUploads();
      const entry = await fm.share(drive.id, 'Docs', grade, [RECIPIENT_A], options);
      expect(blobs).toHaveLength(1);

      serveGrantBlob(blobs[0]);

      // Whatever `share` published is what comes back, rather than a hand-built head.
      const published = await (getFeedData as jest.Mock)(null, new Topic(entry.shareTopic), drive.owner);
      serveShareFeed(entry.shareTopic, published.payload.toUint8Array());

      (fm as any).store.keyring.drop(folder.topic);

      return { handle: { shareTopic: entry.shareTopic, owner: drive.owner }, blob: JSON.parse(blobs[0]) as GrantBlob };
    };

    it('mounts the granted folder into sharedWithMe and emits SHARE_ACCEPTED', async () => {
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.SHARE_ACCEPTED, handler);
      const { handle } = await publishFolderGrant();

      const mounted = await fm.acceptShare(handle);

      expect(mounted).toMatchObject({
        type: NodeType.Folder,
        topic: folder.topic,
        owner: drive.owner,
        path: 'Docs',
        driveId: fm.sharedWithMe!.id,
      });
      expect(handler).toHaveBeenCalledWith({ driveId: fm.sharedWithMe!.id, entry: mounted });
    });

    it("hands the sharer's message to SHARE_ACCEPTED", async () => {
      const message = 'Q3 numbers, please review';
      const handler = jest.fn();
      fm.emitter.on(FileManagerEvents.SHARE_ACCEPTED, handler);
      const { handle } = await publishFolderGrant(ShareGrade.Read, { message });

      const mounted = await fm.acceptShare(handle);

      expect(handler).toHaveBeenCalledWith({ driveId: fm.sharedWithMe!.id, entry: mounted, message });
    });

    it('mounts a list grant, which carries no content key', async () => {
      const { handle } = await publishFolderGrant(ShareGrade.List);

      const mounted = await fm.acceptShare(handle);

      expect(mounted).toMatchObject({ type: NodeType.Folder, topic: folder.topic, path: 'Docs' });

      const keys = await (fm as any).store.keyring.requireKeys(folder.topic);
      expect(keys.meta).toEqual(expect.any(Uint8Array));
      expect(keys.content).toBeUndefined();
    });

    it('writes no fork when the granted node cannot be resolved', async () => {
      const { handle } = await publishFolderGrant();
      const store = (fm as any).store;
      const resolveOther = store.resolveManifestRef.bind(store);

      const resolve = jest
        .spyOn(store, 'resolveManifestRef')
        .mockImplementation((topic: unknown, ...rest: unknown[]) =>
          topic === folder.topic
            ? Promise.reject(new Error('Manifest feed not found for mount'))
            : resolveOther(topic, ...rest),
        );
      const save = jest.spyOn(store, 'saveMantarayNode');

      await expect(fm.acceptShare(handle)).rejects.toThrow('Manifest feed not found');

      expect(save).not.toHaveBeenCalled();

      resolve.mockRestore();
      const mounted = await fm.acceptShare(handle);
      expect(mounted).toMatchObject({ type: NodeType.Folder, topic: folder.topic, path: 'Docs' });
      expect(save).toHaveBeenCalled();
    });

    it('refuses to mount the same node twice', async () => {
      const { handle } = await publishFolderGrant();

      (getAllNodeEntries as jest.Mock).mockReturnValue([
        { path: 'Docs', type: NodeType.Folder, topic: folder.topic, rawMetadata: {} },
      ]);

      await expect(fm.acceptShare(handle)).rejects.toThrow(/already mounted at Docs/);
    });

    it('refuses a blob claiming a drive, which no grade can accept', async () => {
      const { handle, blob } = await publishFolderGrant();

      // The blob is someone else's bytes: the grade is re-checked against the type it claims.
      serveGrantBlob(JSON.stringify({ ...blob, type: NodeType.Drive }));

      await expect(fm.acceptShare(handle)).rejects.toThrow('A drive node cannot be shared');
    });

    it('throws when the share feed has no head', async () => {
      serveShareFeed();

      await expect(
        fm.acceptShare({ shareTopic: Topic.fromString('never-published').toString(), owner: drive.owner }),
      ).rejects.toThrow('Share feed has no head');
    });
  });
});
