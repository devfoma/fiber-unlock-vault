import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBytes, fromHex, preimageMatches, sha256Hex, toHex } from './lib/crypto.ts';
import { ckbToShannonsHex, invoiceDescription, listingAad, normalizeListing } from './lib/listing.ts';
import { createOffer, parseOffer } from './lib/offer.ts';
import { validateOffer } from './lib/payment.ts';

const bottlePubkey = '0x02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71';
const channel = {
  pubkey: bottlePubkey,
  channel_outpoint: `0x${'11'.repeat(32)}00000000`,
  tlc_fee_proportional_millionths: '0x3e8',
  tlc_expiry_delta: '0x5265c00',
};

/** A fake seller node that behaves like Fiber: payment_hash = SHA-256(preimage). */
function fakeSeller() {
  const invoices = [];
  return {
    invoices,
    async newInvoice(params) {
      const payment_hash = await sha256Hex(fromHex(params.payment_preimage));
      const invoice = { currency: params.currency, amount: params.amount,
        data: { payment_hash, timestamp: `0x${Date.now().toString(16)}`, attrs: [{ description: params.description }, { expiry_time: params.expiry }] } };
      invoices.push({ params, invoice });
      return { invoice_address: `fibt${invoices.length}example`, invoice };
    },
  };
}

const listingInput = (content, overrides = {}) => ({
  title: 'Q4 CKB liquidity brief', preview: 'Free preview: three charts and one surprise.',
  kind: 'file', fileName: 'brief.pdf', mimeType: 'application/pdf', priceShannons: ckbToShannonsHex(3), content, ...overrides,
});

async function makeOffer(content = new TextEncoder().encode('the full paid report'), overrides) {
  const seller = fakeSeller();
  const json = await createOffer(seller, channel, listingInput(content, overrides));
  return { seller, json, offer: parseOffer(json), key: seller.invoices[0].params.payment_preimage };
}

test('offer round-trips: the invoice preimage decrypts the listed file byte-for-byte', async () => {
  const content = crypto.getRandomValues(new Uint8Array(4096));
  const { offer, key, seller } = await makeOffer(content);
  assert.equal(seller.invoices[0].params.amount, '0x11e1a300'); // 3 CKB
  assert.equal(seller.invoices[0].params.hash_algorithm, 'sha256');
  assert.ok(await preimageMatches(key, offer.paymentHash));
  const plain = await decryptBytes(offer, key, listingAad(offer.listing, offer.paymentHash));
  assert.deepEqual(plain, content);
});

test('the offer never contains the key', async () => {
  const { json, key } = await makeOffer();
  assert.ok(!json.toLowerCase().includes(key.slice(2).toLowerCase()));
});

test('a random key is rejected before payment', async () => {
  const { offer } = await makeOffer();
  const wrong = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await assert.rejects(decryptBytes(offer, wrong, listingAad(offer.listing, offer.paymentHash)));
  assert.equal(await preimageMatches(wrong, offer.paymentHash), false);
});

test('tampering with the public listing breaks decryption even with the real key', async () => {
  const { offer, key } = await makeOffer();
  for (const change of [{ title: 'Something better' }, { preview: 'Edited preview' }, { priceShannons: ckbToShannonsHex(1) }, { fileName: 'other.pdf' }]) {
    const tampered = { ...offer.listing, ...change };
    await assert.rejects(decryptBytes(offer, key, listingAad(tampered, offer.paymentHash)));
  }
  // Swapping in a different invoice's payment hash is also rejected.
  await assert.rejects(decryptBytes(offer, key, listingAad(offer.listing, `0x${'00'.repeat(32)}`)));
});

test('buyer validation enforces listed price and description', async () => {
  const { offer, seller } = await makeOffer();
  const node = { parseInvoice: async () => ({ invoice: seller.invoices[0].invoice }) };
  await validateOffer(node, offer);
  const cheaper = { ...offer, listing: { ...offer.listing, priceShannons: ckbToShannonsHex(1) } };
  await assert.rejects(validateOffer(node, cheaper), /does not match/);
  const renamed = { ...offer, listing: { ...offer.listing, title: 'Different' } };
  await assert.rejects(validateOffer(node, renamed), /does not match/);
  assert.equal(invoiceDescription(offer.listing), 'Unlock: Q4 CKB liquidity brief');
});

test('parseOffer rejects malformed or out-of-policy offers', async () => {
  const { json } = await makeOffer();
  const base = JSON.parse(json);
  const bad = [
    { ...base, version: 2 },
    { ...base, invoice: 'fibb-mainnet' },
    { ...base, ciphertext: base.ciphertext.slice(8) },
    { ...base, listing: { ...base.listing, size: base.listing.size + 1 } },
    { ...base, lastHop: { ...base.lastHop, pubkey: `0x03${'22'.repeat(32)}` } },
  ];
  for (const value of bad) assert.throws(() => parseOffer(JSON.stringify(value)));
  assert.throws(() => parseOffer('not json'), /valid JSON/);
});

test('listing policy: price 1-10 whole CKB, safe file names, size limit', () => {
  const ok = { title: 'T', preview: '', kind: 'text', fileName: 'a.md', mimeType: 'text/markdown', size: 1, priceShannons: ckbToShannonsHex(1) };
  assert.equal(normalizeListing(ok).priceShannons, '0x5f5e100');
  assert.throws(() => normalizeListing({ ...ok, priceShannons: ckbToShannonsHex(11) }));
  assert.throws(() => normalizeListing({ ...ok, priceShannons: '0x1' }));
  assert.throws(() => normalizeListing({ ...ok, fileName: '../evil.sh' }));
  assert.throws(() => normalizeListing({ ...ok, size: 600 * 1024 }));
  assert.throws(() => normalizeListing({ ...ok, title: '' }));
});
