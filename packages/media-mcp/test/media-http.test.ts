import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { requestBinary } from '../src/media-http.js';

const operation = { label: 'Media download', path: '/content' };

async function serve(t: TestContext, bytes: Buffer, headers: Record<string, string>): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'audio/mp4', Connection: 'close', ...headers });
    response.end(bytes);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/content`;
}

for (const [encoding, compress] of Object.entries({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync })) {
  test(`binary downloads accept fetch-decoded ${encoding} bytes with a wire Content-Length`, async (t) => {
    const decoded = Buffer.from('media payload '.repeat(100));
    const encoded = compress(decoded);
    assert.notEqual(encoded.length, decoded.length);
    const url = await serve(t, encoded, { 'Content-Encoding': encoding, 'Content-Length': String(encoded.length) });
    const media = await requestBinary(url, {}, '', globalThis.fetch, decoded.length, operation);
    assert.deepEqual(media.bytes, decoded);
    assert.equal(media.mimeType, 'audio/mp4');
  });

  test(`binary downloads enforce the decoded byte limit for ${encoding}`, async (t) => {
    const decoded = Buffer.from('media payload '.repeat(100));
    const encoded = compress(decoded);
    const limit = decoded.length - 1;
    assert.ok(encoded.length < limit);
    const url = await serve(t, encoded, { 'Content-Encoding': encoding, 'Content-Length': String(encoded.length) });
    await assert.rejects(requestBinary(url, {}, '', globalThis.fetch, limit, operation), /exceeds.*limit/);
  });

  test(`binary downloads reject truncated ${encoding} transfers`, async (t) => {
    const encoded = compress(Buffer.from('media payload '.repeat(100)));
    const truncated = encoded.subarray(0, Math.floor(encoded.length / 2));
    const url = await serve(t, truncated, { 'Content-Encoding': encoding, 'Content-Length': String(encoded.length) });
    await assert.rejects(requestBinary(url, {}, '', globalThis.fetch, 2_000, operation));
  });
}

test('compressed wire overhead does not count against the decoded byte limit', async (t) => {
  const decoded = Buffer.from('abc');
  const encoded = gzipSync(decoded);
  assert.ok(encoded.length > decoded.length);
  const url = await serve(t, encoded, { 'Content-Encoding': 'gzip', 'Content-Length': String(encoded.length) });
  const media = await requestBinary(url, {}, '', globalThis.fetch, decoded.length, operation);
  assert.deepEqual(media.bytes, decoded);
});

test('identity downloads still verify length and reject truncated transfers', async (t) => {
  const bytes = Buffer.from('media');
  for (const encoding of [undefined, 'identity']) {
    const headers = encoding ? { 'Content-Encoding': encoding } : {};
    const url = await serve(t, bytes, { ...headers, 'Content-Length': String(bytes.length) });
    const media = await requestBinary(url, {}, '', globalThis.fetch, bytes.length, operation);
    assert.deepEqual(media.bytes, bytes);
    const truncatedUrl = await serve(t, bytes, { ...headers, 'Content-Length': String(bytes.length + 1) });
    await assert.rejects(requestBinary(truncatedUrl, {}, '', globalThis.fetch, 100, operation));
    await assert.rejects(requestBinary(url, {}, '', async () => new Response(bytes, {
      headers: { ...headers, 'Content-Length': String(bytes.length + 1) },
    }), 100, operation), /truncated/);
    await assert.rejects(requestBinary(url, {}, '', globalThis.fetch, bytes.length - 1, operation), /exceeds.*limit/);
  }
});
