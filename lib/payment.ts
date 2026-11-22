import type { FiberBrowserNode, SendPaymentParams } from '@fiber-pay/sdk/browser';
import type { EncryptedOffer } from './offer.ts';
import { invoiceDescription, MAX_FEE_SHANNONS } from './listing.ts';
import { assertEncryptedInvoiceNotExpired, EncryptedPaymentRejectedError, submitEncryptedPayment } from './payment-submission.ts';

type OfferRef = Pick<EncryptedOffer, 'invoice' | 'paymentHash' | 'lastHop' | 'listing'>;

/**
 * The invoice is signed by the seller's node. Check that it charges exactly the
 * listed price on Testnet, commits to the offer's payment hash, and describes
 * this listing before any money moves.
 */
export async function validateOffer(node: Pick<FiberBrowserNode, 'parseInvoice'>, offer: OfferRef) {
  const { invoice } = await node.parseInvoice({ invoice: offer.invoice });
  const description = invoice.data.attrs?.find((attribute) => 'description' in attribute);
  if (invoice.currency !== 'Fibt'
    || BigInt(invoice.amount ?? '0x0') !== BigInt(offer.listing.priceShannons)
    || invoice.data.payment_hash.toLowerCase() !== offer.paymentHash.toLowerCase()
    || !description || !('description' in description)
    || description.description !== invoiceDescription(offer.listing)) {
    throw new Error('The invoice does not match this listing (network, price, payment hash or description).');
  }
  return invoice;
}

export async function payForOffer(node: Pick<FiberBrowserNode, 'parseInvoice' | 'sendPayment' | 'getPayment' | 'waitForPayment'>,
  offer: OfferRef, attempt: string, recordAttempt: (hash: string) => void, retry = false) {
  const invoice = await validateOffer(node, offer);
  if (attempt) {
    if (attempt.toLowerCase() !== offer.paymentHash.toLowerCase()) throw new Error('Restore the offer for the previous payment.');
    const previous = await node.getPayment({ payment_hash: offer.paymentHash });
    if (!retry || previous.status !== 'Failed') return previous;
  }
  assertEncryptedInvoiceNotExpired(invoice);
  // A storage failure aborts before a payment can be submitted.
  recordAttempt(offer.paymentHash);
  try {
    return await submitEncryptedPayment(node, offer.paymentHash, { invoice: offer.invoice,
      hop_hints: [offer.lastHop] as unknown as NonNullable<SendPaymentParams['hop_hints']>,
      max_fee_amount: MAX_FEE_SHANNONS, max_parts: '0x1' });
  } catch (error) {
    if (error instanceof EncryptedPaymentRejectedError) recordAttempt('');
    throw error;
  }
}
