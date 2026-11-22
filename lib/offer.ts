import { bottle } from './bottle.ts';
import type { Channel, FiberBrowserNode } from '@fiber-pay/sdk/browser';
import { encryptBytes, fromBase64, generateUnlockKey, type EncryptedPayload, type Hex } from './crypto.ts';
import { APP_ID, invoiceDescription, listingAad, normalizeListing, type Listing } from './listing.ts';

/**
 * Version 3 offer (starter used version 2). Adds a public listing that is
 * cryptographically bound to the ciphertext, a seller-chosen price, file
 * support and base64 ciphertext for compact transfer.
 */
export type EncryptedOffer = EncryptedPayload & {
  version: 3;
  app: typeof APP_ID;
  cipher: 'AES-256-GCM';
  listing: Listing;
  invoice: string;
  paymentHash: Hex;
  lastHop: {
    pubkey: Hex;
    channel_outpoint: Hex;
    fee_rate: Hex;
    tlc_expiry_delta: Hex;
  };
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHexBytes(value: unknown, label: string, bytes?: number) {
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const body = value.trim().replace(/^0x/i, '');
  if (!body || body.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(body)) {
    throw new Error(`${label} must be hexadecimal bytes.`);
  }
  if (bytes !== undefined && body.length !== bytes * 2) {
    throw new Error(`${label} must be ${bytes} bytes.`);
  }
  return `0x${body.toLowerCase()}` as Hex;
}

function normalizeHexQuantity(value: unknown, label: string) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return `0x${value.toString(16)}` as Hex;
  }
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const normalized = value.trim();
  if (/^0x[0-9a-f]+$/i.test(normalized) || /^\d+$/.test(normalized)) {
    return `0x${BigInt(normalized).toString(16)}` as Hex;
  }
  throw new Error(`${label} must be a non-negative integer.`);
}

function packOutpoint(txHash: Hex, index: Hex) {
  const indexValue = BigInt(index);
  if (indexValue > 0xffff_ffffn) throw new Error('Last-hop output index exceeds u32.');
  const indexBytes = indexValue.toString(16).padStart(8, '0').match(/../g)?.reverse().join('');
  return `0x${txHash.slice(2)}${indexBytes}` as Hex;
}

function normalizeOutpoint(value: unknown): Hex {
  if (isJsonObject(value)) {
    return packOutpoint(
      normalizeHexBytes(value.tx_hash ?? value.txHash, 'Last-hop transaction hash', 32),
      normalizeHexQuantity(value.index, 'Last-hop output index'),
    );
  }
  if (typeof value === 'string' && /^0x[0-9a-f]{72}$/i.test(value.trim())) {
    return value.trim().toLowerCase() as Hex;
  }
  throw new Error('Last-hop channel outpoint is missing or malformed.');
}

function normalizeLastHop(value: unknown): EncryptedOffer['lastHop'] {
  if (!isJsonObject(value)) throw new Error('Last-hop hint is missing.');
  if (normalizeHexBytes(value.pubkey, 'Last-hop public key', 33) !== bottle.pubkey) throw new Error('Last-hop hint must identify Bottle.');
  return {
    pubkey: normalizeHexBytes(value.pubkey, 'Last-hop public key', 33),
    channel_outpoint: normalizeOutpoint(value.channel_outpoint ?? value.channelOutpoint),
    fee_rate: normalizeHexQuantity(value.fee_rate ?? value.feeRate, 'Last-hop fee rate'),
    tlc_expiry_delta: normalizeHexQuantity(value.tlc_expiry_delta ?? value.tlcExpiryDelta, 'Last-hop expiry delta'),
  };
}

export type OfferInput = Omit<Listing, 'size'> & { content: Uint8Array };

export async function createOffer(seller: Pick<FiberBrowserNode, 'newInvoice'>, sellerChannel: Channel, input: OfferInput) {
  if (!sellerChannel.channel_outpoint) throw new Error('Seller channel does not have a confirmed outpoint.');
  const { content, ...meta } = input;
  const listing = normalizeListing({ ...meta, size: content.length });
  // The key exists before the invoice, so the payment hash can be bound into the ciphertext.
  const { key, paymentHash } = await generateUnlockKey();
  const encrypted = await encryptBytes(content, key, listingAad(listing, paymentHash));
  const invoice = await seller.newInvoice({
    amount: listing.priceShannons,
    currency: 'Fibt',
    payment_preimage: key,
    hash_algorithm: 'sha256',
    allow_trampoline_routing: true,
    description: invoiceDescription(listing),
    expiry: '0xe10', // 1 hour
  });
  if (invoice.invoice.data.payment_hash.toLowerCase() !== paymentHash) {
    throw new Error('The node created an invoice for a different payment hash. Offer discarded.');
  }
  const offer: EncryptedOffer = {
    version: 3,
    app: APP_ID,
    cipher: 'AES-256-GCM',
    listing,
    ...encrypted,
    invoice: invoice.invoice_address,
    paymentHash,
    lastHop: {
      pubkey: sellerChannel.pubkey as Hex,
      channel_outpoint: normalizeOutpoint(sellerChannel.channel_outpoint),
      fee_rate: normalizeHexQuantity(sellerChannel.tlc_fee_proportional_millionths, 'Last-hop fee rate'),
      tlc_expiry_delta: normalizeHexQuantity(sellerChannel.tlc_expiry_delta, 'Last-hop expiry delta'),
    },
  };
  return JSON.stringify(offer, null, 2);
}

export function parseOffer(value: string): EncryptedOffer {
  let offer: unknown;
  try { offer = JSON.parse(value); } catch { throw new Error('Offer is not valid JSON.'); }
  if (!isJsonObject(offer) || offer.version !== 3 || offer.app !== APP_ID || offer.cipher !== 'AES-256-GCM') {
    throw new Error('This is not a Fiber Unlock Vault v3 offer.');
  }
  if (typeof offer.invoice !== 'string' || !offer.invoice.toLowerCase().startsWith('fibt')) {
    throw new Error('Offer is missing a Fiber Testnet invoice.');
  }
  const listing = normalizeListing(offer.listing);
  if (typeof offer.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(offer.ciphertext)) {
    throw new Error('Ciphertext must be base64.');
  }
  // AES-GCM output is plaintext length plus a 16-byte tag.
  if (fromBase64(offer.ciphertext).length !== listing.size + 16) {
    throw new Error('Ciphertext length does not match the listed content size.');
  }
  return {
    version: 3,
    app: APP_ID,
    cipher: 'AES-256-GCM',
    listing,
    ciphertext: offer.ciphertext,
    iv: normalizeHexBytes(offer.iv, 'AES-GCM IV', 12),
    invoice: offer.invoice,
    paymentHash: normalizeHexBytes(offer.paymentHash, 'Invoice payment hash', 32),
    lastHop: normalizeLastHop(offer.lastHop),
  };
}
