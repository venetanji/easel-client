function setStatus(statusElement, message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle('error', isError);
  statusElement.setAttribute('role', isError ? 'alert' : 'status');
  statusElement.setAttribute('aria-live', isError ? 'assertive' : 'polite');
}

function resultSummary(count) {
  return `Generated ${count} image${count === 1 ? '' : 's'}.`;
}

function renderResults({ document, resultsElement, prompt, images }) {
  resultsElement.replaceChildren();

  images.forEach((source, index) => {
    const card = document.createElement('article');
    card.className = 'result-card';
    card.setAttribute('role', 'listitem');

    const image = document.createElement('img');
    image.src = source;
    image.alt = `${prompt.trim() || 'Generated image'} ${index + 1}`;

    const link = document.createElement('a');
    link.href = source;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `Open image ${index + 1}`;

    card.append(image, link);
    resultsElement.append(card);
  });
}

async function handleGenerationSubmit({
  client,
  document,
  baseUrlInput,
  apiKeyInput,
  modelInput,
  sizeInput,
  promptInput,
  submitButton,
  statusElement,
  resultsElement,
}) {
  submitButton.disabled = true;
  resultsElement.replaceChildren();
  setStatus(statusElement, 'Generating image…');

  try {
    const images = await client.generateImages({
      baseUrl: baseUrlInput.value,
      apiKey: apiKeyInput.value,
      model: modelInput.value,
      size: sizeInput.value,
      prompt: promptInput.value,
    });

    renderResults({ document, resultsElement, prompt: promptInput.value, images });
    setStatus(statusElement, resultSummary(images.length));
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Unable to generate images.', true);
  } finally {
    submitButton.disabled = false;
  }
}

function wireRenderer({ document, client }) {
  const form = document.getElementById('generation-form');
  const baseUrlInput = document.getElementById('base-url');
  const apiKeyInput = document.getElementById('api-key');
  const modelInput = document.getElementById('model');
  const sizeInput = document.getElementById('size');
  const promptInput = document.getElementById('prompt');
  const submitButton = document.getElementById('submit');
  const statusElement = document.getElementById('status');
  const resultsElement = document.getElementById('results');

  baseUrlInput.value = client.defaults.baseUrl;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await handleGenerationSubmit({
      client,
      document,
      baseUrlInput,
      apiKeyInput,
      modelInput,
      sizeInput,
      promptInput,
      submitButton,
      statusElement,
      resultsElement,
    });
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    handleGenerationSubmit,
    renderResults,
    resultSummary,
    setStatus,
    wireRenderer,
  };
}

if (typeof window !== 'undefined' && window.document && window.easelClient) {
  wireRenderer({ document: window.document, client: window.easelClient });
}
