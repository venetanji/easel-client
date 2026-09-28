const form = document.getElementById('generation-form');
const baseUrlInput = document.getElementById('base-url');
const apiKeyInput = document.getElementById('api-key');
const modelInput = document.getElementById('model');
const sizeInput = document.getElementById('size');
const promptInput = document.getElementById('prompt');
const submitButton = document.getElementById('submit');
const status = document.getElementById('status');
const results = document.getElementById('results');

baseUrlInput.value = window.easelClient.defaults.baseUrl;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function renderResults(images) {
  results.replaceChildren();

  images.forEach((source, index) => {
    const card = document.createElement('article');
    card.className = 'result-card';

    const image = document.createElement('img');
    image.src = source;
    image.alt = `${promptInput.value.trim() || 'Generated image'} ${index + 1}`;

    const link = document.createElement('a');
    link.href = source;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `Open image ${index + 1}`;

    card.append(image, link);
    results.append(card);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  results.replaceChildren();
  setStatus('Generating image…');

  try {
    const images = await window.easelClient.generateImages({
      baseUrl: baseUrlInput.value,
      apiKey: apiKeyInput.value,
      model: modelInput.value,
      size: sizeInput.value,
      prompt: promptInput.value,
    });

    renderResults(images);
    setStatus(`Generated ${images.length} image${images.length === 1 ? '' : 's'}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});
