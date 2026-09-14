import {
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
import { type DriveInfo, type FolderInfo, type GrantBlob, NodeType, ShareGrade, type ShareHandle } from '@/types';
import { FileManagerEvents } from '@/utils';
import { getFeedData } from '@/utils/bee';
import { FEED_INDEX_ZERO, ROOT_PATH, SWARM_ZERO_ADDRESS } from '@/utils/constants';
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
    drive = fm.driveList[0];
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
    ): Promise<{ handle: ShareHandle; blob: GrantBlob }> => {
      const blobs = captureBlobUploads();
      const entry = await fm.share(drive.id, 'Docs', grade, [RECIPIENT_A]);
      expect(blobs).toHaveLength(1);

      serveGrantBlob(blobs[0]);

      // Whatever `share` published is what comes back, rather than a hand-built head.
      const published = await (getFeedData as jest.Mock)(null, new Topic(entry.shareTopic), drive.owner);
      serveShareFeed(entry.shareTopic, published.payload.toUint8Array());

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

    it('mounts a list grant, which carries no content key', async () => {
      const { handle } = await publishFolderGrant(ShareGrade.List);

      const mounted = await fm.acceptShare(handle);

      expect(mounted).toMatchObject({ type: NodeType.Folder, topic: folder.topic, path: 'Docs' });

      const keys = await (fm as any).store.keyring.requireKeys(folder.topic);
      expect(keys.meta).toEqual(expect.any(Uint8Array));
      expect(keys.content).toBeUndefined();
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
