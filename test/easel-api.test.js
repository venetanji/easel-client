const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHeaders,
  createGenerationPayload,
  extractImageSources,
  generateImages,
  normalizeBaseUrl,
} = require('../src/easel-api');
const { handleGenerationSubmit, resultSummary } = require('../src/renderer');

function createMockClassList() {
  const classes = new Set();

  return {
    toggle(name, force) {
      if (force) {
        classes.add(name);
        return true;
      }

      classes.delete(name);
      return false;
    },
    contains(name) {
      return classes.has(name);
    },
  };
}

function createMockElement(tagName = 'div') {
  return {
    tagName,
    attributes: {},
    children: [],
    className: '',
    classList: createMockClassList(),
    disabled: false,
    textContent: '',
    value: '',
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}

function createMockDocument() {
  return {
    createElement(tagName) {
      return createMockElement(tagName);
    },
  };
}

test('normalizeBaseUrl trims whitespace, removes trailing slashes, and applies the default', () => {
  assert.equal(normalizeBaseUrl(' http://localhost:8000/// '), 'http://localhost:8000');
  assert.equal(normalizeBaseUrl('   '), 'http://127.0.0.1:8000');
  assert.equal(normalizeBaseUrl('https://example.com/v1/'), 'https://example.com');
  assert.equal(normalizeBaseUrl('https://example.com/easel/v1'), 'https://example.com/easel');
  assert.throws(() => normalizeBaseUrl('file:///tmp/easel'), /must use http or https/);
});

test('buildHeaders only sets Authorization when an API key is present', () => {
  assert.deepEqual(buildHeaders(''), { 'Content-Type': 'application/json' });
  const headers = buildHeaders(' secret ');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization.split(' ').at(-1), 'secret');
  assert.ok(headers.Authorization.includes(' '));
  assert.match(headers.Authorization, /secret$/);
});

test('createGenerationPayload validates prompt and includes optional fields', () => {
  assert.throws(() => createGenerationPayload({ prompt: '   ' }), /Prompt is required/);
  assert.deepEqual(
    createGenerationPayload({
      prompt: '  A lighthouse at sunset  ',
      model: ' flux2-9b ',
      size: ' 1024x1024 ',
      n: '2',
    }),
    {
      prompt: 'A lighthouse at sunset',
      response_format: 'b64_json',
      model: 'flux2-9b',
      size: '1024x1024',
      n: 2,
    },
  );
});

test('extractImageSources supports both base64 and URL responses', () => {
  assert.deepEqual(
    extractImageSources({
      data: [
        { b64_json: 'abc123' },
        { url: 'http://localhost/image.png' },
      ],
    }),
    [
      'data:image/png;base64,abc123',
      'http://localhost/image.png',
    ],
  );
});

test('generateImages posts to Easel and returns image sources', async () => {
  const calls = [];
  const images = await generateImages({
    baseUrl: 'http://localhost:9000/',
    apiKey: 'token',
    prompt: 'Generate mountains',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { data: [{ b64_json: 'xyz' }] };
        },
      };
    },
  });

  assert.deepEqual(images, ['data:image/png;base64,xyz']);
  assert.equal(calls[0].url, 'http://localhost:9000/v1/images/generations');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization.split(' ').at(-1), 'token');
  assert.ok(calls[0].options.headers.Authorization.includes(' '));
  assert.match(calls[0].options.headers.Authorization, /token$/);
});

test('generateImages surfaces API errors', async () => {
  await assert.rejects(
    generateImages({
      baseUrl: 'http://localhost:9000',
      prompt: 'Generate mountains',
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        async json() {
          return { error: { message: 'invalid or missing API key' } };
        },
      }),
    }),
    /invalid or missing API key/,
  );
});

test('resultSummary handles singular and plural image counts', () => {
  assert.equal(resultSummary(1), 'Generated 1 image.');
  assert.equal(resultSummary(2), 'Generated 2 images.');
});

test('handleGenerationSubmit updates status and renders generated images', async () => {
  const document = createMockDocument();
  const resultsElement = createMockElement();
  const statusElement = createMockElement();
  const submitButton = createMockElement('button');

  const promptInput = createMockElement('textarea');
  promptInput.value = 'Golden hour city skyline';

  await handleGenerationSubmit({
    client: {
      async generateImages() {
        return ['data:image/png;base64,abc123'];
      },
    },
    document,
    baseUrlInput: createMockElement('input'),
    apiKeyInput: createMockElement('input'),
    modelInput: createMockElement('input'),
    sizeInput: createMockElement('input'),
    promptInput,
    submitButton,
    statusElement,
    resultsElement,
  });

  assert.equal(statusElement.textContent, 'Generated 1 image.');
  assert.equal(submitButton.disabled, false);
  assert.equal(resultsElement.children.length, 1);
  assert.equal(resultsElement.children[0].attributes.role, 'listitem');
  assert.equal(resultsElement.children[0].children[0].alt, 'Golden hour city skyline 1');
});
