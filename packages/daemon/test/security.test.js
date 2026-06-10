import { test } from 'node:test';
import assert from 'node:assert/strict';

const { assertPublicHttpUrl, validateGlob } = await import('../src/tools.js');

// ── SSRF guard (no real network: lookup is injected) ─────────────────────────

const resolveTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const neverResolve = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };

test('ssrf: non-http(s) schemes are rejected', async () => {
  await assert.rejects(() => assertPublicHttpUrl('ftp://example.com/x'), /must be http\(s\)/);
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd'), /must be http\(s\)/);
  await assert.rejects(() => assertPublicHttpUrl('not a url'), /invalid url/);
});

test('ssrf: private/internal literal v4 addresses are blocked', async () => {
  const blocked = [
    'http://0.0.0.0/', 'http://10.1.2.3/', 'http://127.0.0.1:8080/x',
    'http://169.254.169.254/latest/meta-data/', 'http://172.16.0.1/', 'http://172.31.255.255/',
    'http://192.168.1.1/', 'http://100.64.0.1/', 'http://100.127.0.1/', 'http://198.18.0.1/', 'http://198.19.5.5/',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(url), /blocked/, url);
  }
  // the WHATWG URL parser canonicalizes integer/octal v4 forms to dotted-quad
  await assert.rejects(() => assertPublicHttpUrl('http://2130706433/'), /blocked/, 'integer-form 127.0.0.1');
});

test('ssrf: v6 loopback/unspecified/private/link-local/mapped-v4 are blocked', async () => {
  const blocked = [
    'http://[::1]/', 'http://[::]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/',
    'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(url), /blocked/, url);
  }
});

test('ssrf: blocked hostnames are rejected without a lookup', async () => {
  const blocked = [
    'http://localhost/', 'http://localhost:3000/x', 'http://foo.localhost/',
    'http://metadata.google.internal/computeMetadata/v1/', 'http://metadata.goog/',
    'http://kubernetes.default.svc/', 'http://anything.svc.cluster.local/',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(url, { lookup: resolveTo('93.184.216.34') }), /blocked host/, url);
  }
});

test('ssrf: a hostname resolving to ANY private address is blocked (DNS pinning)', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('http://evil.example.com/', { lookup: resolveTo('93.184.216.34', '10.0.0.5') }),
    /resolves to a private\/internal address/
  );
  await assert.rejects(
    () => assertPublicHttpUrl('http://rebind.example.com/', { lookup: resolveTo('::ffff:192.168.0.1') }),
    /resolves to a private\/internal address/
  );
});

test('ssrf: public hosts pass; lookup failure throws a clear error', async () => {
  const u = await assertPublicHttpUrl('https://example.com/docs', { lookup: resolveTo('93.184.216.34', '2606:2800:220:1::1') });
  assert.equal(u.hostname, 'example.com');
  await assert.rejects(() => assertPublicHttpUrl('http://no-such-host.example/', { lookup: neverResolve }), /cannot resolve host/);
  await assert.rejects(() => assertPublicHttpUrl('http://empty.example/', { lookup: resolveTo() }), /cannot resolve host/);
});

test('ssrf: allowPrivateNetwork bypasses the address checks (localhost docs servers)', async () => {
  const opts = { allowPrivateNetwork: true, lookup: neverResolve };
  await assert.doesNotReject(() => assertPublicHttpUrl('http://localhost:8080/docs', opts));
  await assert.doesNotReject(() => assertPublicHttpUrl('http://127.0.0.1:3000/', opts));
  // scheme is still enforced even when private networks are allowed
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd', opts), /must be http\(s\)/);
});

// ── glob complexity limits ────────────────────────────────────────────────────

test('glob: validateGlob enforces length and wildcard limits', () => {
  assert.equal(validateGlob('src/**/*.{js,ts}'), 'src/**/*.{js,ts}');
  assert.throws(() => validateGlob('x'.repeat(501)), /too long: 501 chars/);
  assert.throws(() => validateGlob('*?'.repeat(9)), /too complex: 18 wildcards/);
  // 16 wildcards is the inclusive maximum
  assert.equal(validateGlob('*'.repeat(16)), '*'.repeat(16));
});
