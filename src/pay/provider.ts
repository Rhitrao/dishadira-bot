// Payments go through this interface. Cashfree is the only implementation in v1 (never two providers in one flow).

export type LinkState = "ACTIVE" | "PAID" | "PARTIALLY_PAID" | "EXPIRED" | "CANCELLED" | "UNKNOWN";

// What we learn about a link, from a verified webhook or from a status read.
export type PayStatus = {
  linkId: string;
  status: LinkState;
  paidPaise: number;
  currency: string;
  orderId?: string; // provider order of the successful payment (needed to refund)
  mode?: "test" | "live";
  payerRef?: string; // payer UPI handle, only if the provider returns it (Payment Links endpoints do not)
};
export type PayEvent = PayStatus & { key: string }; // key dedupes webhook replays

export type CreateLinkArgs = {
  linkId: string;
  amountPaise: number;
  purpose: string;
  customerName: string;
  customerPhone: string;
  expiresAtUtc: string;
};

// Provider's refund state, reduced to what we act on. NOT_FOUND = the provider has no refund with that refund_id.
export type RefundStatus = "SUCCESS" | "PENDING" | "FAILED" | "NOT_FOUND";
export type RefundResult = { providerRefundId?: string; status: RefundStatus };
export type RefundEvent = { key: string; refundId: string; status: RefundStatus };

export type VerifyResult =
  | { ok: true; event: PayEvent }
  | { ok: true; refund: RefundEvent }
  | { ok: false; reason: "SIGNATURE" | "PAYLOAD" };

export interface PaymentProvider {
  createLink(args: CreateLinkArgs): Promise<{ linkId: string; url: string }>;
  getStatus(linkId: string): Promise<PayStatus>;
  // Checks the signature on the raw body first; only then parses it.
  verifyWebhook(raw: string, headers: Headers): Promise<VerifyResult>;
  // refundId is the idempotency handle: a retry always sends the same one.
  refund(args: { orderId: string; amountPaise: number; refundId: string; note: string }): Promise<RefundResult>;
  getRefund(orderId: string, refundId: string): Promise<RefundResult>;
}
