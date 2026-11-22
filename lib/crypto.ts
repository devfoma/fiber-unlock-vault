/**
 * Browser/Node WebCrypto helpers for Fiber Unlock Vault.
 *
 * The 32-byte AES-256-GCM key doubles as the Fiber invoice preimage, so
 * payment_hash = SHA-256(key). Settling the invoice is what reveals the key.
 * Every ciphertext is also bound (as AES-GCM additional data) to the public
 * listing and to that payment hash, so a tampered title, preview, price or a
 * swapped invoice makes decryption fail instead of silently succeeding.
 */
export type Hex = `0x${string}`;

export type EncryptedPayload = {
  /** Base64 ciphertext including the 16-byte GCM tag. */
  ciphertext: string;
  iv: Hex;
};

export const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}` as Hex;

export const fromHex = (value: string) =>
  Uint8Array.from(value.replace(/^0x/, '').match(/.{2}/g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );

export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256Hex(bytes: Uint8Array) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

/** A fresh AES key and the Fiber payment hash that commits to it. */
export async function generateUnlockKey() {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  return { key: toHex(keyBytes), paymentHash: await sha256Hex(keyBytes) };
}

/** True when a revealed preimage is exactly the key the invoice committed to. */
export async function preimageMatches(preimage: string, paymentHash: string) {
  if (!/^0x[0-9a-f]{64}$/i.test(preimage)) return false;
  return (await sha256Hex(fromHex(preimage))).toLowerCase() === paymentHash.toLowerCase();
}

async function importKey(keyHex: string, usage: 'encrypt' | 'decrypt') {
  return crypto.subtle.importKey('raw', new Uint8Array(fromHex(keyHex)), { name: 'AES-GCM' }, false, [usage]);
}

export async function encryptBytes(plaintext: Uint8Array, keyHex: Hex, aad: Uint8Array): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new Uint8Array(aad) },
    await importKey(keyHex, 'encrypt'),
    new Uint8Array(plaintext),
  );
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toHex(iv) };
}

export async function decryptBytes(payload: EncryptedPayload, keyHex: string, aad: Uint8Array) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromHex(payload.iv)), additionalData: new Uint8Array(aad) },
    await importKey(keyHex, 'decrypt'),
    new Uint8Array(fromBase64(payload.ciphertext)),
  );
  return new Uint8Array(plaintext);
}
