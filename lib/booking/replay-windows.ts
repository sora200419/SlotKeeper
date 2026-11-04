const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a replay may reuse a PayPal-Request-Id. PayPal forgets ids after 6 hours on Orders and 45
 * days on Payments (SDK docs); a later replay would run as a brand-new call, so it stops short of that.
 * Shared by the payment layer and the staff board, which must not offer a replay the server refuses.
 */
export const REPLAY_WINDOW_MS = {
  capture: 44 * 24 * HOUR_MS,
  void: 44 * 24 * HOUR_MS,
  reauthorize: 44 * 24 * HOUR_MS,
  refund: 44 * 24 * HOUR_MS,
  wallet_charge: 5 * HOUR_MS,
} as const;
