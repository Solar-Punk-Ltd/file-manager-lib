import { Bytes } from '@ethersphere/core-sdk';

import type { NodeKeys } from '../types/crypto';
import type { Hex } from '../types/utils';

const HKDF_ALG = 'HKDF';
const AES_ALG = 'AES-GCM';
const HASH_ALG = 'SHA-256';
const AES_KEY_BITS = 256;

// AES-GCM nonce length in bytes. Every ciphertext this module produces is `iv || ciphertext`.
export const GCM_IV_LENGTH = 12;
// Length of a derived secret, in bytes — matches a `Topic` and an AES-256 key.
export const DERIVED_SECRET_LENGTH = 32;

export function generateRandomBytes(len: number): Bytes {
  const arr = new Uint8Array(len);
  globalThis.crypto.getRandomValues(arr);
  return new Bytes(arr);
}

/**
 * Overwrite a buffer that held key material.
 *
 * Best effort only — JavaScript engines may have copied it — but it shortens the window in which a
 * heap snapshot yields a usable key, and it makes the intent explicit at the call site.
 */
export function zeroBytes(buf: Uint8Array): void {
  buf.fill(0);
}

// Narrow a `Uint8Array` to the `ArrayBuffer`-backed form WebCrypto accepts.
function asBufferSource(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data);
}

// UTF-8 `info` for HKDF, in the form WebCrypto accepts.
function infoBytes(info: string): Uint8Array<ArrayBuffer> {
  return asBufferSource(Bytes.fromUtf8(info).toUint8Array());
}

/**
 * Import raw secret bytes as an HKDF base key.
 *
 * WebCrypto requires HKDF keys to be **non-extractable**, which is exactly the property we want:
 * everything derived from this key can be used but never read back out of JavaScript. The raw
 * buffer passed in is the only place the secret exists as bytes — {@link zeroBytes} it once this
 * resolves.
 */
export async function importDerivationKey(secret: Uint8Array): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.importKey('raw', asBufferSource(secret), HKDF_ALG, false, [
    'deriveKey',
    'deriveBits',
  ]);
}

/**
 * HKDF from a base key to a non-extractable AES-GCM key.
 *
 * Non-extractable means a compromised page can *use* the key while the session is live but cannot
 * exfiltrate it. Keys that must leave the process — a share blob's payload — have to be produced
 * some other way, deliberately.
 */
export async function deriveAesKey(base: CryptoKey, info: string, salt: Uint8Array): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.deriveKey(
    { name: HKDF_ALG, hash: HASH_ALG, salt: asBufferSource(salt), info: infoBytes(info) },
    base,
    { name: AES_ALG, length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * HKDF from a base key to raw bits.
 *
 * For values that are public by design (feed topics, key ids) and for the root node keys, which
 * have to be raw because every other node key is: a child's keys are wrapped into its parent's
 * manifest and handed to grantees, so they cannot be non-extractable. Prefer {@link deriveAesKey}
 * wherever the result never has to leave the process.
 */
export async function deriveBits(
  base: CryptoKey,
  info: string,
  salt: Uint8Array,
  length: number = DERIVED_SECRET_LENGTH,
): Promise<Uint8Array> {
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: HKDF_ALG, hash: HASH_ALG, salt: asBufferSource(salt), info: infoBytes(info) },
    base,
    length * 8,
  );

  return new Uint8Array(bits);
}

// AES-256-GCM. Returns `iv || ciphertext`; the GCM tag is part of the ciphertext.
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = asBufferSource(generateRandomBytes(GCM_IV_LENGTH).toUint8Array());
  const ciphertext = await globalThis.crypto.subtle.encrypt({ name: AES_ALG, iv }, key, asBufferSource(plaintext));

  const sealed = new Uint8Array(iv.length + ciphertext.byteLength);
  sealed.set(iv, 0);
  sealed.set(new Uint8Array(ciphertext), iv.length);

  return sealed;
}

/**
 * Inverse of {@link encryptBytes}.
 *
 * **Throws on a wrong key.** GCM authenticates, so a failed decrypt means the key is wrong or the
 * ciphertext was tampered with — the two are indistinguishable and both are fatal. Callers should
 * translate this into a domain error rather than treating it as a missing value.
 */
export async function decryptBytes(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length <= GCM_IV_LENGTH) {
    throw new Error(`Ciphertext too short: ${sealed.length} bytes`);
  }

  const iv = asBufferSource(sealed.subarray(0, GCM_IV_LENGTH));
  const ciphertext = asBufferSource(sealed.subarray(GCM_IV_LENGTH));
  const plaintext = await globalThis.crypto.subtle.decrypt({ name: AES_ALG, iv }, key, ciphertext);

  return new Uint8Array(plaintext);
}

/** Import raw AES-256 key bytes. Non-extractable, so the imported handle cannot leak the value back. */
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== DERIVED_SECRET_LENGTH) {
    throw new Error(`AES key must be ${DERIVED_SECRET_LENGTH} bytes, got ${raw.length}`);
  }

  return await globalThis.crypto.subtle.importKey('raw', asBufferSource(raw), AES_ALG, false, ['encrypt', 'decrypt']);
}

/** {@link encryptBytes} under a raw key. Every index write in the library goes through here. */
export async function sealWithKey(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  return await encryptBytes(await importAesKey(key), plaintext);
}

/** Inverse of {@link sealWithKey}. Throws on a wrong key — GCM authenticates. */
export async function openWithKey(key: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  return await decryptBytes(await importAesKey(key), sealed);
}

export function generateNodeKeys(): NodeKeys {
  return {
    meta: generateRandomBytes(DERIVED_SECRET_LENGTH).toUint8Array(),
    content: generateRandomBytes(DERIVED_SECRET_LENGTH).toUint8Array(),
  };
}

export async function wrapKey(kek: Uint8Array, key: Uint8Array): Promise<Hex> {
  return new Bytes(await sealWithKey(kek, key)).toString();
}

export async function unwrapKey(kek: Uint8Array, wrapped: Hex): Promise<Uint8Array> {
  return await openWithKey(kek, new Bytes(wrapped).toUint8Array());
}
