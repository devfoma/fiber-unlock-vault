# Fiber Unlock Vault

Pay-to-unlock **files and research briefs** on Fiber (CKB Testnet). A seller lists something with a public title and a **free preview**, picks a price, and shares an encrypted offer. The buyer pays the Fiber invoice through Bottle. Settling the payment reveals the invoice preimage, and **that preimage is the AES-256-GCM key** that decrypts the content in the buyer's browser.

Built on the official [Fiber encrypted-data-payment starter](https://www.fiber.world/docs/build/encrypted-data-payment). The first commit in this repo is the unmodified starter, so `git diff HEAD~1` (or the commit history) shows exactly what changed.

## Use case

A researcher sells a short paid brief or a file (PDF, image, dataset, markdown) to one buyer:

1. **Seller** writes a title and free preview, adds paid text **or uploads a file** (up to 512 KB), and picks a price from 1 to 10 CKB.
2. The app encrypts the content in the browser and creates a Fiber invoice whose preimage is the encryption key.
3. The seller hands over the **public offer** (copy/paste, download a `.json` file, or one-click "Hand to buyer" for demos). It contains the ciphertext and invoice, never the key.
4. **Buyer** loads the offer and sees the listing card (title, preview, price, file name/size), confirms that decryption without the key is rejected, and pays.
5. The receipt shows the amount, routing fee, payment hash, and a **key proof**: `SHA-256(revealed preimage) == payment hash`.
6. The buyer unlocks the content. Text is shown inline, images are previewed, and any file can be downloaded with its original name.

## What changed from the starter

| Area | Starter | Fiber Unlock Vault |
|---|---|---|
| Content | Fixed text sample | Paid text **or any file** up to 512 KB, with download after unlock |
| Price | Fixed 1 CKB | Seller picks **1-10 CKB**. The buyer checks the invoice amount against the listing |
| Public metadata | None | **Listing**: title, free preview, file name, MIME type, size, price |
| Tamper resistance | Ciphertext only | Listing + payment hash bound as **AES-GCM additional data**. Editing the preview, title, price or file name, or swapping in another invoice's hash, makes decryption fail even with the real key |
| Invoice check | Network, 1 CKB, payment hash | Also checks the listed price and the **seller-signed invoice description** (`Unlock: <title>`) |
| Key handling | Key generated during encryption | Key and `payment_hash = SHA-256(key)` generated first, so the hash can be bound into the ciphertext. The app aborts if the node returns a different hash |
| Receipt | Amount, fee, hash | Adds a local **preimage proof** check before unlocking |
| Offer transport | Copy/paste only | Copy, **download/load `.json` file**, or hand to buyer in the same page |
| Offer format | v2, hex ciphertext | **v3** with `app` id, listing and base64 ciphertext (~33% smaller than hex). The parser checks that ciphertext length = size + 16-byte GCM tag |
| UI | Single-page tutorial panels | Step tracker, seller studio, listing card, locked/unlocked states, receipt panel |
| Tests | 9 payment-safety tests | Those 9 (updated for the listing) + **7 new** tests: file round-trip, key never in offer, random key rejected, listing tamper rejected, price/description enforcement, malformed-offer rejection, listing policy |

Unchanged on purpose: the starter's channel opening, node session locking, and payment safety logic (attempt recorded before send, no automatic resubmission, status recovery after refresh) in `lib/fiber.ts`, `lib/node-session.ts` and `lib/payment-submission.ts`.

### Files

- `lib/crypto.ts`: AES-256-GCM over bytes with additional data, base64, SHA-256, preimage proof.
- `lib/listing.ts` (new): listing type, validation policy, canonical AAD, invoice description.
- `lib/offer.ts`: v3 offer creation and strict parsing.
- `lib/payment.ts`: price- and description-aware invoice validation.
- `lib/bottle.ts` (new): Bottle constants, split out so the logic can run under `node --test`.
- `app/page.tsx`, `app/globals.css`: the Vault UI.
- `vault.test.mjs` (new), `payment.test.mjs` (updated).

## Run it

Requires Node.js 22.18+ and npm. Use `localhost` or HTTPS: the Fiber WASM node needs cross-origin isolation, which `next.config.mjs` provides.

```sh
npm install
npm run dev
```

Open http://localhost:3001, then:

1. **Start node** for Buyer A and Seller C. Copy each funding address into the [CKB Testnet Faucet](https://faucet.nervos.org/). Each node needs **more than 500 Testnet CKB** (500 for the channel plus the fee).
2. **Open 500 CKB channel** on both and press **Refresh status** until both show `CHANNEL_READY` (can take several minutes).
3. In **Seller studio**, edit the listing or switch to **Paid file**, choose a price, then **Encrypt & create invoice**.
4. **Hand to buyer** (or copy/download the offer), then **Validate offer**.
5. **Decrypt without key**: it must be rejected.
6. **Pay**, then **Unlock with revealed key** and download the file.

If Bottle lacks inbound balance toward the seller, use the optional **Send 5 CKB transfer** in the Liquidity card. If a payment stays pending, use **Check payment status** instead of paying again.

These are separate nodes from the ones on fiber.world (browser storage is per site), so they need their own faucet funding. Testnet only: never send Mainnet CKB.

## Checks

```sh
npm run typecheck
npm test        # 16 tests
npm run build
```

## Security notes and limits

- Payment proves the buyer received **the key that matches this ciphertext and listing**. It does not prove the content is good. The free preview is the seller's claim.
- Content is limited to 512 KB so the offer fits in sessionStorage and the clipboard. Larger files would store the ciphertext elsewhere (IPFS or a static host) and put its hash in the listing.
- AES keys and decrypted content are never written to storage. The settled key can be recovered later through `getPayment`.
- One buyer per invoice: the key is public to whoever pays, so selling to many buyers needs one key/invoice per buyer (or hold invoices).
