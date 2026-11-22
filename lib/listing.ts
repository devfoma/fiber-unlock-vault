import type { Hex } from './crypto.ts';

/** Public, unencrypted description of what the buyer is paying for. */
export type Listing = {
  title: string;
  preview: string;
  kind: 'text' | 'file';
  fileName: string;
  mimeType: string;
  /** Plaintext size in bytes. */
  size: number;
  /** Invoice amount in shannons (1 CKB = 100,000,000 shannons). */
  priceShannons: Hex;
};

export const APP_ID = 'fiber-unlock-vault';
export const MIN_PRICE_CKB = 1;
export const MAX_PRICE_CKB = 10;
/** Keeps the offer JSON comfortably inside sessionStorage and clipboard limits. */
export const MAX_CONTENT_BYTES = 512 * 1024;
/** Maximum routing fee the buyer accepts, 1 CKB. */
export const MAX_FEE_SHANNONS: Hex = '0x5f5e100';

const SHANNONS_PER_CKB = 100_000_000n;

export const ckbToShannonsHex = (ckb: number) => `0x${(BigInt(ckb) * SHANNONS_PER_CKB).toString(16)}` as Hex;

export function formatCkb(shannons: string | bigint) {
  const value = typeof shannons === 'bigint' ? shannons : BigInt(shannons);
  const whole = value / SHANNONS_PER_CKB;
  const fraction = (value % SHANNONS_PER_CKB).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function text(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new Error(`${label} must be ${min}-${max} characters.`);
  }
  return trimmed;
}

export function safeFileName(value: string) {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'unlocked.bin').slice(0, 120);
}

export function normalizeListing(value: unknown): Listing {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Listing is missing.');
  const listing = value as Record<string, unknown>;
  if (listing.kind !== 'text' && listing.kind !== 'file') throw new Error('Listing kind must be text or file.');
  const fileName = text(listing.fileName, 'File name', 1, 120);
  if (safeFileName(fileName) !== fileName) throw new Error('File name contains unsafe characters.');
  const mimeType = text(listing.mimeType, 'MIME type', 3, 100);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)) throw new Error('MIME type is malformed.');
  const size = listing.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_CONTENT_BYTES) {
    throw new Error(`Content size must be between 1 byte and ${formatBytes(MAX_CONTENT_BYTES)}.`);
  }
  if (typeof listing.priceShannons !== 'string' || !/^0x[0-9a-f]+$/i.test(listing.priceShannons)) {
    throw new Error('Listing price is malformed.');
  }
  const price = BigInt(listing.priceShannons);
  if (price % SHANNONS_PER_CKB !== 0n
    || price < BigInt(MIN_PRICE_CKB) * SHANNONS_PER_CKB || price > BigInt(MAX_PRICE_CKB) * SHANNONS_PER_CKB) {
    throw new Error(`Listing price must be a whole number of CKB from ${MIN_PRICE_CKB} to ${MAX_PRICE_CKB}.`);
  }
  return {
    title: text(listing.title, 'Title', 1, 80),
    preview: typeof listing.preview === 'string' ? text(listing.preview, 'Preview', 0, 600) : '',
    kind: listing.kind,
    fileName,
    mimeType,
    size,
    priceShannons: `0x${price.toString(16)}`,
  };
}

/**
 * AES-GCM additional data. Field order is fixed so seller and buyer derive the
 * exact same bytes; the payment hash ties the ciphertext to one invoice.
 */
export function listingAad(listing: Listing, paymentHash: string) {
  return new TextEncoder().encode(JSON.stringify([
    `${APP_ID}/v3`, listing.title, listing.preview, listing.kind, listing.fileName,
    listing.mimeType, listing.size, listing.priceShannons.toLowerCase(), paymentHash.toLowerCase(),
  ]));
}

/** The seller-signed invoice description the buyer checks against the listing. */
export function invoiceDescription(listing: Listing) {
  return `Unlock: ${listing.title}`.slice(0, 64);
}
