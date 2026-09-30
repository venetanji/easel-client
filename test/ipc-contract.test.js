const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IPC_CHANNELS,
  assertKnownChannel,
  validateCanvasBounds,
  validateCanvasTitle,
  validateCanvasKits,
  validateChatMessage,
  validateOpaqueId,
  validateSettingsInput,
  validateLiteLLMModelInput,
} = require('../src/ipc-contract');

test('accepts only declared IPC channels', () => {
  assert.equal(assertKnownChannel(IPC_CHANNELS.GET_SETTINGS), IPC_CHANNELS.GET_SETTINGS);
  assert.equal(assertKnownChannel(IPC_CHANNELS.UNDO_CANVAS), 'canvas:undo');
  assert.throws(() => assertKnownChannel('shell:exec'), /unsupported IPC channel/i);
});

test('validates settings IPC payloads as plain objects', () => {
  assert.deepEqual(validateSettingsInput({ litellmModel: ' model-a ' }), { litellmModel: 'model-a' });
  assert.throws(() => validateSettingsInput(null), /settings object/i);
  assert.throws(() => validateSettingsInput({ unexpected: true }), /unsupported setting/i);
});

test('validates selected LiteLLM model IDs for explicit connection probes', () => {
  assert.equal(validateLiteLLMModelInput(' provider/model-a '), 'provider/model-a');
  assert.throws(() => validateLiteLLMModelInput(' '), /model is required/i);
  assert.throws(() => validateLiteLLMModelInput('x'.repeat(257)), /too long/i);
});

test('validates and bounds chat messages', () => {
  assert.equal(validateChatMessage('  make a blue bird  '), 'make a blue bird');
  assert.throws(() => validateChatMessage('  '), /message is required/i);
  assert.throws(() => validateChatMessage('x'.repeat(20_001)), /too long/i);
});

test('accepts only offline canvas kits at the IPC boundary', () => {
  assert.deepEqual(validateCanvasKits(['canvas-2d', 'tone', 'tone']), ['canvas-2d', 'tone']);
  assert.deepEqual(validateCanvasKits(), []);
  assert.throws(() => validateCanvasKits({ tone: true }), /kit preferences are invalid/i);
  assert.throws(() => validateCanvasKits(['https://cdn.example/tone.js']), /kit preference is invalid/i);
  assert.throws(() => validateCanvasKits(Array(7).fill('tone')), /kit preferences are invalid/i);
});

test('validates opaque library IDs and bounded canvas layout rectangles', () => {
  assert.equal(validateOpaqueId('a'.repeat(32), 'Asset ID'), 'a'.repeat(32));
  assert.throws(() => validateOpaqueId('../settings.json', 'Canvas ID'), /invalid/i);
  assert.deepEqual(validateCanvasBounds({ x: 10.8, y: 20, width: 700, height: 500 }), {
    x: 10, y: 20, width: 700, height: 500,
  });
  assert.throws(() => validateCanvasBounds({ x: -1, y: 0, width: 10, height: 10 }), /x is invalid/i);
});

test('validates and trims empty canvas names', () => {
  assert.equal(validateCanvasTitle('  Image board  '), 'Image board');
  assert.throws(() => validateCanvasTitle('  '), /name is required/i);
  assert.throws(() => validateCanvasTitle('x'.repeat(121)), /120 characters/i);
});
