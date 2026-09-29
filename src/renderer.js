function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.setAttribute('role', isError ? 'alert' : 'status');
  element.setAttribute('aria-live', isError ? 'assertive' : 'polite');
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
const OPEN_CANVAS_STORAGE_KEY = 'easel-studio.open-canvases.v1';
const PANEL_RATIO_STORAGE_KEY = 'easel-studio.panel-ratio.v1';
const MAX_LOCAL_SKILLS = 12;
const MAX_SKILL_INSTRUCTIONS = 12_000;

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

function appendImagePreviewMessage(document, messagesElement, event) {
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
  message.append(figure);
  messagesElement.append(message);
  if (shouldFollow) messagesElement.scrollTop = messagesElement.scrollHeight;
  return { image, caption, message };
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

async function addAssetToCanvas({ client, assetId, statusElement }) {
  setStatus(statusElement, 'Adding image to canvas…');
  try {
    await client.addAssetToCanvas(assetId);
    setStatus(statusElement, 'Image added to canvas.');
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

function renderAgentEvent({ document, messagesElement, imagesElement, event, statusElement, activityElement, activityLabel, copyText, assetPreviews, pendingAssetCaptions, onLibraryRefresh, onCanvasChange, onCapabilities }) {
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
      const preview = appendImagePreviewMessage(document, messagesElement, event);
      const caption = pendingAssetCaptions?.get(assetId);
      if (caption) {
        preview.image.alt = caption;
        preview.caption.textContent = caption;
        pendingAssetCaptions.delete(assetId);
      }
      assetPreviews.set(assetId, preview);
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

async function handleChatSubmit({ client, document, input, button, statusElement, messagesElement, mode = 'chat', size = '1024x1024', skills = [], activityElement, activityLabel, newChatButton, modeButtons, copyText }) {
  const text = input.value.trim();
  if (!text) return;
  button.disabled = true;
  if (newChatButton) newChatButton.disabled = true;
  for (const modeButton of modeButtons || []) modeButton.disabled = true;
  appendTextMessage(document, messagesElement, 'user', text, { mode });
  if (activityLabel) activityLabel.textContent = mode === 'image' ? 'Preparing your image…' : 'Thinking through the next step…';
  if (activityElement) activityElement.hidden = false;
  setStatus(statusElement, '');
  try {
    const result = await client.sendMessage(text, { mode, size, skills });
    input.value = '';
    setStatus(statusElement, '');
    return result;
  } catch (error) {
    if (activityElement) activityElement.hidden = true;
    setStatus(statusElement, error instanceof Error ? error.message : 'The message could not be sent.', true);
    throw error;
  } finally {
    button.disabled = false;
    if (newChatButton) newChatButton.disabled = false;
    for (const modeButton of modeButtons || []) modeButton.disabled = modeButton.dataset.mode === 'video';
    if (activityElement) activityElement.hidden = true;
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
  const newCanvasDialog = document.getElementById('new-canvas-dialog');
  const skillsDialog = document.getElementById('skills-dialog');
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
  const newCanvasForm = document.getElementById('new-canvas-form');
  const newCanvasName = document.getElementById('new-canvas-name');
  const newCanvasSubmit = document.getElementById('new-canvas-submit');
  const chatForm = document.getElementById('chat-form');
  const messageInput = document.getElementById('message');
  const sendButton = document.getElementById('send');
  const sendLabel = document.getElementById('send-label');
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
  const runtimesContent = document.getElementById('runtimes-content');
  const leftColumn = document.querySelector('.left-column');
  const libraryPanel = document.querySelector('.library');
  const conversationPanel = document.querySelector('.conversation');
  const splitter = document.getElementById('panel-splitter');
  const openCanvasTabsElement = document.getElementById('open-canvas-tabs');
  const canvasHost = document.getElementById('canvas-host');
  const canvasEmpty = document.getElementById('canvas-empty');
  const canvasTitle = document.getElementById('canvas-title');
  const canvasState = document.getElementById('canvas-state');
  const canvasStateDot = document.getElementById('canvas-state-dot');
  const exportCurrentButton = document.getElementById('export-current');
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
  let localSkills = readLocalSkills(storage);
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

  function setPanelCollapsed(panelName, collapsed) {
    const panel = panelName === 'library' ? libraryPanel : conversationPanel;
    const button = document.getElementById(panelName === 'library' ? 'library-collapse' : 'chat-collapse');
    const label = panelName === 'library' ? 'library' : 'chat';
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
    if ([settingsDialog, newCanvasDialog, skillsDialog].some((dialog) => dialog.open)) {
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
    sendButton.disabled = chatBusy || !messageInput.value.trim();
    newChatButton.disabled = chatBusy;
    for (const button of modeButtons) button.disabled = chatBusy || button.dataset.mode === 'video';
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
        try {
          localSkills = writeLocalSkills(localSkills.map((skill) => skill.id === id ? { ...skill, enabled } : skill), storage);
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

  function clearSkillEditor() {
    editingSkillId = '';
    skillNameInput.value = '';
    skillInstructionsInput.value = '';
    skillEditorTitle.textContent = 'Add a skill';
    skillSaveButton.textContent = 'Save skill';
    setStatus(skillStatus, '');
  }

  function persistSettingsStatus(settings) {
    const configured = Boolean(settings.litellmModel);
    connectionDot.classList.toggle('ready', configured);
    connectionDot.classList.toggle('needs-setup', !configured);
    connectionDot.title = configured ? 'LiteLLM model configured' : 'Add a LiteLLM model in Connections';
    modelLabel.textContent = configured ? settings.litellmModel : 'Add a model in Connections to start';
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

  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const settings = await handleSettingsSubmit({ client, fields, statusElement: settingsStatus });
      persistSettingsStatus(settings);
    } catch {}
  });
  chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (chatBusy) return;
    chatBusy = true;
    updateSendState();
    try {
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
        activityElement,
        activityLabel,
        newChatButton,
        modeButtons,
        copyText,
      });
    } catch {} finally {
      chatBusy = false;
      updateSendState();
    }
  });
  messageInput.addEventListener('input', updateSendState);
  messageInput.addEventListener('keydown', (event) => submitChatWithShortcut(event, chatForm, sendButton));
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
  const libraryTabs = [
    { button: document.getElementById('show-media'), content: mediaContent },
    { button: document.getElementById('show-canvases'), content: canvasesContent },
    { button: document.getElementById('show-runtimes'), content: runtimesContent },
  ];
  for (const selected of libraryTabs) {
    selected.button.addEventListener('click', () => {
      for (const tab of libraryTabs) {
        const active = tab === selected;
        tab.content.hidden = !active;
        tab.button.setAttribute('aria-pressed', String(active));
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
  document.getElementById('settings-open').addEventListener('click', () => openDialog(settingsDialog));
  document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
  settingsDialog.addEventListener('close', updateCanvasBounds);
  const openSkills = () => {
    setStatus(skillStatus, '');
    openDialog(skillsDialog, skillNameInput);
  };
  document.getElementById('skills-open').addEventListener('click', openSkills);
  document.getElementById('composer-skills').addEventListener('click', openSkills);
  document.getElementById('skills-close').addEventListener('click', () => skillsDialog.close());
  skillsDialog.addEventListener('close', updateCanvasBounds);
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
      if (file.size > MAX_SKILL_INSTRUCTIONS + 2_000) throw new Error('Choose a skill file under 14 KB.');
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
      onCanvasChange: (canvas) => {
        updateCanvasState({ id: canvas.canvasId, title: canvas.title });
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
    fields.litellmModel.value = settings.litellmModel;
    fields.easelApiKey.placeholder = settings.hasEaselApiKey ? 'Saved securely' : 'Optional';
    fields.litellmApiKey.placeholder = settings.hasLiteLLMApiKey ? 'Saved securely' : 'Optional';
    persistSettingsStatus(settings);
  }).catch((error) => setStatus(settingsStatus, error?.message || 'Could not load settings.', true));

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateCanvasBounds) : null;
  resizeObserver?.observe(canvasHost);
  const savedPanelRatio = readStoredValue(PANEL_RATIO_STORAGE_KEY);
  applyPanelRatio(savedPanelRatio === null ? 31 : Number(savedPanelRatio));
  setPanelCollapsed('library', readStoredValue('easel-studio.library-collapsed.v1') === 'true');
  setPanelCollapsed('chat', readStoredValue('easel-studio.chat-collapsed.v1') === 'true');
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', updateCanvasBounds);
    window.addEventListener('scroll', updateCanvasBounds, true);
  }
  refreshSkillUi();
  setMode(mode);
  updateSendState();
  refreshLibraries();
  updateCanvasBounds();

  return {
    dispose() {
      unsubscribe();
      resizeObserver?.disconnect();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', updateCanvasBounds);
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
