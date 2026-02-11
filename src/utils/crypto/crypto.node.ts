import { Bytes } from '@ethersphere/bee-js';

export async function getRandomBytesNode(len: number): Promise<Bytes> {
  const { randomBytes } = await import('crypto');
  return new Bytes(randomBytes(len));
}
