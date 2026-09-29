const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IPC_CHANNELS,
  assertKnownChannel,
  validateChatMessage,
  validateSettingsInput,
} = require('../src/ipc-contract');

test('accepts only declared IPC channels', () => {
  assert.equal(assertKnownChannel(IPC_CHANNELS.GET_SETTINGS), IPC_CHANNELS.GET_SETTINGS);
  assert.throws(() => assertKnownChannel('shell:exec'), /unsupported IPC channel/i);
});

test('validates settings IPC payloads as plain objects', () => {
  assert.deepEqual(validateSettingsInput({ litellmModel: ' model-a ' }), { litellmModel: 'model-a' });
  assert.throws(() => validateSettingsInput(null), /settings object/i);
  assert.throws(() => validateSettingsInput({ unexpected: true }), /unsupported setting/i);
});

test('validates and bounds chat messages', () => {
  assert.equal(validateChatMessage('  make a blue bird  '), 'make a blue bird');
  assert.throws(() => validateChatMessage('  '), /message is required/i);
  assert.throws(() => validateChatMessage('x'.repeat(20_001)), /too long/i);
});
