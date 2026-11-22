'use client';

import { channelFundingGuidance } from '../lib/channel-funding';
import { useEffect, useMemo, useRef, useState } from 'react';
import { scriptToAddress, type Channel, type FiberBrowserNode, type GetPaymentResult } from '@fiber-pay/sdk/browser';
import { decryptBytes, preimageMatches, toHex } from '../lib/crypto';
import { bottle, channelFundingCkb, connectAndOpenChannel, readChannel, ready, startRole } from '../lib/fiber';
import { createOffer, parseOffer, type EncryptedOffer } from '../lib/offer';
import { payForOffer, validateOffer } from '../lib/payment';
import { ckbToShannonsHex, formatBytes, formatCkb, listingAad, MAX_CONTENT_BYTES, MAX_PRICE_CKB, MIN_PRICE_CKB, safeFileName } from '../lib/listing';
import { createBrowserNodeSession } from '../lib/node-session';
import { encryptedSessionKey, encryptedBuyerProfile, encryptedSellerProfile, savedNodeIdentifier, readEncryptedProgress, type EncryptedLessonProgress } from '../lib/progress';

type Role = 'buyer' | 'seller';
type Mode = 'text' | 'file';
const sampleTitle = 'CKB Fiber field notes: routing through Bottle';
const samplePreview = 'Free preview: why a browser node needs a public hop, and the one channel number that decides whether a payment routes.';
const sampleBody = `# CKB Fiber field notes (paid section)

1. Browser nodes can dial out but cannot accept inbound connections, so every route touches a public node like Bottle.
2. The route capacity is the smaller of Buyer->Bottle local balance and Bottle->Seller balance.
3. The invoice preimage IS the AES-256-GCM key: settling the payment is what hands it to the buyer.

Thanks for unlocking this with Fiber!`;

function download(name: string, bytes: Uint8Array | string, type: string) {
  const blob = new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function Page() {
  const nodes = useRef<Partial<Record<Role, FiberBrowserNode>>>({});
  const sessions = useRef<Partial<Record<Role, ReturnType<typeof createBrowserNodeSession>>>>({});
  const progress = useRef<EncryptedLessonProgress | null>(null);
  const locked = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addresses, setAddresses] = useState<Partial<Record<Role, string>>>({});
  const [connected, setConnected] = useState<Partial<Record<Role, boolean>>>({});
  const [channels, setChannels] = useState<Partial<Record<Role, Channel>>>({});
  // Seller listing
  const [title, setTitle] = useState(sampleTitle);
  const [preview, setPreview] = useState(samplePreview);
  const [mode, setMode] = useState<Mode>('text');
  const [body, setBody] = useState(sampleBody);
  const [file, setFile] = useState<File | null>(null);
  const [price, setPrice] = useState(MIN_PRICE_CKB);
  const [generated, setGenerated] = useState('');
  // Buyer
  const [received, setReceived] = useState('');
  const [offer, setOffer] = useState<EncryptedOffer | null>(null);
  const [attempt, setAttempt] = useState('');
  const [tested, setTested] = useState(false);
  const [payment, setPayment] = useState<GetPaymentResult | null>(null);
  const [key, setKey] = useState('');
  const [keyVerified, setKeyVerified] = useState(false);
  const [unlocked, setUnlocked] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = readEncryptedProgress(sessionStorage, localStorage);
    progress.current = saved;
    if (saved) { setGenerated(saved.generatedOffer); setReceived(saved.buyerOfferText); setAttempt(saved.attemptedPaymentHash); setTested(saved.triedWithoutKey); }
    setLoaded(true);
    const owned = sessions.current;
    const stop = () => { for (const session of Object.values(owned)) void session.stop().catch(() => {}); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); nodes.current = {}; sessions.current = {}; };
  }, []);

  function save(update: Partial<EncryptedLessonProgress>) {
    const buyerId = savedNodeIdentifier(localStorage, encryptedBuyerProfile);
    const sellerId = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    if (!buyerId || !sellerId) throw new Error('Start both saved nodes before continuing.');
    const next = { version: 1 as const, buyerId, sellerId, generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, ...progress.current, ...update };
    sessionStorage.setItem(encryptedSessionKey, JSON.stringify(next));
    progress.current = next;
  }

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed. Check status before retrying a transfer.'); }
    finally { locked.current = false; setBusy(false); }
  }

  async function refresh(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await readChannel(node);
    const { peers } = await node.listPeers();
    setConnected((previous) => ({ ...previous, [role]: peers.some(peer => peer.pubkey.replace(/^0x/i, '').toLowerCase() === bottle.pubkey.slice(2)) }));
    setChannels((previous) => ({ ...previous, [role]: channel }));
  }

  async function start(role: Role) {
    if (nodes.current[role]) return;
    const session = sessions.current[role] ??= createBrowserNodeSession();
    let started: FiberBrowserNode | undefined;
    await session.start(role === 'buyer' ? encryptedBuyerProfile : encryptedSellerProfile, async (track) => {
      started = await startRole(role, track);
    });
    if (!started) return;
    nodes.current[role] = started;
    const info = await started.nodeInfo();
    setAddresses((previous) => ({ ...previous, [role]: scriptToAddress(info.default_funding_lock_script, 'testnet') }));
    if (await readChannel(started)) await started.connectPeer(bottle);
    await refresh(role);
  }

  async function open(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await connectAndOpenChannel(node);
    setChannels((previous) => ({ ...previous, [role]: channel }));
    await refresh(role);
    setStatus(channel && ready(channel) ? 'Channel ready.' : 'Opening submitted. Check channel status after confirmation.');
  }

  async function moveLiquidity() {
    const node = nodes.current.seller;
    if (!node) return;
    const id = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    const storageKey = `fiber-docs:encrypted-inbound:${id}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing === 'submitting') throw new Error('Transfer outcome unknown. Review payment history before sending again.');
    let result: GetPaymentResult;
    if (existing) result = await node.getPayment({ payment_hash: existing as `0x${string}` });
    else {
      sessionStorage.setItem(storageKey, 'submitting');
      result = await node.sendPayment({ target_pubkey: bottle.pubkey, amount: '0x1dcd65000', keysend: true });
      sessionStorage.setItem(storageKey, result.payment_hash);
    }
    if (!['Success', 'Failed'].includes(result.status)) result = await node.waitForPayment(result.payment_hash, { timeout: 60_000, interval: 1_000 });
    if (result.status === 'Failed') sessionStorage.removeItem(storageKey);
    setStatus(`Liquidity transfer: ${result.status}`);
    await refresh('seller');
  }

  async function makeOffer() {
    if (!nodes.current.seller || !channels.seller || !sellerRouteReady || generated || attempt) return;
    let content: Uint8Array;
    let fileName: string;
    let mimeType: string;
    if (mode === 'file') {
      if (!file) throw new Error('Choose a file to sell.');
      if (file.size > MAX_CONTENT_BYTES) throw new Error(`File is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_CONTENT_BYTES)}.`);
      content = new Uint8Array(await file.arrayBuffer());
      fileName = safeFileName(file.name);
      mimeType = file.type || 'application/octet-stream';
    } else {
      content = new TextEncoder().encode(body);
      fileName = `${safeFileName(title.replace(/\s+/g, '-').toLowerCase()).slice(0, 60)}.md`;
      mimeType = 'text/markdown';
    }
    const value = await createOffer(nodes.current.seller, channels.seller, {
      title, preview, kind: mode, fileName, mimeType, priceShannons: ckbToShannonsHex(price), content,
    });
    save({ generatedOffer: value }); setGenerated(value);
    setStatus(`Listing encrypted and ${price} CKB invoice created. Send the offer to the buyer.`);
  }

  async function loadOfferFile(chosen: File | undefined) {
    if (!chosen) return;
    setReceived(await chosen.text()); setTested(false); setStatus(`Loaded ${chosen.name}. Validate it next.`);
  }

  async function validate() {
    if (!nodes.current.buyer) return;
    const parsed = parseOffer(received);
    await validateOffer(nodes.current.buyer, parsed);
    if (attempt && parsed.paymentHash.toLowerCase() !== attempt.toLowerCase()) throw new Error('Restore the offer for the previous payment.');
    save({ buyerOfferText: received }); setOffer(parsed);
    setStatus('Offer validated: invoice is Testnet, signed for this listing, and charges the listed price.');
  }

  async function testLock() {
    if (!offer) return;
    try { await decryptBytes(offer, toHex(crypto.getRandomValues(new Uint8Array(32))), listingAad(offer.listing, offer.paymentHash)); }
    catch { save({ triedWithoutKey: true }); setTested(true); setStatus('Decryption rejected: key unavailable. The content stays locked until payment.'); }
  }

  async function pay() {
    if (!nodes.current.buyer || !offer || !tested || !buyerRouteReady) return;
    const result = await payForOffer(nodes.current.buyer, offer, attempt, (hash) => {
      save({ attemptedPaymentHash: hash }); setAttempt(hash);
    }, payment?.status === 'Failed');
    await acceptPayment(result);
    await Promise.all([refresh('buyer'), refresh('seller')]);
  }

  async function acceptPayment(result: GetPaymentResult) {
    setPayment(result); setStatus(`Payment: ${result.status}`);
    if (result.status === 'Failed') setError(result.failed_error ?? 'Payment failed. Check channel liquidity before retrying.');
    if (result.status === 'Success' && result.payment_preimage && offer) {
      const verified = await preimageMatches(result.payment_preimage, offer.paymentHash);
      setKeyVerified(verified);
      if (!verified) throw new Error('Revealed preimage does not hash to the offer payment hash.');
      setKey(result.payment_preimage);
    }
  }

  async function checkPayment() {
    if (!nodes.current.buyer || !offer || !attempt) return;
    await validateOffer(nodes.current.buyer, offer);
    await acceptPayment(await nodes.current.buyer.getPayment({ payment_hash: attempt as `0x${string}` }));
  }

  async function unlock() {
    if (!offer || !key) return;
    setUnlocked(await decryptBytes(offer, key, listingAad(offer.listing, offer.paymentHash)));
    setStatus('Unlocked. AES-GCM verified the content and its listing are exactly what the seller encrypted.');
  }

  function startAnotherOffer() {
    if (busy || (attempt && payment?.status !== 'Failed' && !unlocked)) return;
    save({ generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, completedSteps: [] });
    setGenerated(''); setReceived(''); setOffer(null); setAttempt(''); setTested(false);
    setPayment(null); setKey(''); setKeyVerified(false); setUnlocked(null); setError('');
    setStatus('Create a fresh encrypted listing.');
  }

  const sellerPriceShannons = BigInt(ckbToShannonsHex(price));
  const sellerRouteReady = Boolean(connected.seller && channels.seller && ready(channels.seller) && BigInt(channels.seller.remote_balance) >= sellerPriceShannons);
  const buyerPrice = offer ? BigInt(offer.listing.priceShannons) : sellerPriceShannons;
  const buyerRouteReady = Boolean(connected.buyer && channels.buyer && ready(channels.buyer) && BigInt(channels.buyer.local_balance) >= buyerPrice
    && channels.seller && ready(channels.seller) && BigInt(channels.seller.remote_balance) >= buyerPrice);
  const canSubmit = Boolean(offer && tested && buyerRouteReady && !key && (!attempt || payment?.status === 'Failed'));

  const unlockedText = useMemo(() => {
    if (!unlocked || !offer) return '';
    return offer.listing.mimeType.startsWith('text/') ? new TextDecoder().decode(unlocked) : '';
  }, [unlocked, offer]);
  const imageUrl = useMemo(() => {
    if (!unlocked || !offer || !offer.listing.mimeType.startsWith('image/')) return '';
    return URL.createObjectURL(new Blob([new Uint8Array(unlocked)], { type: offer.listing.mimeType }));
  }, [unlocked, offer]);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  const steps = [
    { label: 'Nodes', done: Boolean(addresses.buyer && addresses.seller) },
    { label: 'Channels', done: Boolean(channels.buyer && ready(channels.buyer) && channels.seller && ready(channels.seller)) },
    { label: 'List', done: Boolean(generated) },
    { label: 'Validate', done: Boolean(offer) },
    { label: 'Locked ✓', done: tested },
    { label: 'Pay', done: payment?.status === 'Success' },
    { label: 'Unlock', done: Boolean(unlocked) },
  ];
  const current = steps.findIndex((step) => !step.done);

  return <main>
    <header className="hero">
      <p className="eyebrow">Fiber Testnet · pay-to-unlock</p>
      <h1>Fiber Unlock Vault</h1>
      <p className="lede">Sell a file or research brief with a free preview. The buyer&apos;s Fiber payment reveals the invoice preimage, and that preimage <em>is</em> the AES-256-GCM key.</p>
      <ol className="steps">{steps.map((step, index) => <li key={step.label} className={step.done ? 'done' : index === current ? 'current' : ''}>{step.label}</li>)}</ol>
    </header>
    {status && <p className="status" role="status">{status}</p>}{error && <p className="alert" role="alert">{error}</p>}

    <div className="grid">{(['buyer', 'seller'] as const).map((role) => <section className="card" key={role}>
      <h2>{role === 'buyer' ? 'Buyer A' : 'Seller C'} <span className="muted">node</span></h2>
      {!addresses[role] && <button disabled={!loaded || busy} onClick={() => void run(() => start(role))}>Start node</button>}
      {addresses[role] && <><code>{addresses[role]}</code><a href="https://faucet.nervos.org" target="_blank" rel="noreferrer">Get Testnet CKB ↗</a>
        {!channels[role] && <p className="muted">{channelFundingGuidance}</p>}
        <div className="row">
          <button disabled={busy} onClick={() => void run(() => open(role))}>{channels[role] ? 'Reconnect / check channel' : `Open ${channelFundingCkb} CKB channel`}</button>
          <button disabled={busy} onClick={() => void run(() => refresh(role))}>Refresh status</button>
        </div>
      </>}
      {channels[role] && <><span className={`pill ${ready(channels[role]) ? 'ok' : ''}`}>{channels[role].state.state_name}</span>
        <p className="muted">{role === 'buyer' ? 'Buyer' : 'Seller'}: {formatCkb(channels[role].local_balance)} CKB · Bottle: {formatCkb(channels[role].remote_balance)} CKB</p></>}
    </section>)}</div>
    <section className="card slim"><h2>Liquidity <span className="muted">optional</span></h2>
      <p className="muted">Bottle needs inbound balance toward the seller at least equal to the price. If it is short, push 5 CKB from Seller to Bottle.</p>
      <button disabled={busy || !channels.seller || !ready(channels.seller) || BigInt(channels.seller.local_balance) < 500_000_000n} onClick={() => void run(moveLiquidity)}>Send / check 5 CKB transfer</button>
    </section>

    <div className="grid exchange">
      <section className="card"><h2>Seller studio</h2>
        <label>Title<input value={title} maxLength={80} disabled={busy || Boolean(generated)} onChange={e => setTitle(e.target.value)} /></label>
        <label>Free preview <span className="muted">(public, tamper-proof)</span><textarea className="short" value={preview} maxLength={600} disabled={busy || Boolean(generated)} onChange={e => setPreview(e.target.value)} /></label>
        <div className="toggle" role="radiogroup" aria-label="Content type">
          {(['text', 'file'] as const).map((value) => <button key={value} role="radio" aria-checked={mode === value} className={mode === value ? 'on' : ''} disabled={busy || Boolean(generated)} onClick={() => setMode(value)}>{value === 'text' ? 'Paid text' : 'Paid file'}</button>)}
        </div>
        {mode === 'text'
          ? <label>Paid content<textarea value={body} disabled={busy || Boolean(generated)} onChange={e => setBody(e.target.value)} /></label>
          : <label>File <span className="muted">(max {formatBytes(MAX_CONTENT_BYTES)}, never leaves your browser unencrypted)</span><input type="file" disabled={busy || Boolean(generated)} onChange={e => setFile(e.target.files?.[0] ?? null)} />{file && <span className="muted">{file.name} · {formatBytes(file.size)}</span>}</label>}
        <label>Price<select value={price} disabled={busy || Boolean(generated)} onChange={e => setPrice(Number(e.target.value))}>
          {Array.from({ length: MAX_PRICE_CKB - MIN_PRICE_CKB + 1 }, (_, index) => MIN_PRICE_CKB + index).map((value) => <option key={value} value={value}>{value} CKB</option>)}
        </select></label>
        <button className="primary" disabled={busy || !sellerRouteReady || !title.trim() || (mode === 'text' ? !body.trim() : !file) || Boolean(generated || attempt)} onClick={() => void run(makeOffer)}>Encrypt &amp; create {price} CKB invoice</button>
        {!sellerRouteReady && <p className="muted">Needs a ready Seller channel where Bottle holds at least {price} CKB.</p>}
        <textarea aria-label="Generated offer" readOnly value={generated} placeholder="Public offer JSON appears here. It contains the ciphertext and invoice, never the key." />
        {generated && <p className="muted">Offer size: {formatBytes(generated.length)}</p>}
        <div className="row">
          <button disabled={!generated || busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(generated); setStatus('Offer copied.'); })}>Copy offer</button>
          <button disabled={!generated || busy} onClick={() => download('unlock-offer.json', generated, 'application/json')}>Download offer .json</button>
          <button disabled={!generated || busy || Boolean(received)} onClick={() => { setReceived(generated); setTested(false); setStatus('Offer handed to the buyer panel.'); }}>Hand to buyer →</button>
        </div>
      </section>

      <section className="card"><h2>Buyer</h2>
        <textarea aria-label="Received offer" placeholder="Paste the seller's offer JSON, or load the .json file." disabled={busy || Boolean(offer || attempt)} value={received} onChange={e => { setReceived(e.target.value); setTested(false); }} />
        <label className="file">Load offer file<input type="file" accept="application/json,.json" disabled={busy || Boolean(offer || attempt)} onChange={e => void run(() => loadOfferFile(e.target.files?.[0]))} /></label>
        <button disabled={busy || !received || !addresses.buyer || Boolean(offer)} onClick={() => void run(validate)}>Validate offer</button>
        {offer && <article className="listing">
          <div className="listing-head"><span className={`pill ${unlocked ? 'ok' : 'locked'}`}>{unlocked ? 'Unlocked' : 'Locked'}</span><strong>{formatCkb(offer.listing.priceShannons)} CKB</strong></div>
          <h3>{offer.listing.title}</h3>
          {offer.listing.preview && <p>{offer.listing.preview}</p>}
          <p className="muted">{offer.listing.kind === 'file' ? 'File' : 'Text'} · {offer.listing.fileName} · {offer.listing.mimeType} · {formatBytes(offer.listing.size)}</p>
          <p className="muted">Payment hash <code>{offer.paymentHash}</code></p>
        </article>}
        {!tested && <button disabled={busy || !offer} onClick={() => void run(testLock)}>Decrypt without key</button>}
        {tested && !key && <p className="rejected">✕ Decryption rejected: key unavailable.</p>}
        {canSubmit && <button className="primary" disabled={busy} onClick={() => void run(pay)}>{attempt ? 'Retry failed payment' : `Pay ${offer ? formatCkb(offer.listing.priceShannons) : ''} CKB`}</button>}
        {offer && tested && !buyerRouteReady && !key && <p className="muted">Waiting for both channels to be CHANNEL_READY with enough balance for the price.</p>}
        {attempt && !key && <button disabled={busy || !offer || !addresses.buyer} onClick={() => void run(checkPayment)}>Check payment status</button>}
        <button className="primary" disabled={busy || !offer || !key || Boolean(unlocked)} onClick={() => void run(unlock)}>Unlock with revealed key</button>
      </section>
    </div>

    {payment?.status === 'Success' && offer && <section className="card receipt"><h2>Receipt</h2>
      <dl>
        <dt>Amount</dt><dd>{formatCkb(offer.listing.priceShannons)} CKB</dd>
        <dt>Routing fee</dt><dd>{formatCkb(payment.fee)} CKB</dd>
        <dt>Total</dt><dd>{formatCkb(BigInt(offer.listing.priceShannons) + BigInt(payment.fee))} CKB</dd>
        <dt>Payment hash</dt><dd><code>{payment.payment_hash}</code></dd>
        <dt>Key proof</dt><dd className={keyVerified ? 'good' : ''}>{keyVerified ? '✓ SHA-256(revealed preimage) = payment hash' : 'Not verified'}</dd>
      </dl>
    </section>}

    {unlocked && offer && <section className="result"><h2>Unlocked: {offer.listing.title}</h2>
      {unlockedText && <pre>{unlockedText}</pre>}
      {imageUrl && <img src={imageUrl} alt={offer.listing.title} />}
      {!unlockedText && !imageUrl && <p>{offer.listing.fileName} · {formatBytes(unlocked.length)} decrypted.</p>}
      <button className="primary" onClick={() => download(offer.listing.fileName, unlocked, offer.listing.mimeType)}>Download {offer.listing.fileName}</button>
    </section>}
    {(generated || received) && (!attempt || payment?.status === 'Failed' || unlocked) && <button disabled={busy} onClick={() => void run(async () => startAnotherOffer())}>Start another listing</button>}
    <footer className="muted">Fiber Testnet only. Built on the Fiber encrypted-data-payment starter.</footer>
  </main>;
}
