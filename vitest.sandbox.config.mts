import base from './vitest.config.mts';

// Opt-in suite against the real PayPal sandbox: `npm run test:sandbox` with PAYPAL_SANDBOX_TESTS=1.
if (process.env.PAYPAL_SANDBOX_TESTS === '1') {
  try {
    // Values already in the environment win.
    process.loadEnvFile('.env.local');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export default {
  ...base,
  test: { ...base.test, include: ['tests/sandbox/**/*.sandbox.ts'], testTimeout: 30_000 },
};
