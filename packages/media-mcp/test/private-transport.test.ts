import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPrivateFetch } from '../src/private-transport.js';

test('private transport pins the peer, preserves Host, supports multipart and bypasses proxy credentials', async (t) => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++; assert.equal(request.headers.host, 'easel.invalid:' + port); assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['proxy-authorization'], undefined); assert.equal(request.headers.cookie, undefined);
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url === '/redirect') { response.writeHead(302, { location: 'http://other.invalid/content' }); response.end(); return; }
    assert.match(body, /name="prompt"/); assert.match(body, /Hello/);
    response.setHeader('content-type', 'application/json'); response.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const fetchImpl = createPrivateFetch('http://easel.invalid:' + port, '127.0.0.1');
  const form = new FormData(); form.append('prompt', 'Hello');
  assert.deepEqual(await (await fetchImpl('http://easel.invalid:' + port + '/v1/videos', { method: 'POST', body: form })).json(), { ok: true });
  await assert.rejects(fetchImpl('http://easel.invalid:' + port + '/redirect'), /redirect/);
  for (const headers of [{ Authorization: 'Bearer sentinel' }, { Cookie: 'secret' }, { 'Proxy-Authorization': 'secret' }]) {
    await assert.rejects(fetchImpl('http://easel.invalid:' + port, { headers }), /credentials/);
  }
  await assert.rejects(fetchImpl('http://other.invalid:' + port), /origin/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchImpl('http://easel.invalid:' + port, { signal: controller.signal }));
  assert.equal(calls, 2);
});
test('private transport rejects public addresses and ambiguous origin configuration', () => {
  for (const [url, address] of [['http://easel.invalid', '8.8.8.8'], ['https://easel.invalid', '100.64.0.7'],
    ['http://user:pass@easel.invalid', '100.64.0.7'], ['http://easel.invalid?x=1', '100.64.0.7']]) {
    assert.throws(() => createPrivateFetch(url!, address!), /approved/);
  }
});
