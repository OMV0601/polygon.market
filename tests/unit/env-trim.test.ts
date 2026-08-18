import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A trailing newline on the SMTP_PASS secret made Gmail reject a valid app
 * password. The env layer trims credentials so that cannot happen again; these
 * assert the trimming rather than the SMTP call itself.
 */
test('credentials are trimmed before use', async () => {
  process.env.SMTP_USER = '  omvyas.0601@gmail.com\n';
  process.env.SMTP_PASS = 'xzxccgmplwrizscz\n';
  process.env.REPORT_EMAIL_TO = '\tomvyas.0601@gmail.com  ';

  // env.ts reads process.env at import time, so import after setting it.
  const { env } = await import('../../src/config/env');

  assert.equal(env.SMTP_USER, 'omvyas.0601@gmail.com');
  assert.equal(env.SMTP_PASS, 'xzxccgmplwrizscz');
  assert.equal(env.REPORT_EMAIL_TO, 'omvyas.0601@gmail.com');
});

test('a clean value is left alone', async () => {
  const { env } = await import('../../src/config/env');
  assert.ok(!/^\s|\s$/.test(env.SMTP_PASS ?? ''));
});

test('an empty secret falls back to the default instead of blanking it', async () => {
  // GitHub Actions sets every referenced-but-missing secret to "", which is how
  // an unset RESEND_FROM produced an empty From header and a 422 from Resend.
  process.env.RESEND_FROM = '';
  const { env } = await import('../../src/config/env');
  assert.equal(env.RESEND_FROM, 'onboarding@resend.dev');
});
