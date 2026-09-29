function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.setAttribute('role', isError ? 'alert' : 'status');
  element.setAttribute('aria-live', isError ? 'assertive' : 'polite');
}

function modelOption(select, model, label) {
  const option = select.ownerDocument?.createElement('option') || { setAttribute() {} };
  option.value = model;
  option.textContent = label;
  return option;
}

function ensureLiteLLMModelOption(select, model) {
  const selected = typeof model === 'string' ? model.trim() : '';
  if (!selected) return;
  const options = Array.from(select.children || []);
  if (!options.some((option) => option.value === selected)) {
    const option = modelOption(select, selected, `${selected} (saved; not in catalog)`);
    select.replaceChildren(option, ...options);
  }
  select.value = selected;
}

async function refreshLiteLLMModels({ client, select, statusElement }) {
  const savedModel = select.value;
  setStatus(statusElement, 'Loading LiteLLM models…');
  try {
    const models = await client.listLiteLLMModels();
    const options = models.map((model) => modelOption(select, model.id, model.name === model.id ? model.id : `${model.name} — ${model.id}`));
    if (savedModel && !models.some((model) => model.id === savedModel)) {
      options.unshift(modelOption(select, savedModel, `${savedModel} (saved; not in catalog)`));
    }
    select.replaceChildren(...options);
    select.value = savedModel || models[0]?.id || '';
    setStatus(statusElement, `${models.length} LiteLLM model${models.length === 1 ? '' : 's'} loaded.`);
    return models;
  } catch (error) {
    ensureLiteLLMModelOption(select, savedModel);
    setStatus(statusElement, `Could not load LiteLLM models: ${error?.message || 'connection failed'}`, true);
    throw error;
  }
}

async function testLiteLLMConnection({ client, modelSelect, kind, statusElement, button, onSuccess, onFailure }) {
  const model = modelSelect.value;
  if (!model) {
    setStatus(statusElement, 'Choose a LiteLLM model first.', true);
    return;
  }
  if (!['chat', 'image'].includes(kind)) throw new Error('Unsupported LiteLLM test.');
  if (button) button.disabled = true;
  setStatus(statusElement, kind === 'chat' ? 'Testing text response…' : 'Testing image response…');
  try {
    const result = kind === 'chat'
      ? await client.testLiteLLMChat(model)
      : await client.testLiteLLMImage(model);
    setStatus(statusElement, result.message);
    onSuccess?.(kind, model, result);
    return result;
  } catch (error) {
    onFailure?.(kind, model, error);
    setStatus(statusElement, `Connection test failed: ${error?.message || 'request failed'}`, true);
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

function normalizeResultSource(value) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function resultSummary(count) {
  return `Generated ${count} image${count === 1 ? '' : 's'}.`;
}

const SKILL_STORAGE_KEY = 'easel-studio.skills.v1';
const KIT_STORAGE_KEY = 'easel-studio.canvas-kits.v1';
const OPEN_CANVAS_STORAGE_KEY = 'easel-studio.open-canvases.v1';
const PANEL_RATIO_STORAGE_KEY = 'easel-studio.panel-ratio.v1';
const WORKBENCH_WIDTH_STORAGE_KEY = 'easel-studio.workbench-width.v1';
const MAX_LOCAL_SKILLS = 64;
const MAX_SKILL_INSTRUCTIONS = 32_000;
const MAX_ACTIVE_SKILL_INSTRUCTIONS = 48_000;
const LOCAL_RUNTIME_KITS = Object.freeze(['canvas-2d', 'html-deck', 'three', 'phaser', 'matter', 'tone']);
const MAX_PENDING_ATTACHMENTS = 6;
const MAX_MEDIA_FILE_BYTES = 32 * 1024 * 1024;
const MEDIA_MIME_TYPES = Object.freeze({
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video',
});

function readLocalKits(storage = typeof localStorage === 'undefined' ? null : localStorage) {
  if (!storage) return ['canvas-2d'];
  try {
    const saved = JSON.parse(storage.getItem(KIT_STORAGE_KEY) || '["canvas-2d"]');
    return [...new Set(['canvas-2d', ...(Array.isArray(saved) ? saved.filter((kit) => LOCAL_RUNTIME_KITS.includes(kit)) : [])])];
  } catch {
    return ['canvas-2d'];
  }
}

function writeLocalKits(kits, storage = typeof localStorage === 'undefined' ? null : localStorage) {
  if (!storage) throw new Error('Local kit preferences are unavailable.');
  const selected = [...new Set(['canvas-2d', ...(Array.isArray(kits) ? kits.filter((kit) => LOCAL_RUNTIME_KITS.includes(kit)) : [])])];
  storage.setItem(KIT_STORAGE_KEY, JSON.stringify(selected));
  return selected;
}

function readOpenCanvasIds(storage) {
  if (!storage) return [];
  try {
    const ids = JSON.parse(storage.getItem(OPEN_CANVAS_STORAGE_KEY) || '[]');
    return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)))].slice(-16) : [];
  } catch {
    return [];
  }
}

function writeOpenCanvasIds(tabs, storage, activeId = '') {
  if (!storage) return;
  try {
    const ids = [...tabs.keys()];
    const activeIndex = ids.indexOf(activeId);
    if (activeIndex >= 0) ids.push(...ids.splice(activeIndex, 1));
    storage.setItem(OPEN_CANVAS_STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

function normalizeLocalSkills(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((skill) => {
    if (!skill || typeof skill.id !== 'string' || typeof skill.name !== 'string' || typeof skill.instructions !== 'string') return [];
    const id = skill.id.trim();
    const name = skill.name.trim().slice(0, 80);
    const instructions = skill.instructions.trim().slice(0, MAX_SKILL_INSTRUCTIONS);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !name || !instructions) return [];
    return [{ id, name, instructions, enabled: skill.enabled === true }];
  }).slice(0, MAX_LOCAL_SKILLS);
}

function readLocalSkills(storage = typeof localStorage === 'undefined' ? null : localStorage) {
  if (!storage) return [];
  try {
    return normalizeLocalSkills(JSON.parse(storage.getItem(SKILL_STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function writeLocalSkills(skills, storage = typeof localStorage === 'undefined' ? null : localStorage) {
  if (!storage) throw new Error('Local skill storage is unavailable.');
  const normalized = normalizeLocalSkills(skills);
  storage.setItem(SKILL_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function parseSkillMarkdown(markdown, fileName = '') {
  const source = typeof markdown === 'string' ? markdown.trim() : '';
  if (!source || source.length > MAX_SKILL_INSTRUCTIONS + 2_000) throw new Error('Skill file is empty or too large.');
  const frontMatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const frontMatterName = frontMatter?.[1].match(/^name\s*:\s*(["']?)(.*?)\1\s*$/im)?.[2]?.trim();
  const title = frontMatter?.[1].match(/^title\s*:\s*(["']?)(.*?)\1\s*$/im)?.[2]?.trim();
  const body = frontMatter ? source.slice(frontMatter[0].length).trim() : source;
  const fallbackName = String(fileName).replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  const name = (frontMatterName || title || fallbackName || 'Imported skill').slice(0, 80);
  if (!body) throw new Error('Skill file has no instructions to import.');
  if (body.length > MAX_SKILL_INSTRUCTIONS) throw new Error(`Skill instructions must be ${MAX_SKILL_INSTRUCTIONS} characters or fewer.`);
  return { name, instructions: body };
}

function createSkillId() {
  const random = Math.random().toString(36).slice(2, 9);
  return `skill-${Date.now().toString(36)}-${random}`;
}

function renderSkillList({ document, listElement, emptyElement, skills, onToggle, onEdit, onRemove }) {
  const rows = normalizeLocalSkills(skills).map((skill) => {
    const row = document.createElement('div');
    row.className = 'skill-row';
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'skill-enabled';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = skill.enabled;
    checkbox.setAttribute('aria-label', `Use ${skill.name} in chat`);
    checkbox.addEventListener('change', () => onToggle?.(skill.id, checkbox.checked));
    toggleLabel.append(checkbox);
    const name = document.createElement('span');
    name.className = 'skill-row-name';
    name.textContent = skill.name;
    const edit = createButton(document, 'Edit', 'button quiet small', () => onEdit?.(skill));
    edit.setAttribute('aria-label', `Edit ${skill.name}`);
    const remove = createButton(document, 'Remove', 'button quiet small', () => onRemove?.(skill));
    remove.setAttribute('aria-label', `Remove ${skill.name}`);
    row.append(toggleLabel, name, edit, remove);
    return row;
  });
  listElement.replaceChildren(...rows);
  if (emptyElement) emptyElement.hidden = rows.length > 0;
  return rows.length;
}

function renderSkillCount(element, skills) {
  const active = normalizeLocalSkills(skills).filter((skill) => skill.enabled).length;
  element.textContent = String(active);
  element.setAttribute('aria-label', `${active} active skill${active === 1 ? '' : 's'}`);
  return active;
}

async function handleGenerationSubmit({ client, document, promptInput, submitButton, statusElement, resultsElement, ...options }) {
  submitButton.disabled = true;
  setStatus(statusElement, 'Generating images…');
  try {
    const images = await client.generateImages({
      baseUrl: options.baseUrlInput?.value,
      apiKey: options.apiKeyInput?.value,
      model: options.modelInput?.value,
      size: options.sizeInput?.value,
      prompt: promptInput.value,
    });
    const cards = images.flatMap((source, index) => {
      const safeSource = normalizeResultSource(source);
      if (!safeSource) return [];
      const card = document.createElement('article');
      card.className = 'result-card';
      card.setAttribute('role', 'listitem');
      const image = document.createElement('img');
      image.src = safeSource;
      image.alt = `${promptInput.value.trim()} ${index + 1}`;
      card.append(image);
      return [card];
    });
    resultsElement.replaceChildren(...cards);
    setStatus(statusElement, resultSummary(cards.length));
    return cards.length;
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Image generation failed.', true);
    throw error;
  } finally {
    submitButton.disabled = false;
  }
}

function renderAssistantAssetLinks(document, content, text, assetPreviews, pendingAssetCaptions) {
  const assetLinks = /!?\[([^\]\r\n]{1,240})\]\(asset:\/\/([^\s)]{1,256})\)/gi;
  let cursor = 0;
  const resolvedAssetIds = [];
  for (const match of text.matchAll(assetLinks)) {
    const assetId = match[2].toLowerCase();
    const isValidAssetId = /^[a-f0-9]{32}$/.test(assetId);
    const preview = isValidAssetId ? assetPreviews.get(assetId) : null;
    content.append(document.createTextNode(text.slice(cursor, match.index)));
    const label = match[1].trim() || 'Generated image';
    if (preview) {
      preview.image.alt = label;
      preview.caption.textContent = label;
      resolvedAssetIds.push(assetId);
    } else {
      // Keep the description readable if the image event reaches the renderer later.
      content.append(document.createTextNode(label));
      if (isValidAssetId) pendingAssetCaptions?.set(assetId, label);
    }
    cursor = match.index + match[0].length;
  }
  content.append(document.createTextNode(text.slice(cursor)));
  return { resolvedAssetIds, hasText: content.textContent.trim().length > 0 };
}

function appendImagePreviewMessage(document, messagesElement, event, onAddToCanvas) {
  const shouldFollow = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 56;
  const message = document.createElement('article');
  message.className = 'message assistant message-media';
  message.dataset.assetId = event.assetId;
  const figure = document.createElement('figure');
  figure.className = 'message-asset-preview';
  const image = document.createElement('img');
  image.src = `data:${event.mimeType};base64,${event.data}`;
  image.alt = 'Generated image';
  const caption = document.createElement('figcaption');
  caption.textContent = 'Generated image';
  figure.append(image, caption);
  const add = createButton(document, 'Add to canvas', 'message-asset-add', () => onAddToCanvas?.(event.assetId, add));
  add.setAttribute('aria-label', 'Add generated image to canvas');
  message.append(figure, add);
  messagesElement.append(message);
  if (shouldFollow) messagesElement.scrollTop = messagesElement.scrollHeight;
  return { image, caption, message, addButton: add };
}

function appendTextMessage(document, messagesElement, role, text, options = {}) {
  const shouldFollow = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 56;
  const message = document.createElement('article');
  message.className = `message ${role}`;
  if (role === 'user' && options.mode === 'image') message.setAttribute('data-mode', 'image');
  let resolvedAssetIds = [];
  if (role === 'assistant' && options.assetPreviews instanceof Map) {
    const content = document.createElement('div');
    content.className = 'message-content';
    const rendered = renderAssistantAssetLinks(
      document,
      content,
      text,
      options.assetPreviews,
      options.pendingAssetCaptions
    );
    resolvedAssetIds = rendered.resolvedAssetIds;
    if (!rendered.hasText && resolvedAssetIds.length > 0) {
      if (shouldFollow) messagesElement.scrollTop = messagesElement.scrollHeight;
      return null;
    }
    message.append(content);
  } else if (role === 'user' && Array.isArray(options.attachments) && options.attachments.length > 0) {
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;
    message.append(content);
    const attachmentList = document.createElement('div');
    attachmentList.className = 'message-attachments';
    for (const attachment of options.attachments) {
      if (typeof attachment?.previewUrl !== 'string' || !attachment.previewUrl.startsWith('blob:')) continue;
      const figure = document.createElement('figure');
      figure.className = 'message-attachment';
      const tag = attachment.type === 'image' ? 'img' : attachment.type === 'audio' ? 'audio' : 'video';
      const preview = document.createElement(tag);
      preview.src = attachment.previewUrl;
      if (attachment.type === 'image') preview.alt = attachment.name;
      else {
        preview.controls = true;
        preview.preload = 'metadata';
      }
      const caption = document.createElement('figcaption');
      caption.textContent = attachment.name;
      figure.append(preview, caption);
      attachmentList.append(figure);
    }
    if (attachmentList.children.length) message.append(attachmentList);
  } else {
    message.textContent = text;
  }
  messagesElement.append(message);
  if (role === 'assistant' && typeof options.copyText === 'function') {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const copy = createButton(document, 'Copy', '', async () => {
      try {
        await options.copyText(text);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy failed';
      }
    });
    copy.setAttribute('aria-label', 'Copy response');
    actions.append(copy);
    messagesElement.append(actions);
  }
  if (shouldFollow) messagesElement.scrollTop = messagesElement.scrollHeight;
  return message;
}

function createWelcomeMessage(document, onPrompt) {
  const article = document.createElement('article');
  article.className = 'message assistant message-welcome';
  const author = document.createElement('div');
  author.className = 'message-author';
  author.textContent = 'EASEL';
  const welcome = document.createElement('div');
  welcome.className = 'welcome-copy';
  const title = document.createElement('strong');
  title.textContent = 'What are we making?';
  const description = document.createElement('p');
  description.textContent = 'Describe an image to begin, or ask for help shaping a visual direction. Add a skill when you want a reusable creative recipe.';
  welcome.append(title, description);
  const suggestions = document.createElement('div');
  suggestions.className = 'prompt-suggestions';
  suggestions.setAttribute('aria-label', 'Prompt starters');
  for (const [label, prompt] of [
    ['Make a still life', 'A still life of citrus and glass, soft morning light, editorial photography'],
    ['Shape a campaign', 'Create a visual direction for a warm, tactile product launch campaign'],
  ]) {
    const button = createButton(document, label, 'prompt-suggestion', () => onPrompt?.(prompt));
    suggestions.append(button);
  }
  article.append(author, welcome, suggestions);
  return article;
}

function toolActivityLabel(name) {
  const labels = {
    generate_image: 'Creating an image with Easel…',
    list_models: 'Checking available image models…',
    capture_canvas_screenshot: 'Capturing the canvas…',
    present_canvas: 'Opening your composition…',
    create_canvas: 'Creating your canvas…',
    inspect_canvas: 'Reviewing the canvas…',
    execute_canvas_javascript: 'Refining the composition…',
    add_image_to_canvas: 'Placing the image on canvas…',
  };
  return labels[name] || 'Working on your request…';
}

function createButton(document, text, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

function renderAssetLibrary({ document, listElement, emptyElement, assets, onAdd, canAdd = true }) {
  const items = Array.isArray(assets) ? assets : [];
  const cards = items.flatMap((asset) => {
    if (!asset || typeof asset.id !== 'string' || !/^[a-f0-9]{32}$/.test(asset.id)) return [];
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) return [];
    if (typeof asset.thumbnail !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(asset.thumbnail)) return [];
    const card = document.createElement('article');
    card.className = 'media-item';
    const preview = document.createElement('div');
    preview.className = 'media-thumb';
    const image = document.createElement('img');
    image.src = asset.thumbnail;
    image.alt = `Saved media ${asset.id.slice(0, 8)}`;
    image.loading = 'lazy';
    preview.append(image);
    const label = document.createElement('div');
    label.className = 'media-label';
    label.textContent = `Image ${asset.id.slice(0, 8)}`;
    const add = createButton(document, 'Add to canvas', 'media-add', () => onAdd?.(asset.id));
    add.disabled = !canAdd;
    if (!canAdd) add.title = 'Open or create a canvas first.';
    card.append(preview, label, add);
    return [card];
  });
  listElement.replaceChildren(...cards);
  emptyElement.hidden = cards.length > 0;
}

function renderCanvasLibrary({ document, listElement, emptyElement, canvases, onOpen, onExport }) {
  const items = Array.isArray(canvases) ? canvases : [];
  const rows = items.flatMap((canvas) => {
    if (!canvas || typeof canvas.id !== 'string' || !/^[a-f0-9]{32}$/.test(canvas.id)) return [];
    const row = document.createElement('div');
    row.className = 'canvas-row';
    const open = createButton(document, canvas.title || 'Easel Canvas', 'canvas-open', () => onOpen?.(canvas));
    const exportButton = createButton(document, 'Export', 'canvas-export', () => onExport?.(canvas.id));
    row.append(open, exportButton);
    return [row];
  });
  listElement.replaceChildren(...rows);
  emptyElement.hidden = rows.length > 0;
}

async function addAssetToCanvas({ client, assetId, statusElement, options }) {
  setStatus(statusElement, 'Adding image to canvas…');
  try {
    const result = await client.addAssetToCanvas(assetId, options);
    setStatus(statusElement, result?.added === false
      ? 'The canvas already has content, so the image was not added automatically.'
      : 'Image added to canvas.');
    return result;
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Could not add image to canvas.', true);
    throw error;
  }
}

async function exportCanvas({ client, canvasId, statusElement }) {
  setStatus(statusElement, 'Choose where to export the HTML…');
  try {
    const result = await client.exportCanvas(canvasId);
    setStatus(statusElement, result?.canceled ? 'Export canceled.' : `Exported ${result?.fileName || 'canvas.html'}.`);
    return result;
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Could not export canvas.', true);
    throw error;
  }
}

async function createCanvas({ client, title, statusElement }) {
  setStatus(statusElement, 'Creating canvas…');
  try {
    const canvas = await client.createCanvas(title);
    setStatus(statusElement, `Created ${canvas.title}.`);
    return canvas;
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Could not create canvas.', true);
    throw error;
  }
}

async function undoCanvas({ client, canvasId, statusElement, onCanvasChange }) {
  if (!canvasId) {
    setStatus(statusElement, 'Open a canvas before undoing changes.', true);
    return null;
  }
  setStatus(statusElement, 'Undoing last canvas change…');
  try {
    const result = await client.undoCanvas(canvasId);
    if (result?.undone) {
      onCanvasChange?.(result);
      setStatus(statusElement, `Undid last change to ${result.title || 'canvas'}.`);
    } else {
      onCanvasChange?.(result);
      setStatus(statusElement, 'Nothing to undo.');
    }
    return result;
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Could not undo canvas change.', true);
    throw error;
  }
}

function renderAgentEvent({ document, messagesElement, imagesElement, event, statusElement, activityElement, activityLabel, copyText, assetPreviews, pendingAssetCaptions, onLibraryRefresh, onCanvasChange, onCapabilities, onAddToCanvas, onImageReady }) {
  if (!event || typeof event.type !== 'string') return;
  if (event.type === 'capabilities') {
    onCapabilities?.(Array.isArray(event.tools) ? event.tools : []);
    return;
  }
  if (event.type === 'assistant' && typeof event.text === 'string' && event.text) {
    appendTextMessage(document, messagesElement, 'assistant', event.text, {
      copyText,
      assetPreviews,
      pendingAssetCaptions,
    });
    if (activityElement) activityElement.hidden = true;
    setStatus(statusElement, '');
    return;
  }
  if (event.type === 'tool-start') {
    if (activityLabel) activityLabel.textContent = toolActivityLabel(event.name);
    if (activityElement) activityElement.hidden = false;
    setStatus(statusElement, '');
    return;
  }
  if (event.type === 'image') {
    if (typeof event.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data)) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(event.mimeType)) return;
    if (messagesElement && assetPreviews instanceof Map && /^[a-f0-9]{32}$/i.test(event.assetId || '')) {
      const assetId = event.assetId.toLowerCase();
      const preview = appendImagePreviewMessage(document, messagesElement, event, onAddToCanvas);
      const caption = pendingAssetCaptions?.get(assetId);
      if (caption) {
        preview.image.alt = caption;
        preview.caption.textContent = caption;
        pendingAssetCaptions.delete(assetId);
      }
      assetPreviews.set(assetId, preview);
      onImageReady?.({ assetId, preview });
    } else if (imagesElement) {
      const card = document.createElement('figure');
      card.className = 'image-result';
      const image = document.createElement('img');
      image.src = `data:${event.mimeType};base64,${event.data}`;
      image.alt = 'Image generated by Easel';
      card.append(image);
      imagesElement.append(card);
    }
    onLibraryRefresh?.();
    return;
  }
  if (event.type === 'canvas') {
    onCanvasChange?.(event);
    setStatus(statusElement, `Canvas updated: ${String(event.title || 'Easel Canvas')}`);
    return;
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    if (activityElement) activityElement.hidden = true;
    setStatus(statusElement, event.message, true);
  }
}

async function handleSettingsSubmit({ client, fields, statusElement }) {
  setStatus(statusElement, 'Saving settings…');
  try {
    const result = await client.saveSettings({
      easelBaseUrl: fields.easelBaseUrl.value,
      easelApiKey: fields.easelApiKey.value,
      clearEaselApiKey: fields.clearEaselApiKey.checked === true,
      litellmBaseUrl: fields.litellmBaseUrl.value,
      litellmModel: fields.litellmModel.value,
      litellmApiKey: fields.litellmApiKey.value,
      clearLiteLLMApiKey: fields.clearLiteLLMApiKey.checked === true,
    });
    fields.easelApiKey.value = '';
    fields.litellmApiKey.value = '';
    fields.clearEaselApiKey.checked = false;
    fields.clearLiteLLMApiKey.checked = false;
    fields.easelApiKey.placeholder = result.hasEaselApiKey ? 'Saved securely' : 'Optional';
    fields.litellmApiKey.placeholder = result.hasLiteLLMApiKey ? 'Saved securely' : 'Optional';
    setStatus(statusElement, 'Settings saved.');
    return result;
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Could not save settings.', true);
    throw error;
  }
}

async function handleChatSubmit({ client, document, input, button, statusElement, messagesElement, mode = 'chat', size = '1024x1024', skills = [], kits = ['canvas-2d'], attachments = [], activityElement, activityLabel, newChatButton, modeButtons, copyText }) {
  const text = input.value.trim();
  if (!text && attachments.length === 0) return;
  const inputWasDisabled = input.disabled;
  button.disabled = true;
  input.disabled = true;
  if (newChatButton) newChatButton.disabled = true;
  for (const modeButton of modeButtons || []) modeButton.disabled = true;
  const userMessage = appendTextMessage(document, messagesElement, 'user', text || 'Review the attached media.', { mode, attachments });
  if (activityLabel) activityLabel.textContent = mode === 'image' ? 'Preparing your image…' : 'Thinking through the next step…';
  if (activityElement) activityElement.hidden = false;
  setStatus(statusElement, '');
  input.value = '';
  try {
    const message = text || 'Review the attached media and respond with what you find.';
    const result = await client.sendMessage(message, {
      mode,
      size,
      skills,
      kits,
      attachments: attachments.map(({ type, name, mimeType, data, frames }) => ({ type, name, mimeType, data, frames })),
    });
    setStatus(statusElement, '');
    return result;
  } catch (error) {
    if (!input.value.trim()) input.value = text;
    userMessage?.remove?.();
    if (activityElement) activityElement.hidden = true;
    const detail = error instanceof Error ? error.message : 'The message could not be sent.';
    const audioHint = attachments.some((attachment) => attachment.type === 'audio')
      ? 'The selected model may not support audio input. '
      : '';
    setStatus(statusElement, `${audioHint}${detail}`, true);
    throw error;
  } finally {
    button.disabled = false;
    input.disabled = inputWasDisabled;
    if (newChatButton) newChatButton.disabled = false;
    for (const modeButton of modeButtons || []) modeButton.disabled = modeButton.dataset.mode === 'video';
    if (activityElement) activityElement.hidden = true;
  }
}

function resolveMediaType(file) {
  const mimeType = file?.type?.toLowerCase() || '';
  if (MEDIA_MIME_TYPES[mimeType]) return { mimeType: mimeType === 'audio/x-wav' ? 'audio/wav' : mimeType, type: MEDIA_MIME_TYPES[mimeType] };
  const extension = String(file?.name || '').split('.').at(-1).toLowerCase();
  const byExtension = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  }[extension];
  return byExtension ? { mimeType: byExtension, type: MEDIA_MIME_TYPES[byExtension] } : null;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error('The selected media could not be read.'));
      else resolve(result.slice(comma + 1));
    }, { once: true });
    reader.addEventListener('error', () => reject(new Error('The selected media could not be read.')), { once: true });
    reader.readAsDataURL(file);
  });
}

async function sampleVideoFrames(document, file, previewUrl) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'metadata';
  video.src = previewUrl;
  const waitForVideoEvent = (eventName, timeoutMessage, timeoutMs) => new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('This video could not be decoded.')); };
    timer = setTimeout(() => { cleanup(); reject(new Error(timeoutMessage)); }, timeoutMs);
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
  try {
    await waitForVideoEvent('loadedmetadata', 'Video metadata took too long to load.', 15_000);
    if (!Number.isFinite(video.duration) || !video.videoWidth || !video.videoHeight) throw new Error('Video metadata is incomplete.');
    if (video.duration > 3_600) throw new Error('Video files must be 60 minutes or shorter.');
    const frameCount = Math.min(6, Math.max(1, Math.ceil(video.duration / 4)));
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Video frames could not be prepared.');
    const frames = [];
    for (let index = 0; index < frameCount; index += 1) {
      const timestamp = video.duration * (index + 0.5) / frameCount;
      if (Math.abs(video.currentTime - timestamp) > 0.01) {
        const seeked = waitForVideoEvent('seeked', 'Video frame extraction timed out.', 10_000);
        video.currentTime = timestamp;
        await seeked;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ timestamp: Number(timestamp.toFixed(2)), data: canvas.toDataURL('image/jpeg', 0.72).split(',')[1] });
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

function submitChatWithShortcut(event, form, button) {
  if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return false;
  event.preventDefault();
  if (!button.disabled) form.requestSubmit();
  return true;
}

function wireRenderer({ document, client }) {
  const fields = {
    easelBaseUrl: document.getElementById('easel-url'),
    easelApiKey: document.getElementById('easel-key'),
    clearEaselApiKey: document.getElementById('clear-easel-key'),
    litellmBaseUrl: document.getElementById('litellm-url'),
    litellmModel: document.getElementById('litellm-model'),
    litellmApiKey: document.getElementById('litellm-key'),
    clearLiteLLMApiKey: document.getElementById('clear-litellm-key'),
  };
  const settingsForm = document.getElementById('settings-form');
  const settingsStatus = document.getElementById('settings-status');
  const settingsDialog = document.getElementById('settings-dialog');
  const settingsSections = [
    { id: 'connections', tab: document.getElementById('settings-tab-connections'), section: document.getElementById('settings-connections') },
    { id: 'skills', tab: document.getElementById('settings-tab-skills'), section: document.getElementById('settings-skills') },
    { id: 'kits', tab: document.getElementById('settings-tab-kits'), section: document.getElementById('settings-kits') },
  ];
  const newCanvasDialog = document.getElementById('new-canvas-dialog');
  const skillForm = document.getElementById('skill-form');
  const skillNameInput = document.getElementById('skill-name');
  const skillInstructionsInput = document.getElementById('skill-instructions');
  const skillEditorTitle = document.getElementById('skill-editor-title');
  const skillSaveButton = document.getElementById('skill-save');
  const skillStatus = document.getElementById('skill-status');
  const skillList = document.getElementById('skills-list');
  const skillEmpty = document.getElementById('skills-empty');
  const skillCount = document.getElementById('skill-count');
  const skillFileInput = document.getElementById('skill-import');
  const installedSkillList = document.getElementById('installed-skills-list');
  const installedSkillCount = document.getElementById('installed-skill-count');
  const newCanvasForm = document.getElementById('new-canvas-form');
  const newCanvasName = document.getElementById('new-canvas-name');
  const newCanvasSubmit = document.getElementById('new-canvas-submit');
  const chatForm = document.getElementById('chat-form');
  const messageInput = document.getElementById('message');
  const sendButton = document.getElementById('send');
  const sendLabel = document.getElementById('send-label');
  const mediaFileInput = document.getElementById('media-files');
  const attachMediaButton = document.getElementById('attach-media');
  const attachmentStrip = document.getElementById('attachment-strip');
  const composer = chatForm.querySelector('.composer');
  const statusElement = document.getElementById('status');
  const activityElement = document.getElementById('agent-activity');
  const activityLabel = document.getElementById('agent-activity-label');
  const messagesElement = document.getElementById('messages');
  const mediaList = document.getElementById('media-list');
  const mediaEmpty = document.getElementById('media-empty');
  const canvasesList = document.getElementById('canvases-list');
  const canvasesEmpty = document.getElementById('canvases-empty');
  const mediaContent = document.getElementById('media-content');
  const canvasesContent = document.getElementById('canvases-content');
  const libraryTitle = document.getElementById('library-title');
  const navExplorer = document.getElementById('nav-explorer');
  const navMedia = document.getElementById('nav-media');
  const activitySettings = document.getElementById('settings-open');
  const kitOptions = [...document.querySelectorAll('[data-kit]')];
  const leftColumn = document.querySelector('.left-column');
  const studio = document.querySelector('.studio');
  const libraryPanel = document.querySelector('.library');
  const conversationPanel = document.querySelector('.conversation');
  const splitter = document.getElementById('panel-splitter');
  const workbenchSplitter = document.getElementById('workbench-splitter');
  const openCanvasTabsElement = document.getElementById('open-canvas-tabs');
  const canvasHost = document.getElementById('canvas-host');
  const canvasEmpty = document.getElementById('canvas-empty');
  const canvasTitle = document.getElementById('canvas-title');
  const canvasState = document.getElementById('canvas-state');
  const canvasStateDot = document.getElementById('canvas-state-dot');
  const exportCurrentButton = document.getElementById('export-current');
  const undoCanvasButton = document.getElementById('canvas-undo');
  const modelLabel = document.getElementById('model-label');
  const connectionDot = document.getElementById('connection-dot');
  const imageSizeWrap = document.getElementById('image-size-wrap');
  const imageSize = document.getElementById('image-size');
  const composerHelp = document.getElementById('composer-help');
  const newChatButton = document.getElementById('new-chat');
  const modeButtons = [...document.querySelectorAll('.mode-button')];
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  const copyText = typeof navigator !== 'undefined' && navigator.clipboard?.writeText
    ? (value) => navigator.clipboard.writeText(value)
    : null;
  let activeCanvasId = '';
  const openCanvasTabs = new Map();
  let canvasTabsRestored = false;
  let mode = document.getElementById('image-mode').getAttribute('aria-pressed') === 'true' ? 'image' : 'chat';
  let chatBusy = false;
  const assetPreviews = new Map();
  const pendingAssetCaptions = new Map();
  let pendingAttachments = [];
  const messageObjectUrls = new Set();
  let localSkills = readLocalSkills(storage);
  let localKits = readLocalKits(storage);
  let installedSkills = [];
  let modelProbeState = { model: '', chat: false, image: false };
  let editingSkillId = '';

  function readStoredValue(key) {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  function applyPanelRatio(value) {
    const ratio = Math.max(20, Math.min(75, Number(value) || 31));
    leftColumn.style.setProperty('--library-ratio', `${ratio}fr`);
    leftColumn.style.setProperty('--chat-ratio', `${100 - ratio}fr`);
    splitter.setAttribute('aria-valuenow', String(Math.round(ratio)));
    try {
      storage?.setItem(PANEL_RATIO_STORAGE_KEY, String(ratio));
    } catch {}
  }

  function workbenchWidthLimits() {
    const available = studio.getBoundingClientRect().width - 42 - 12 - 36 - 28 - 300;
    return { min: 280, max: Math.max(280, Math.min(580, Math.floor(available))) };
  }

  function applyWorkbenchWidth(value) {
    const limits = workbenchWidthLimits();
    const width = Math.max(limits.min, Math.min(limits.max, Number(value) || 360));
    studio.style.setProperty('--left-column-width', `${width}px`);
    workbenchSplitter.setAttribute('aria-valuemin', String(limits.min));
    workbenchSplitter.setAttribute('aria-valuemax', String(limits.max));
    workbenchSplitter.setAttribute('aria-valuenow', String(Math.round(width)));
    try {
      storage?.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(width));
    } catch {}
  }

  function selectLibraryView(view) {
    const showMedia = view === 'media';
    mediaContent.hidden = !showMedia;
    canvasesContent.hidden = showMedia;
    navExplorer.setAttribute('aria-pressed', String(!showMedia));
    navMedia.setAttribute('aria-pressed', String(showMedia));
    libraryTitle.textContent = showMedia ? 'Media' : 'Explorer';
    libraryPanel.setAttribute('aria-label', showMedia ? 'Media library' : 'Project explorer');
  }

  function selectSettingsSection(id) {
    for (const item of settingsSections) {
      const active = item.id === id;
      item.tab.setAttribute('aria-selected', String(active));
      item.section.hidden = !active;
    }
  }

  function openSettings(id = 'connections', focusTarget = null) {
    selectSettingsSection(id);
    activitySettings.setAttribute('aria-pressed', 'true');
    if (!settingsDialog.open) openDialog(settingsDialog, focusTarget);
    else focusTarget?.focus();
  }

  function setPanelCollapsed(panelName, collapsed) {
    const panel = panelName === 'library' ? libraryPanel : conversationPanel;
    const button = document.getElementById(panelName === 'library' ? 'library-collapse' : 'chat-collapse');
    const label = panelName === 'library' ? (navMedia.getAttribute('aria-pressed') === 'true' ? 'media' : 'explorer') : 'chat';
    panel.classList.toggle('is-collapsed', collapsed);
    leftColumn.classList.toggle(`is-${panelName}-collapsed`, collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${label}`);
    button.title = `${collapsed ? 'Expand' : 'Collapse'} ${label}`;
    try {
      storage?.setItem(`easel-studio.${panelName}-collapsed.v1`, String(collapsed));
    } catch {}
    updateCanvasBounds();
  }

  function updateCanvasBounds() {
    if (!canvasHost || typeof client.setCanvasBounds !== 'function') return;
    if ([settingsDialog, newCanvasDialog].some((dialog) => dialog.open)) {
      client.setCanvasBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    if (!activeCanvasId) {
      client.setCanvasBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const rect = canvasHost.getBoundingClientRect();
    client.setCanvasBounds({
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height),
    });
  }

  function openDialog(dialog, focusTarget) {
    client.setCanvasBounds?.({ x: 0, y: 0, width: 0, height: 0 });
    dialog.showModal();
    focusTarget?.focus();
  }

  function updateSendState() {
    sendButton.disabled = chatBusy || (!messageInput.value.trim() && pendingAttachments.length === 0);
    messageInput.disabled = chatBusy;
    attachMediaButton.disabled = chatBusy;
    mediaFileInput.disabled = chatBusy;
    attachmentStrip.querySelectorAll('button').forEach((button) => { button.disabled = chatBusy; });
    newChatButton.disabled = chatBusy;
    for (const button of modeButtons) button.disabled = chatBusy || button.dataset.mode === 'video';
  }

  function renderPendingAttachments() {
    const chips = pendingAttachments.map((attachment) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      if (attachment.type === 'image') {
        const image = document.createElement('img');
        image.src = attachment.previewUrl;
        image.alt = '';
        chip.append(image);
      } else {
        const kind = document.createElement('span');
        kind.className = 'attachment-kind';
        kind.textContent = attachment.type.toUpperCase();
        chip.append(kind);
      }
      const name = document.createElement('span');
      name.className = 'attachment-chip-name';
      name.textContent = attachment.name;
      const remove = document.createElement('button');
      remove.className = 'attachment-remove';
      remove.type = 'button';
      remove.textContent = 'x';
      remove.setAttribute('aria-label', `Remove ${attachment.name}`);
      remove.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter((item) => item !== attachment);
        URL.revokeObjectURL(attachment.previewUrl);
        messageObjectUrls.delete(attachment.previewUrl);
        renderPendingAttachments();
        updateSendState();
      });
      chip.append(name, remove);
      return chip;
    });
    attachmentStrip.replaceChildren(...chips);
    attachmentStrip.hidden = chips.length === 0;
  }

  function addAttachmentFiles(files) {
    if (chatBusy) return;
    const errors = [];
    for (const file of Array.from(files || [])) {
      const media = resolveMediaType(file);
      if (!media) {
        errors.push(`${file.name || 'A file'} is not a supported image, audio, or video format.`);
        continue;
      }
      if (!file.size || file.size > MAX_MEDIA_FILE_BYTES) {
        errors.push(`${file.name || 'A file'} must be under 32 MiB.`);
        continue;
      }
      if (pendingAttachments.length >= MAX_PENDING_ATTACHMENTS) {
        errors.push(`Attach up to ${MAX_PENDING_ATTACHMENTS} files per message.`);
        break;
      }
      const previewUrl = URL.createObjectURL(file);
      messageObjectUrls.add(previewUrl);
      pendingAttachments.push({ file, name: file.name || 'Media file', ...media, previewUrl });
    }
    renderPendingAttachments();
    updateSendState();
    if (errors.length) setStatus(statusElement, errors[0], true);
    else if (files?.length) setStatus(statusElement, 'Attachments ready. Add a note or send them as-is.');
  }

  async function preparePendingAttachments() {
    const prepared = [];
    for (const attachment of pendingAttachments) {
      const item = {
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        previewUrl: attachment.previewUrl,
      };
      if (attachment.type === 'video') {
        setStatus(statusElement, `Sampling frames from ${attachment.name}…`);
        item.frames = await sampleVideoFrames(document, attachment.file, attachment.previewUrl);
      } else {
        item.data = await readFileAsBase64(attachment.file);
      }
      prepared.push(item);
    }
    return prepared;
  }

  function setMode(nextMode) {
    if (!['chat', 'image'].includes(nextMode)) return;
    mode = nextMode;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    imageSizeWrap.hidden = mode !== 'image';
    messageInput.placeholder = mode === 'image'
      ? 'Describe the image you want to create…'
      : 'Ask Easel a question or describe a canvas edit…';
    composerHelp.textContent = mode === 'image'
      ? 'Easel will create an image in this shape · Enter to send · Ctrl+Enter for a new line'
      : 'Ask for a direction or refine the open canvas · Enter to send · Ctrl+Enter for a new line';
    sendLabel.textContent = mode === 'image' ? 'Create' : 'Send';
  }

  function refreshSkillUi() {
    renderSkillList({
      document,
      listElement: skillList,
      emptyElement: skillEmpty,
      skills: localSkills,
      onToggle: (id, enabled) => {
        const activeCount = localSkills.filter((skill) => skill.enabled).length;
        if (enabled && activeCount >= 8) {
          setStatus(skillStatus, 'Use up to 8 skills in a single request.', true);
          refreshSkillUi();
          return;
        }
        const nextSkills = localSkills.map((skill) => skill.id === id ? { ...skill, enabled } : skill);
        const activeInstructions = nextSkills.filter((skill) => skill.enabled).reduce((total, skill) => total + skill.instructions.length, 0);
        if (activeInstructions > MAX_ACTIVE_SKILL_INSTRUCTIONS) {
          setStatus(skillStatus, `Keep active skill instructions under ${MAX_ACTIVE_SKILL_INSTRUCTIONS} characters in total.`, true);
          refreshSkillUi();
          return;
        }
        try {
          localSkills = writeLocalSkills(nextSkills, storage);
          setStatus(skillStatus, 'Skill selection saved.');
        } catch (error) {
          setStatus(skillStatus, error?.message || 'Could not save skill selection.', true);
        }
        refreshSkillUi();
      },
      onEdit: (skill) => {
        editingSkillId = skill.id;
        skillNameInput.value = skill.name;
        skillInstructionsInput.value = skill.instructions;
        skillEditorTitle.textContent = 'Edit skill';
        skillSaveButton.textContent = 'Save changes';
        setStatus(skillStatus, '');
        skillNameInput.focus();
      },
      onRemove: (skill) => {
        if (!document.defaultView.confirm(`Remove “${skill.name}” from this device?`)) return;
        try {
          localSkills = writeLocalSkills(localSkills.filter((item) => item.id !== skill.id), storage);
          if (editingSkillId === skill.id) clearSkillEditor();
          setStatus(skillStatus, 'Skill removed.');
          refreshSkillUi();
        } catch (error) {
          setStatus(skillStatus, error?.message || 'Could not remove the skill.', true);
        }
      },
    });
    const activeCount = renderSkillCount(skillCount, localSkills);
    const composerSkills = document.getElementById('composer-skills');
    composerSkills.textContent = activeCount ? `Skills · ${activeCount} active` : 'Use skills';
  }

  function renderInstalledSkillCatalog() {
    const rows = installedSkills.map((skill) => {
      const row = document.createElement('div');
      row.className = 'installed-skill-row';
      const name = document.createElement('span');
      name.className = 'installed-skill-name';
      name.textContent = skill.name;
      if (skill.truncated) name.title = 'The full skill is longer than the per-skill prompt limit; only its first 32,000 characters are available.';
      const skillId = `pack-${skill.id}`;
      const exists = localSkills.some((item) => item.id === skillId);
      const add = createButton(document, exists ? 'Added' : 'Add', 'button outline small', () => {
        if (localSkills.length >= MAX_LOCAL_SKILLS) {
          setStatus(skillStatus, `Keep up to ${MAX_LOCAL_SKILLS} skills on this device.`, true);
          return;
        }
        try {
          localSkills = writeLocalSkills([
            ...localSkills,
            { id: skillId, name: skill.name, instructions: skill.instructions, enabled: false },
          ], storage);
          refreshSkillUi();
          renderInstalledSkillCatalog();
          const limitNotice = skill.truncated ? ' The prompt was shortened to 32,000 characters.' : '';
          setStatus(skillStatus, `${skill.name} added. Enable it when you want to use it.${limitNotice}`);
        } catch (error) {
          setStatus(skillStatus, error?.message || 'Could not add this skill.', true);
        }
      });
      add.disabled = exists;
      row.append(name, add);
      return row;
    });
    installedSkillList.replaceChildren(...rows);
    installedSkillCount.textContent = `${installedSkills.length} available`;
  }

  async function refreshInstalledSkillCatalog() {
    try {
      installedSkills = await client.listInstalledSkills();
      renderInstalledSkillCatalog();
    } catch {
      installedSkillCount.textContent = 'Unavailable';
      installedSkillList.replaceChildren();
    }
  }

  function clearSkillEditor() {
    editingSkillId = '';
    skillNameInput.value = '';
    skillInstructionsInput.value = '';
    skillEditorTitle.textContent = 'Add a skill';
    skillSaveButton.textContent = 'Save skill';
    setStatus(skillStatus, '');
  }

  function persistSettingsStatus(settings) {
    const model = typeof settings.litellmModel === 'string' ? settings.litellmModel : '';
    if (modelProbeState.model !== model) modelProbeState = { model, chat: false, image: false };
    const configured = Boolean(model);
    const verified = configured && modelProbeState.chat && modelProbeState.image;
    connectionDot.classList.toggle('ready', verified);
    connectionDot.classList.toggle('needs-setup', !verified);
    connectionDot.title = verified
      ? 'LiteLLM text and image tests passed'
      : configured ? 'LiteLLM model selected; connection tests are incomplete' : 'Choose a LiteLLM model in Connections';
    if (!configured) modelLabel.textContent = 'Choose a model in Connections to start';
    else if (verified) modelLabel.textContent = `${model} · verified`;
    else if (modelProbeState.chat) modelLabel.textContent = `${model} · text tested`;
    else if (modelProbeState.image) modelLabel.textContent = `${model} · image tested`;
    else modelLabel.textContent = `${model} · not yet tested`;
  }

  function recordModelProbe(kind, model) {
    if (modelProbeState.model !== model) modelProbeState = { model, chat: false, image: false };
    modelProbeState[kind] = true;
    persistSettingsStatus({ litellmModel: model });
  }

  function clearModelProbe(kind, model) {
    if (modelProbeState.model !== model) modelProbeState = { model, chat: false, image: false };
    modelProbeState[kind] = false;
    persistSettingsStatus({ litellmModel: model });
  }

  async function refreshAssets() {
    try {
      renderAssetLibrary({
        document,
        listElement: mediaList,
        emptyElement: mediaEmpty,
        assets: await client.listAssets(),
        canAdd: Boolean(activeCanvasId),
        onAdd: (assetId) => addAssetToCanvas({ client, assetId, statusElement }).catch(() => {}),
      });
    } catch (error) {
      setStatus(statusElement, error?.message || 'Could not load media.', true);
    }
  }

  async function refreshCanvases() {
    try {
      const canvases = await client.listCanvases();
      renderCanvasLibrary({
        document,
        listElement: canvasesList,
        emptyElement: canvasesEmpty,
        canvases,
        onOpen: (canvas) => openCanvas(canvas).catch(() => {}),
        onExport: (canvasId) => exportCanvas({ client, canvasId, statusElement }).catch(() => {}),
      });
      if (!canvasTabsRestored) {
        canvasTabsRestored = true;
        const savedIds = readOpenCanvasIds(storage);
        const byId = new Map(canvases.map((canvas) => [canvas.id, canvas]));
        for (const id of savedIds) {
          const canvas = byId.get(id);
          if (canvas) openCanvasTabs.set(canvas.id, { id: canvas.id, title: canvas.title });
        }
        writeOpenCanvasIds(openCanvasTabs, storage);
        renderOpenCanvasTabs();
        const lastTab = [...openCanvasTabs.values()].at(-1);
        if (lastTab) await openCanvas(lastTab);
      }
    } catch (error) {
      setStatus(statusElement, error?.message || 'Could not load saved canvases.', true);
    }
  }

  function refreshLibraries() {
    return Promise.all([refreshAssets(), refreshCanvases()]);
  }

  function updateCanvasState(canvas) {
    activeCanvasId = typeof canvas?.id === 'string' ? canvas.id : '';
    if (activeCanvasId) openCanvasTabs.set(activeCanvasId, { id: activeCanvasId, title: canvas.title || 'Easel Canvas' });
    renderOpenCanvasTabs();
    writeOpenCanvasIds(openCanvasTabs, storage, activeCanvasId);
    canvasTitle.textContent = canvas?.title || 'Canvas';
    canvasState.textContent = activeCanvasId ? 'Open' : 'Ready';
    canvasStateDot.classList.toggle('ready', Boolean(activeCanvasId));
    exportCurrentButton.disabled = !activeCanvasId;
    undoCanvasButton.disabled = !activeCanvasId || canvas?.undoAvailable !== true;
    canvasEmpty.hidden = Boolean(activeCanvasId);
    refreshAssets();
    updateCanvasBounds();
  }

  async function openCanvas(canvas) {
    setStatus(statusElement, `Opening ${canvas.title || 'canvas'}…`);
    try {
      const opened = await client.openCanvas(canvas.id);
      updateCanvasState(opened);
      setStatus(statusElement, `Opened ${opened.title || 'canvas'}.`);
    } catch (error) {
      setStatus(statusElement, error instanceof Error ? error.message : 'Could not open canvas.', true);
      throw error;
    }
  }

  function renderOpenCanvasTabs() {
    const tabs = [...openCanvasTabs.values()].map((canvas) => {
      const group = document.createElement('div');
      group.className = 'canvas-tab';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', canvas.title);
      group.dataset.active = String(canvas.id === activeCanvasId);
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'canvas-tab-select';
      select.textContent = canvas.title;
      select.title = canvas.title;
      select.setAttribute('aria-pressed', String(canvas.id === activeCanvasId));
      select.addEventListener('click', () => {
        if (canvas.id !== activeCanvasId) openCanvas(canvas).catch(() => {});
      });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'canvas-tab-close';
      close.title = `Close ${canvas.title}`;
      close.setAttribute('aria-label', `Close ${canvas.title}`);
      const closeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      closeIcon.setAttribute('viewBox', '0 0 16 16');
      closeIcon.setAttribute('aria-hidden', 'true');
      const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      closePath.setAttribute('d', 'm4 4 8 8M12 4l-8 8');
      closePath.setAttribute('stroke', 'currentColor');
      closePath.setAttribute('stroke-width', '1.5');
      closePath.setAttribute('stroke-linecap', 'round');
      closeIcon.append(closePath);
      close.append(closeIcon);
      close.addEventListener('click', () => closeCanvasTab(canvas.id).catch(() => {}));
      group.setAttribute('aria-current', String(canvas.id === activeCanvasId));
      group.append(select, close);
      return group;
    });
    openCanvasTabsElement.replaceChildren(...tabs);
    openCanvasTabsElement.hidden = tabs.length === 0;
  }

  async function closeCanvasTab(canvasId) {
    const canvas = openCanvasTabs.get(canvasId);
    if (!canvas) return;
    const remaining = [...openCanvasTabs.values()].filter((item) => item.id !== canvasId);
    try {
      if (canvasId === activeCanvasId && remaining.length > 0) {
        await openCanvas(remaining.at(-1));
      } else if (canvasId === activeCanvasId) {
        await client.saveCanvas(canvasId);
        activeCanvasId = '';
        canvasTitle.textContent = 'Canvas';
        canvasState.textContent = 'Ready';
        canvasStateDot.classList.remove('ready');
        exportCurrentButton.disabled = true;
        undoCanvasButton.disabled = true;
        canvasEmpty.hidden = false;
        refreshAssets();
        updateCanvasBounds();
      }
      openCanvasTabs.delete(canvasId);
      renderOpenCanvasTabs();
      writeOpenCanvasIds(openCanvasTabs, storage, activeCanvasId);
    } catch (error) {
      setStatus(statusElement, error?.message || 'Could not close canvas tab.', true);
    }
  }

  const refreshLiteLLMButton = document.getElementById('litellm-refresh-models');
  const testLiteLLMChatButton = document.getElementById('litellm-test-chat');
  const testLiteLLMImageButton = document.getElementById('litellm-test-image');
  async function refreshModelCatalog() {
    const models = await refreshLiteLLMModels({ client, select: fields.litellmModel, statusElement: settingsStatus });
    persistSettingsStatus({ litellmModel: fields.litellmModel.value });
    return models;
  }
  refreshLiteLLMButton.addEventListener('click', () => {
    refreshModelCatalog().catch(() => {});
  });
  testLiteLLMChatButton.addEventListener('click', () => {
    testLiteLLMConnection({
      client, modelSelect: fields.litellmModel, kind: 'chat', statusElement: settingsStatus,
      button: testLiteLLMChatButton, onSuccess: recordModelProbe, onFailure: clearModelProbe,
    }).catch(() => {});
  });
  testLiteLLMImageButton.addEventListener('click', () => {
    testLiteLLMConnection({
      client, modelSelect: fields.litellmModel, kind: 'image', statusElement: settingsStatus,
      button: testLiteLLMImageButton, onSuccess: recordModelProbe, onFailure: clearModelProbe,
    }).catch(() => {});
  });
  fields.litellmModel.addEventListener('change', () => persistSettingsStatus({ litellmModel: fields.litellmModel.value }));
  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const settings = await handleSettingsSubmit({ client, fields, statusElement: settingsStatus });
      modelProbeState = { model: settings.litellmModel || '', chat: false, image: false };
      persistSettingsStatus(settings);
      await refreshModelCatalog().catch(() => {});
    } catch {}
  });
  chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (chatBusy) return;
    chatBusy = true;
    updateSendState();
    try {
      const attachments = await preparePendingAttachments();
      await handleChatSubmit({
        client,
        document,
        input: messageInput,
        button: sendButton,
        statusElement,
        messagesElement,
        mode,
        size: imageSize.value,
        skills: localSkills.filter((skill) => skill.enabled).map(({ name, instructions }) => ({ name, instructions })),
        kits: localKits,
        attachments,
        activityElement,
        activityLabel,
        newChatButton,
        modeButtons,
        copyText,
      });
      pendingAttachments = [];
      renderPendingAttachments();
    } catch (error) {
      if (!statusElement.classList.contains('error')) setStatus(statusElement, error?.message || 'Could not prepare the attached media.', true);
    } finally {
      chatBusy = false;
      updateSendState();
    }
  });
  attachMediaButton.addEventListener('click', () => mediaFileInput.click());
  mediaFileInput.addEventListener('change', () => {
    addAttachmentFiles(mediaFileInput.files);
    mediaFileInput.value = '';
  });
  messageInput.addEventListener('input', updateSendState);
  messageInput.addEventListener('keydown', (event) => submitChatWithShortcut(event, chatForm, sendButton));
  messageInput.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.items || [])].flatMap((item) => item.kind === 'file' ? [item.getAsFile()].filter(Boolean) : []);
    if (files.length) {
      event.preventDefault();
      addAttachmentFiles(files);
    }
  });
  composer.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
  });
  composer.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    addAttachmentFiles(event.dataTransfer.files);
  });
  for (const button of modeButtons) {
    if (button.dataset.mode !== 'video') button.addEventListener('click', () => setMode(button.dataset.mode));
  }
  document.querySelectorAll('.prompt-suggestion').forEach((button) => {
    button.addEventListener('click', () => {
      setMode('image');
      messageInput.value = button.dataset.prompt || '';
      updateSendState();
      messageInput.focus();
    });
  });
  navExplorer.addEventListener('click', () => selectLibraryView('explorer'));
  navMedia.addEventListener('click', () => selectLibraryView('media'));
  for (const item of settingsSections) item.tab.addEventListener('click', () => selectSettingsSection(item.id));
  for (const checkbox of kitOptions) {
    checkbox.checked = localKits.includes(checkbox.dataset.kit);
    checkbox.addEventListener('change', () => {
      try {
        localKits = writeLocalKits(kitOptions.filter((option) => option.checked).map((option) => option.dataset.kit), storage);
        setStatus(document.getElementById('kit-status'), 'Kit preferences saved for new canvases.');
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        setStatus(document.getElementById('kit-status'), error?.message || 'Could not save kit preferences.', true);
      }
    });
  }
  document.getElementById('library-collapse').addEventListener('click', () => {
    setPanelCollapsed('library', !libraryPanel.classList.contains('is-collapsed'));
  });
  document.getElementById('chat-collapse').addEventListener('click', () => {
    setPanelCollapsed('chat', !conversationPanel.classList.contains('is-collapsed'));
  });
  let splitPointerId = null;
  splitter.addEventListener('pointerdown', (event) => {
    if (libraryPanel.classList.contains('is-collapsed') || conversationPanel.classList.contains('is-collapsed')) return;
    event.preventDefault();
    splitPointerId = event.pointerId;
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('is-dragging');
    const bounds = leftColumn.getBoundingClientRect();
    applyPanelRatio((event.clientY - bounds.top) / bounds.height * 100);
  });
  splitter.addEventListener('pointermove', (event) => {
    if (event.pointerId !== splitPointerId) return;
    const bounds = leftColumn.getBoundingClientRect();
    applyPanelRatio((event.clientY - bounds.top) / bounds.height * 100);
  });
  const stopPanelResize = (event) => {
    if (event.pointerId !== splitPointerId) return;
    splitPointerId = null;
    splitter.classList.remove('is-dragging');
  };
  splitter.addEventListener('pointerup', stopPanelResize);
  splitter.addEventListener('pointercancel', stopPanelResize);
  splitter.addEventListener('keydown', (event) => {
    const current = Number(splitter.getAttribute('aria-valuenow')) || 31;
    if (event.key === 'ArrowUp') applyPanelRatio(current - 5);
    else if (event.key === 'ArrowDown') applyPanelRatio(current + 5);
    else if (event.key === 'Home') applyPanelRatio(20);
    else if (event.key === 'End') applyPanelRatio(75);
    else return;
    event.preventDefault();
  });
  let workbenchPointerId = null;
  const resizeWorkbenchAt = (clientX) => {
    const bounds = leftColumn.getBoundingClientRect();
    applyWorkbenchWidth(clientX - bounds.left - 6);
  };
  workbenchSplitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    workbenchPointerId = event.pointerId;
    workbenchSplitter.setPointerCapture(event.pointerId);
    workbenchSplitter.classList.add('is-dragging');
    resizeWorkbenchAt(event.clientX);
  });
  workbenchSplitter.addEventListener('pointermove', (event) => {
    if (event.pointerId === workbenchPointerId) resizeWorkbenchAt(event.clientX);
  });
  const stopWorkbenchResize = (event) => {
    if (event.pointerId !== workbenchPointerId) return;
    workbenchPointerId = null;
    workbenchSplitter.classList.remove('is-dragging');
  };
  workbenchSplitter.addEventListener('pointerup', stopWorkbenchResize);
  workbenchSplitter.addEventListener('pointercancel', stopWorkbenchResize);
  workbenchSplitter.addEventListener('keydown', (event) => {
    const current = Number(workbenchSplitter.getAttribute('aria-valuenow')) || 360;
    const limits = workbenchWidthLimits();
    if (event.key === 'ArrowLeft') applyWorkbenchWidth(current - 20);
    else if (event.key === 'ArrowRight') applyWorkbenchWidth(current + 20);
    else if (event.key === 'Home') applyWorkbenchWidth(limits.min);
    else if (event.key === 'End') applyWorkbenchWidth(limits.max);
    else return;
    event.preventDefault();
  });
  activitySettings.addEventListener('click', () => openSettings('connections'));
  document.getElementById('connections-open').addEventListener('click', () => openSettings('connections'));
  document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
  settingsDialog.addEventListener('close', () => {
    activitySettings.setAttribute('aria-pressed', 'false');
    updateCanvasBounds();
  });
  const openSkills = () => {
    setStatus(skillStatus, '');
    openSettings('skills', skillNameInput);
  };
  document.getElementById('composer-skills').addEventListener('click', openSkills);
  document.getElementById('skill-new').addEventListener('click', () => {
    clearSkillEditor();
    skillNameInput.focus();
  });
  document.getElementById('skill-cancel').addEventListener('click', clearSkillEditor);
  document.getElementById('skill-import-open').addEventListener('click', () => skillFileInput.click());
  skillFileInput.addEventListener('change', async () => {
    const file = skillFileInput.files?.[0];
    skillFileInput.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_SKILL_INSTRUCTIONS * 4) throw new Error('Choose a skill file under 128 KB.');
      const imported = parseSkillMarkdown(await file.text(), file.name);
      editingSkillId = '';
      skillNameInput.value = imported.name;
      skillInstructionsInput.value = imported.instructions;
      skillEditorTitle.textContent = 'Review imported skill';
      skillSaveButton.textContent = 'Add skill';
      setStatus(skillStatus, 'Review the instructions, then add this skill.');
      skillNameInput.focus();
    } catch (error) {
      setStatus(skillStatus, error?.message || 'Could not import this skill file.', true);
    }
  });
  skillForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = skillNameInput.value.trim();
    const instructions = skillInstructionsInput.value.trim();
    if (!name || !instructions) return;
    if (instructions.length > MAX_SKILL_INSTRUCTIONS) {
      setStatus(skillStatus, `Keep skill instructions under ${MAX_SKILL_INSTRUCTIONS} characters.`, true);
      return;
    }
    const current = localSkills.find((skill) => skill.id === editingSkillId);
    const skill = { id: editingSkillId || createSkillId(), name, instructions, enabled: current?.enabled ?? true };
    const next = current
      ? localSkills.map((item) => item.id === current.id ? skill : item)
      : [...localSkills, skill];
    if (next.length > MAX_LOCAL_SKILLS) {
      setStatus(skillStatus, `Keep up to ${MAX_LOCAL_SKILLS} skills on this device.`, true);
      return;
    }
    const activeInstructions = next.filter((item) => item.enabled).reduce((total, item) => total + item.instructions.length, 0);
    if (activeInstructions > MAX_ACTIVE_SKILL_INSTRUCTIONS) {
      setStatus(skillStatus, `Keep active skill instructions under ${MAX_ACTIVE_SKILL_INSTRUCTIONS} characters in total.`, true);
      return;
    }
    try {
      localSkills = writeLocalSkills(next, storage);
      refreshSkillUi();
      clearSkillEditor();
      setStatus(skillStatus, 'Skill saved on this device.');
    } catch (error) {
      setStatus(skillStatus, error?.message || 'Could not save this skill.', true);
    }
  });
  document.getElementById('new-canvas-open').addEventListener('click', () => openDialog(newCanvasDialog, newCanvasName));
  document.getElementById('canvas-empty-new').addEventListener('click', () => openDialog(newCanvasDialog, newCanvasName));
  document.getElementById('new-canvas-close').addEventListener('click', () => newCanvasDialog.close());
  newCanvasDialog.addEventListener('close', updateCanvasBounds);
  newCanvasForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    newCanvasSubmit.disabled = true;
    try {
      const canvas = await createCanvas({ client, title: newCanvasName.value, statusElement });
      newCanvasDialog.close();
      newCanvasName.value = '';
      updateCanvasState(canvas);
      await refreshCanvases();
    } catch {} finally {
      newCanvasSubmit.disabled = false;
    }
  });
  exportCurrentButton.addEventListener('click', () => exportCanvas({ client, canvasId: activeCanvasId, statusElement }).catch(() => {}));
  undoCanvasButton.addEventListener('click', () => undoCanvas({
    client,
    canvasId: activeCanvasId,
    statusElement,
    onCanvasChange: updateCanvasState,
  }).catch(() => {}));
  newChatButton.addEventListener('click', async () => {
    if (chatBusy) return;
    try {
      await client.clearChat();
      messagesElement.replaceChildren(createWelcomeMessage(document, (prompt) => {
        setMode('image');
        messageInput.value = prompt;
        updateSendState();
        messageInput.focus();
      }));
      assetPreviews.clear();
      pendingAssetCaptions.clear();
      pendingAttachments = [];
      for (const objectUrl of messageObjectUrls) URL.revokeObjectURL(objectUrl);
      messageObjectUrls.clear();
      renderPendingAttachments();
      messagesElement.scrollTop = 0;
      setStatus(statusElement, 'New chat started.');
    } catch (error) {
      setStatus(statusElement, error?.message || 'Could not start a new chat.', true);
    }
  });

  const unsubscribe = client.onAgentEvent((event) => {
    renderAgentEvent({
      document,
      messagesElement,
      event,
      statusElement,
      activityElement,
      activityLabel,
      copyText,
      assetPreviews,
      pendingAssetCaptions,
      onLibraryRefresh: refreshAssets,
      onAddToCanvas: (assetId, button) => {
        if (button?.disabled) return;
        if (button) {
          button.disabled = true;
          button.textContent = 'Adding…';
        }
        addAssetToCanvas({
          client,
          assetId,
          statusElement,
          options: { createIfMissing: true },
        }).catch(() => {}).finally(() => {
          if (button) {
            button.disabled = false;
            button.textContent = 'Add to canvas';
          }
        });
      },
      onImageReady: ({ assetId }) => {
        client.addAssetToCanvas(assetId, { onlyIfEmpty: true, createIfMissing: true })
          .catch((error) => setStatus(statusElement, `Could not place the generated image on canvas: ${error?.message || 'canvas update failed'}`, true));
      },
      onCanvasChange: (canvas) => {
        updateCanvasState({ id: canvas.canvasId, title: canvas.title, undoAvailable: canvas.undoAvailable });
        refreshCanvases();
      },
      onCapabilities: (tools) => {
        modelLabel.textContent = tools.includes('generate_image') ? 'Easel image tools ready' : 'Image generation unavailable';
      },
    });
  });
  client.getSettings().then((settings) => {
    fields.easelBaseUrl.value = settings.easelBaseUrl;
    fields.litellmBaseUrl.value = settings.litellmBaseUrl;
    ensureLiteLLMModelOption(fields.litellmModel, settings.litellmModel);
    fields.easelApiKey.placeholder = settings.hasEaselApiKey ? 'Saved securely' : 'Optional';
    fields.litellmApiKey.placeholder = settings.hasLiteLLMApiKey ? 'Saved securely' : 'Optional';
    persistSettingsStatus(settings);
  }).catch((error) => setStatus(settingsStatus, error?.message || 'Could not load settings.', true));

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateCanvasBounds) : null;
  resizeObserver?.observe(canvasHost);
  const savedPanelRatio = readStoredValue(PANEL_RATIO_STORAGE_KEY);
  applyPanelRatio(savedPanelRatio === null ? 31 : Number(savedPanelRatio));
  selectLibraryView('explorer');
  selectSettingsSection('connections');
  const savedWorkbenchWidth = readStoredValue(WORKBENCH_WIDTH_STORAGE_KEY);
  applyWorkbenchWidth(savedWorkbenchWidth === null ? 360 : Number(savedWorkbenchWidth));
  setPanelCollapsed('library', readStoredValue('easel-studio.library-collapsed.v1') === 'true');
  setPanelCollapsed('chat', readStoredValue('easel-studio.chat-collapsed.v1') === 'true');
  const handleWindowResize = () => {
    applyWorkbenchWidth(Number(workbenchSplitter.getAttribute('aria-valuenow')) || 360);
    updateCanvasBounds();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('scroll', updateCanvasBounds, true);
  }
  refreshSkillUi();
  refreshInstalledSkillCatalog();
  setMode(mode);
  updateSendState();
  refreshLibraries();
  updateCanvasBounds();

  return {
    dispose() {
      unsubscribe();
      resizeObserver?.disconnect();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', handleWindowResize);
        window.removeEventListener('scroll', updateCanvasBounds, true);
      }
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    appendTextMessage,
    addAssetToCanvas,
    createCanvas,
    exportCanvas,
    handleGenerationSubmit,
    normalizeResultSource,
    resultSummary,
    handleChatSubmit,
    submitChatWithShortcut,
    handleSettingsSubmit,
    undoCanvas,
    refreshLiteLLMModels,
    testLiteLLMConnection,
    renderAgentEvent,
    renderAssetLibrary,
    renderCanvasLibrary,
    setStatus,
    wireRenderer,
  };
}

if (typeof window !== 'undefined' && window.document && window.easelClient) {
  wireRenderer({ document: window.document, client: window.easelClient });
}
