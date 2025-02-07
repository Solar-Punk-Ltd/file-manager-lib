import { BatchId } from '@upcoming/bee-js';

export const mockBatchId = new BatchId('ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51');

export const fileInfoTxt = `[
  {
    "batchId": "ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51",
    "eFileRef": "src/folder/1.txt"
  },
  {
    "batchId": "ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51",
    "eFileRef": "src/folder/2.txt"
  }
]`;

export const extendedFileInfoTxt = `[{"batchId":"ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51","eFileRef":"src/folder/1.txt"},{"batchId":"ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51","eFileRef":"src/folder/2.txt"},{"batchId":"ee0fec26fdd55a1b8a777cc8c84277a1b16a7da318413fbd4cc4634dd93a2c51","eFileRef":"src/folder/3.txt"}]`;

export const emptyFileInfoTxt = `[]`;
