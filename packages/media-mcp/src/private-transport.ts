import { request as httpRequest, Agent } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { Fetch } from './media-http.js';

export function createPrivateFetch(baseUrl: string, address: string): Fetch {
  const origin = new URL(baseUrl);
  const octets = address.split('.').map(Number);
  const privateAddress = isIP(address) === 4 && (octets[0] === 10 || octets[0] === 127
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127));
  if (origin.protocol !== 'http:' || origin.username || origin.password || origin.search || origin.hash || !privateAddress) {
    throw new Error('Private transport requires an approved HTTP origin and an explicit private IPv4 address.');
  }
  const agent = new Agent({ keepAlive: false });
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== origin.origin || url.username || url.password || url.hash) throw new Error('Private requests must stay on the configured origin.');
    const prepared = new Request(url, init);
    if (prepared.headers.has('authorization') || prepared.headers.has('proxy-authorization') || prepared.headers.has('cookie')) {
      throw new Error('Private transport never accepts API credentials or cookies.');
    }
    prepared.signal.throwIfAborted();
    const body = prepared.body ? Buffer.from(await prepared.arrayBuffer()) : undefined;
    const headers = Object.fromEntries(prepared.headers.entries());
    headers.host = url.host;
    headers['accept-encoding'] = 'identity';
    if (body) headers['content-length'] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest({ hostname: address, port: url.port || 80, path: url.pathname + url.search,
        method: prepared.method, headers, agent, signal: prepared.signal }, incoming => {
        const status = incoming.statusCode || 502;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          reject(new Error('Private transport never follows redirects.'));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const empty = [204, 205, 304].includes(status) || prepared.method === 'HEAD';
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
}
