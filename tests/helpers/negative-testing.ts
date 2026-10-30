import type { DepositPayments } from '@/lib/paypal/deposit-actions';
import type { DepositOrders } from '@/lib/paypal/deposits';

/** The PayPal-Mock-Response value that makes the sandbox answer with `code` instead of processing the call. */
export const mockHeader = (code: string) => JSON.stringify({ mock_application_codes: code });

/**
 * Wraps real controllers so money calls carry PayPal-Mock-Response. App code never sends it.
 * Reauthorize passes through unchanged: the SDK's reauthorizePayment has no such parameter.
 */
export function mockedPayments(real: DepositPayments, code: string): DepositPayments {
  const paypalMockResponse = mockHeader(code);
  return {
    captureAuthorizedPayment: (input, options) => real.captureAuthorizedPayment({ ...input, paypalMockResponse }, options),
    voidPayment: (input, options) => real.voidPayment({ ...input, paypalMockResponse }, options),
    reauthorizePayment: (input, options) => real.reauthorizePayment(input, options),
    refundCapturedPayment: (input, options) => real.refundCapturedPayment({ ...input, paypalMockResponse }, options),
  };
}

export function mockedOrders(real: DepositOrders, code: string): DepositOrders {
  const paypalMockResponse = mockHeader(code);
  return {
    createOrder: (input, options) => real.createOrder({ ...input, paypalMockResponse }, options),
    authorizeOrder: (input, options) => real.authorizeOrder({ ...input, paypalMockResponse }, options),
  };
}
