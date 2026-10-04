import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as video from '../src/video.js';

import { capabilities } from './fixtures/video-contract.js';
const lora = { min_seconds: 5, id: 'camera-static', kind: 'camera', family: 'ltx-2', supported: true, installed: false, requires: [], validation: 't2v_execution_tested', tested_workflows: ['t2v:512x320:2s:strength-0.8'], repo_id: 'org/model', revision: 'a'.repeat(40), files: [{ filename: 'camera.safetensors', bytes: 123, sha256: 'b'.repeat(64) }] };

test('capability discovery is GET-only, authenticated and distinguishes guide availability from support', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await (video as any).discoverVideoCapabilities({ model: 'ltx-2.5', baseUrl: 'https://media.example/v1', apiKey: 'secret',
    fetchImpl: async (url: string, init?: RequestInit) => { calls.push({ url, init }); return Response.json(capabilities); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://media.example/v1/videos/capabilities');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[0].init?.body, undefined);
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'Bearer secret');
  assert.deepEqual(result, capabilities);
  assert.equal(result.guiding_frames.supported, true); assert.equal(result.guiding_frames.available, false);
});

test('LoRA discovery preserves validation, installation and provenance independently', async () => {
  const result = await (video as any).listVideoLoras({ model: 'ltx-2.5', fetchImpl: async (url: string, init?: RequestInit) => {
    assert.ok(url.endsWith('/v1/videos/loras')); assert.equal(init?.method, 'GET');
    return Response.json({ object: 'list', data: [lora] });
  } });
  assert.deepEqual(result, [lora]);
});

test('discovery rejects unsupported, older, malformed or credential-bearing responses explicitly', async () => {
  for (const payload of [{}, { ...capabilities, schema_version: 2 }, { ...capabilities, model: 'other-model' }, { ...capabilities, fps: '24' }, { ...capabilities, guiding_frames: { supported: true } }]) {
    await assert.rejects((video as any).discoverVideoCapabilities({ model: 'ltx-2.5', fetchImpl: async () => Response.json(payload) }), /capabilit|model/i);
  }
  await assert.rejects((video as any).discoverVideoCapabilities({ model: 'ltx-2.5', fetchImpl: async () => Response.json({ detail: 'Not found' }, { status: 404 }) }), /does not support.*capabilit/i);
  await assert.rejects((video as any).listVideoLoras({ model: 'ltx-2.5', fetchImpl: async () => Response.json({ object: 'list', data: [{ ...lora, installed: 'yes' }] }) }), /invalid.*LoRA/i);
  await assert.rejects((video as any).listVideoLoras({ model: 'ltx-2.5', apiKey: 'secret', fetchImpl: async () => Response.json({ object: 'list', data: [{ ...lora, tested_workflows: ['secret'] }] }) }), /credential/i);
});

test('discovery includes disabled versioned catalog IDs without inventing validation evidence', async () => {
  const { tested_workflows: _evidence, ...entry } = lora;
  const disabled = { ...entry, id: 'ltx-2.3-relight', supported: false, installed: true, validation: 'not_tested' };
  const result = await (video as any).listVideoLoras({ model: 'ltx-2.5', fetchImpl: async () => Response.json({ object: 'list', data: [disabled] }) });
  assert.deepEqual(result, [disabled]);
  assert.equal(result[0].tested_workflows, undefined);
});

test('all 38 shipped registry records parse with live installation flags', async () => {
  const { readFile } = await import('node:fs/promises');
  const catalog = JSON.parse(await readFile(new URL('../../../.agents/skills/easel-media/references/lora-catalog.json', import.meta.url), 'utf8'));
  const live = catalog.map((entry: any) => ({ ...entry, installed: false }));
  const result = await (video as any).listVideoLoras({ model: 'ltx-2.5', fetchImpl: async () => Response.json({ object: 'list', data: live }) });
  assert.equal(result.length, 38); assert.deepEqual(result, live);
});
