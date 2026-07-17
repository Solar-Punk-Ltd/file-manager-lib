import {
  Bee,
  BeeRequestOptions,
  DownloadOptions,
  FeedIndex,
  MantarayNode,
  PrivateKey,
  Reference,
  Topic,
} from '@ethersphere/bee-js';

import { FileRecord, ManifestHost, NodeHeader, NodeType } from '../types/info';
import { ActReferences } from '../types/utils';

import { getFeedData } from './bee';
import {
  MANIFEST_METADATA_FILE_TOPIC,
  MANIFEST_METADATA_NODE_ACT_PUBLISHER,
  MANIFEST_METADATA_NODE_OWNER,
  MANIFEST_METADATA_NODE_TOPIC,
  MANIFEST_METADATA_NODE_TYPE,
  MANIFEST_METADATA_NODE_VERSION,
} from './constants';

export async function loadMantaray(
  bee: Bee,
  mantarayRef: string | Reference,
  options?: DownloadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<MantarayNode> {
  const mantaray = await MantarayNode.unmarshal(bee, mantarayRef, options, requestOptions);
  await mantaray.loadRecursively(bee, options, requestOptions);
  return mantaray;
}

export function getAllNodeEntries(root: MantarayNode): NodeHeader[] {
  const nodes = root.collect();

  return nodes
    .map((node): NodeHeader | null => {
      const meta = node.metadata ?? {};
      const nodeType = meta[MANIFEST_METADATA_NODE_TYPE] as NodeType | undefined;
      const nodeTopic = meta[MANIFEST_METADATA_NODE_TOPIC];

      if (!nodeTopic || !nodeType) return null;

      return {
        path: node.fullPathString,
        type: nodeType,
        topic: nodeTopic,
        owner: meta[MANIFEST_METADATA_NODE_OWNER],
        actPublisher: meta[MANIFEST_METADATA_NODE_ACT_PUBLISHER],
        version: meta[MANIFEST_METADATA_NODE_VERSION],
        rawMetadata: { ...meta },
      };
    })
    .filter((e): e is NodeHeader => e !== null);
}

export interface SavedManifest {
  contentRefs: ActReferences;
  newIndex: bigint;
}

export async function saveNodeManifest(
  bee: Bee,
  signer: PrivateKey,
  node: MantarayNode,
  host: ManifestHost,
  index?: bigint,
  requestOptions?: BeeRequestOptions,
): Promise<SavedManifest> {
  const saveResult = await node.saveRecursively(bee, host.batchId, { act: false }, requestOptions);
  const manifestUpload = await bee.uploadData(
    host.batchId,
    saveResult.reference.toUint8Array(),
    { act: true, actHistoryAddress: host.manifestRef?.historyRef, redundancyLevel: host.redundancyLevel },
    requestOptions,
  );
  const newManifestRef: ActReferences = {
    reference: manifestUpload.reference.toString(),
    historyRef: manifestUpload.historyAddress.getOrThrow().toString(),
  };

  let writeIndex = index;
  if (writeIndex === undefined) {
    const { feedIndexNext } = await getFeedData(
      bee,
      new Topic(host.topic),
      signer.publicKey().address().toString(),
      undefined,
      requestOptions,
    );
    writeIndex = feedIndexNext.toBigInt();
  }

  const fw = bee.makeFeedWriter(new Topic(host.topic).toUint8Array(), signer, requestOptions);
  await fw.uploadPayload(host.batchId, JSON.stringify(newManifestRef), { index: FeedIndex.fromBigInt(writeIndex) });

  return { contentRefs: newManifestRef, newIndex: writeIndex + 1n };
}

export function addFileToManifest(mantaray: MantarayNode, filename: string, record: FileRecord): void {
  // Non-confidential fields only — see the fork-metadata INVARIANT in constants.ts.
  mantaray.addFork(filename, new Reference(record.topic), {
    [MANIFEST_METADATA_FILE_TOPIC]: record.topic,
    [MANIFEST_METADATA_NODE_TOPIC]: record.topic,
    [MANIFEST_METADATA_NODE_TYPE]: NodeType.File,
    [MANIFEST_METADATA_NODE_OWNER]: record.owner,
    [MANIFEST_METADATA_NODE_ACT_PUBLISHER]: record.actPublisher,
    ...(record.version !== undefined ? { [MANIFEST_METADATA_NODE_VERSION]: record.version } : {}),
  });
}
