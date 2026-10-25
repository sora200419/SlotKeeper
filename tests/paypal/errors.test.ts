import { describe, expect, it } from 'vitest';
import {
  describeTransportError,
  errorCode,
  isNetworkError,
  isTlsError,
} from '@/lib/paypal/errors';

describe('transport error helpers', () => {
  it('finds the code on the error or on its cause chain', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    const wrapped = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('inner'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
    });
    expect(errorCode(wrapped)).toBe('SELF_SIGNED_CERT_IN_CHAIN');
    expect(errorCode(new Error('no code'))).toBeUndefined();
  });

  it('classifies TLS, socket, abort and raw axios errors as transport failures', () => {
    const tls = Object.assign(new Error('cert'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    expect(isTlsError(tls)).toBe(true);
    expect(isNetworkError(tls)).toBe(true);
    expect(isNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('x'), { isAxiosError: true }))).toBe(true);
  });

  it('does not classify programming errors as transport failures', () => {
    expect(isNetworkError(new TypeError('x is not a function'))).toBe(false);
    expect(isNetworkError('not an error')).toBe(false);
  });

  it('describes a failure from its code and first message line only', () => {
    const err = Object.assign(new Error('socket hang up\nstack-ish detail'), {
      code: 'ECONNRESET',
      config: { headers: { Authorization: 'Basic SECRET' } },
    });
    expect(describeTransportError(err)).toBe('socket hang up (ECONNRESET)');
    expect(describeTransportError(err)).not.toContain('SECRET');
  });

  it('gives an actionable hint for TLS interception', () => {
    const tls = Object.assign(new Error('unable to verify the first certificate'), {
      cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    });
    expect(describeTransportError(tls)).toContain('NODE_OPTIONS=--use-system-ca');
  });
});
