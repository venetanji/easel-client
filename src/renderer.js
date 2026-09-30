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
    const selectedModel = select.value || savedModel;
    const options = models.map((model) => modelOption(select, model.id, model.name === model.id ? model.id : `${model.name} — ${model.id}`));
    if (selectedModel && !models.some((model) => model.id === selectedModel)) {
      options.unshift(modelOption(select, selectedModel, `${selectedModel} (saved; not in catalog)`));
    }
    select.replaceChildren(...options);
    select.value = selectedModel || models[0]?.id || '';
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
const OPEN_CANVAS_STORAGE_KEY = 'easel-studio.open-canvases.v1';
const WORKBENCH_WIDTH_STORAGE_KEY = 'easel-studio.workbench-width.v1';
const MAX_LOCAL_SKILLS = 64;
const MAX_SKILL_INSTRUCTIONS = 32_000;
const MAX_ACTIVE_SKILL_INSTRUCTIONS = 48_000;
const DEFAULT_RUNTIME_KITS = Object.freeze(['canvas-2d', 'tone']);
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

function renderSkillList({ document, listElement, emptyElement, skills, onToggle, onEdit, onRemove, compatibility }) {
  const rows = normalizeLocalSkills(skills).map((skill) => {
    const row = document.createElement('div');
    row.className = 'skill-row';
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'skill-enabled';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = skill.enabled;
    const support = compatibility?.(skill);
    checkbox.disabled = support?.supported === false;
    if (support?.reason) toggleLabel.title = support.reason;
    checkbox.setAttribute('aria-label', `Use ${skill.name} in chat`);
    checkbox.addEventListener('change', () => onToggle?.(skill.id, checkbox.checked));
    toggleLabel.append(checkbox);
    const name = document.createElement('span');
    name.className = 'skill-row-name';
    name.textContent = skill.name;
    if (support?.reason) {
      const note = document.createElement('small');
      note.className = 'skill-compatibility-note';
      note.textContent = support.reason;
      name.append(note);
    }
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

function appendMediaPreviewMessage(document, messagesElement, event, onAddToCanvas, options = {}) {
  const shouldFollow = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 56;
  const message = document.createElement('article');
  message.className = 'message assistant message-media';
  message.dataset.assetId = event.assetId;
  const figure = document.createElement('figure');
  figure.className = 'message-asset-preview';
  const kind = /^(video|audio)\//.exec(event.mimeType || '')?.[1] || 'image';
  const image = document.createElement(kind === 'image' ? 'img' : kind);
  const inline = typeof event.data === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data);
  if (inline) image.src = `data:${event.mimeType};base64,${event.data}`;
  const label = event.name || `Generated ${kind}`;
  image.alt = label;
  image.setAttribute('aria-label', label);
  if (kind !== 'image') {
    image.controls = true;
    image.preload = inline ? 'metadata' : 'none';
    if (kind === 'video') image.playsInline = true;
  }
  const poster = normalizeResultSource(event.thumbnail || event.thumbnailDataUrl);
  if (poster) {
    if (kind === 'video') image.poster = poster;
    else if (kind === 'image' && !inline) image.src = poster;
  }
  const visual = document.createElement('div');
  visual.className = 'message-media-visual';
  visual.append(image);
  if (options.newMedia) {
    const badge = document.createElement('span');
    badge.className = 'message-media-badge';
    badge.textContent = `New ${kind}`;
    visual.append(badge);
  }
  const caption = document.createElement('figcaption');
  caption.textContent = label;
  figure.append(visual, caption);
  let disposed = false;
  let loading;
  let objectUrl = '';
  let playButton;
  const error = document.createElement('p');
  error.className = 'message-media-error';
  error.hidden = true;
  async function load(play = false) {
    if (disposed) return;
    if (!inline && !objectUrl) {
      if (!options.loadAsset) throw new Error('Open this media from the Media drawer to play it.');
      if (!loading) loading = Promise.resolve(options.loadAsset(event)).then((asset) => {
        if (disposed) return;
        if (asset.mimeType !== event.mimeType || typeof asset.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) throw new Error('The saved media could not be read.');
        const bytes = Uint8Array.from(atob(asset.data), (character) => character.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
        options.objectUrls?.add(objectUrl);
        image.src = objectUrl;
        image.preload = 'metadata';
      }).finally(() => { loading = null; });
      await loading;
    }
    if (disposed) return;
    options.onSeen?.(event.assetId);
    if (play && kind !== 'image') {
      try { await image.play(); if (playButton) playButton.hidden = true; }
      catch { if (playButton) playButton.textContent = `Play ${kind}`; }
    }
  }
  if (!inline && kind !== 'image') {
    playButton = createButton(document, `Play ${kind}`, 'message-media-play', async () => {
      playButton.disabled = true;
      playButton.textContent = 'Loading...';
      error.hidden = true;
      try { await load(true); }
      catch (failure) { error.textContent = failure.message || 'Media could not load. Try again.'; error.hidden = false; }
      finally { playButton.disabled = false; playButton.textContent = `Play ${kind}`; }
    });
    playButton.setAttribute('aria-label', `Play ${label}`);
    visual.append(playButton);
  }
  image.addEventListener('play', () => { options.onSeen?.(event.assetId); if (playButton) playButton.hidden = true; });
  image.addEventListener('error', () => {
    if (disposed) return;
    error.textContent = `This ${kind} could not be decoded. Download it to open in another player.`;
    error.hidden = false;
  });
  let add;
  if (onAddToCanvas) {
    add = createButton(document, 'Add to project', 'message-asset-add', () => onAddToCanvas(event.assetId, add));
    add.setAttribute('aria-label', `Add ${kind} to project`);
  }
  message.append(figure);
  if (add) message.append(add);
  if (options.onOpen || options.onDownload || options.onUse) {
    const actions = document.createElement('div');
    actions.className = 'message-media-actions';
    for (const [text, action] of [['Open in viewer', options.onOpen], ['Download', options.onDownload], ['Use in chat', options.onUse]]) {
      if (!action) continue;
      const button = createButton(document, text, 'button quiet small', async () => {
        button.disabled = true;
        error.hidden = true;
        try { await action(event); }
        catch (failure) { error.textContent = failure.message || 'This action failed. Try again.'; error.hidden = false; }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    message.append(actions);
  }
  message.append(error);
  messagesElement.append(message);
  if (shouldFollow) messagesElement.scrollTop = messagesElement.scrollHeight;
  return { image, caption, message, addButton: add, load,
    dispose() {
      disposed = true;
      if (kind !== 'image') { image.pause(); image.removeAttribute('src'); image.load(); }
      if (objectUrl) { URL.revokeObjectURL(objectUrl); options.objectUrls?.delete(objectUrl); objectUrl = ''; }
    } };
}

function appendReadyMediaCards({ document, messagesElement, event, assetPreviews, options = {} }) {
  let added = 0;
  const assets = event.assets || event.result?.assets || event.job?.assets || [];
  for (const asset of assets) {
    const assetId = asset.assetId || asset.id;
    if (!/^[a-f0-9]{32}$/i.test(assetId || '') || !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg'].includes(asset.mimeType) || assetPreviews.has(assetId)) continue;
    const media = { ...asset, assetId, projectId: event.projectId || event.job?.projectId || asset.projectId, name: asset.name || event.job?.name || `Generated ${event.job?.mediaType || 'media'}` };
    const newMedia = typeof options.newMedia === 'function' ? options.newMedia(assetId) : options.newMedia !== false;
    const preview = appendMediaPreviewMessage(document, messagesElement, media, null, { ...options, newMedia });
    assetPreviews.set(assetId, preview);
    added += 1;
  }
  return added;
}

function canAutoPreviewMedia({ event, activeChatId, projectId, previewKind, busy, draft = '', attachments = 0 }) {
  const ownerChat = event.chatId || event.job?.chatId;
  const ownerProject = event.projectId || event.job?.projectId;
  return Boolean(ownerChat && ownerChat === activeChatId && (!projectId || ownerProject === projectId) && previewKind === 'empty' && !busy && !draft.trim() && attachments === 0);
}

function renderInstalledKitCatalog(document, listElement, catalog) {
  listElement.replaceChildren(...catalog.map((kit) => {
    const row = document.createElement('div');
    row.className = 'kit-availability';
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = kit.name;
    const description = document.createElement('small');
    description.textContent = kit.description;
    copy.append(name, description);
    const status = document.createElement('span');
    status.className = `runtime-badge${kit.installed ? ' active' : ''}`;
    status.textContent = kit.installed ? kit.version ? `Installed ${kit.version}` : 'Installed' : 'Unavailable';
    row.append(copy, status);
    return row;
  }));
}

function skillCompatibility(skill, installedSkills) {
  const installed = installedSkills.find((item) => `pack-${item.id}` === skill?.id || item.name.trim().toLowerCase() === skill?.name?.trim().toLowerCase());
  if (!installed && !skill?.id?.startsWith('pack-')) return { supported: true, reason: 'Custom instructions; compatibility has not been reviewed.' };
  return { supported: installed?.compatibility === 'supported', reason: installed?.compatibility === 'supported' ? '' : installed?.reason || 'This installed recipe is unavailable in the client.' };
}

let assistantMarkdown;

function renderAssistantMarkdown(content) {
  if (typeof globalThis.markdownit !== 'function') return;
  if (!assistantMarkdown) {
    assistantMarkdown = globalThis.markdownit({ html: false, breaks: true, linkify: false });
    assistantMarkdown.validateLink = (value) => {
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      } catch { return false; }
    };
    // Generated assets have their own previews; remote Markdown images must not fetch in chat.
    assistantMarkdown.renderer.rules.image = (tokens, index) => assistantMarkdown.utils.escapeHtml(tokens[index].content);
  }
  content.innerHTML = assistantMarkdown.render(content.textContent);
  content.classList.add('markdown');
  for (const link of content.querySelectorAll('a[href]')) {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      try { await globalThis.easelClient?.openExternal(link.href); }
      catch { link.title = 'Could not open this link in your browser.'; }
    });
  }
}

function appendTextMessage(document, messagesElement, role, text, options = {}) {
  const shouldFollow = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 56;
  const message = document.createElement('article');
  message.className = `message ${role}`;
  if (role === 'user' && options.mode === 'image') message.setAttribute('data-mode', 'image');
  let resolvedAssetIds = [];
  if (role === 'assistant') {
    const content = document.createElement('div');
    content.className = 'message-content';
    const rendered = renderAssistantAssetLinks(
      document,
      content,
      text,
      options.assetPreviews instanceof Map ? options.assetPreviews : new Map(),
      options.pendingAssetCaptions
    );
    resolvedAssetIds = rendered.resolvedAssetIds;
    if (!rendered.hasText && resolvedAssetIds.length > 0) {
      if (shouldFollow) messagesElement.scrollTop = messagesElement.scrollHeight;
      return null;
    }
    renderAssistantMarkdown(content);
    message.append(content);
  } else if (role === 'user' && Array.isArray(options.attachments) && options.attachments.length > 0) {
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;
    message.append(content);
    const attachmentList = document.createElement('div');
    attachmentList.className = 'message-attachments';
    for (const attachment of options.attachments) {
      if (!attachment || !['image', 'audio', 'video'].includes(attachment.type)) continue;
      const figure = document.createElement('figure');
      figure.className = 'message-attachment';
      if (typeof attachment.previewUrl === 'string' && attachment.previewUrl.startsWith('blob:')) {
        const tag = attachment.type === 'image' ? 'img' : attachment.type === 'audio' ? 'audio' : 'video';
        const preview = document.createElement(tag);
        preview.src = attachment.previewUrl;
        if (attachment.type === 'image') preview.alt = attachment.name;
        else {
          preview.controls = true;
          preview.preload = 'metadata';
        }
        figure.append(preview);
      } else {
        figure.classList.add('metadata-only');
      }
      const caption = document.createElement('figcaption');
      caption.textContent = attachment.name || `${attachment.type} attachment`;
      if (!figure.firstChild) caption.textContent += ' (saved capture; preview unavailable)';
      figure.append(caption);
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
    generate_video: 'Starting video generation…',
    get_video: 'Checking your video job…',
    list_models: 'Checking available media models…',
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

async function createCanvas({ client, title, kits = ['canvas-2d'], statusElement }) {
  setStatus(statusElement, 'Creating canvas…');
  try {
    const canvas = await client.createCanvas(title, kits);
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

function renderAgentEvent({ document, messagesElement, imagesElement, event, statusElement, activityElement, activityLabel, copyText, assetPreviews, pendingAssetCaptions, onLibraryRefresh, onCanvasChange, onCapabilities, onAddToCanvas, onImageReady, mediaPreviewOptions }) {
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
  if (event.type === 'image' || (event.type === 'media' && event.generated)) {
    if (event.data !== undefined && (typeof event.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data))) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg'].includes(event.mimeType)) return;
    if (messagesElement && assetPreviews instanceof Map && /^[a-f0-9]{32}$/i.test(event.assetId || '')) {
      const assetId = event.assetId.toLowerCase();
      if (assetPreviews.has(assetId)) return;
      const preview = appendMediaPreviewMessage(document, messagesElement, event, onAddToCanvas, mediaPreviewOptions);
      const caption = pendingAssetCaptions?.get(assetId);
      if (caption) {
        preview.image.alt = caption;
        preview.caption.textContent = caption;
        pendingAssetCaptions.delete(assetId);
      }
      assetPreviews.set(assetId, preview);
      onImageReady?.({ assetId, preview });
    } else if (imagesElement && typeof event.data === 'string') {
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

function renderStreamingAgentEvent({ document, messagesElement, event, streams, chatId, copyText, assetPreviews, pendingAssetCaptions }) {
  if (!['token', 'assistant'].includes(event?.type) || !event.itemId || typeof event.text !== 'string') return false;
  if (chatId && event.chatId && event.chatId !== chatId) return 'ignored';
  const key = `${event.chatId || chatId || ''}:${event.itemId}`;
  let stream = streams.get(key);
  if (stream?.final) return 'ignored';
  if (!stream) {
    stream = { text: '', final: false };
    stream.message = appendTextMessage(document, messagesElement, 'assistant', '', {
      copyText: copyText ? () => copyText(stream.text) : undefined,
    });
    stream.message.dataset.itemId = event.itemId;
    streams.set(key, stream);
  }
  const shouldFollow = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 56;
  stream.text = event.type === 'token' ? stream.text + event.text : event.text;
  stream.final = event.type === 'assistant';
  const content = stream.message.querySelector('.message-content');
  content.textContent = stream.text;
  content.classList.toggle('markdown', stream.final);
  if (stream.final) {
    content.replaceChildren();
    renderAssistantAssetLinks(document, content, stream.text, assetPreviews || new Map(), pendingAssetCaptions);
    renderAssistantMarkdown(content);
  }
  stream.message.dataset.streaming = String(!stream.final);
  if (shouldFollow) messagesElement.scrollTop = messagesElement.scrollHeight;
  return 'updated';
}

async function handleSettingsSubmit({ client, fields, statusElement }) {
  setStatus(statusElement, 'Saving settings…');
  try {
    const result = await client.saveSettings({
      easelBaseUrl: fields.easelBaseUrl.value,
      easelApiKey: fields.easelApiKey.value,
      clearEaselApiKey: fields.clearEaselApiKey.checked === true,
      ...(fields.litellmBaseUrl ? {
        litellmBaseUrl: fields.litellmBaseUrl.value,
        litellmModel: fields.litellmModel.value,
        litellmApiKey: fields.litellmApiKey.value,
        clearLiteLLMApiKey: fields.clearLiteLLMApiKey.checked === true,
      } : {}),
    });
    fields.easelApiKey.value = '';
    if (fields.litellmApiKey) fields.litellmApiKey.value = '';
    fields.clearEaselApiKey.checked = false;
    if (fields.clearLiteLLMApiKey) fields.clearLiteLLMApiKey.checked = false;
    fields.easelApiKey.placeholder = result.hasEaselApiKey ? 'Saved securely' : 'Optional';
    if (fields.litellmApiKey) fields.litellmApiKey.placeholder = result.hasLiteLLMApiKey ? 'Saved securely' : 'Optional';
    setStatus(statusElement, 'Settings saved.');
    return result;
  } catch (error) {
    setStatus(statusElement, error instanceof Error ? error.message : 'Could not save settings.', true);
    throw error;
  }
}

async function handleChatSubmit({ client, document, input, button, statusElement, messagesElement, mode = 'chat', size = '1024x1024', skills = [], kits = ['canvas-2d'], attachments = [], activityElement, activityLabel, newChatButton, modeButtons, copyText, onRunStart }) {
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
    const request = client.sendMessage(message, {
      mode,
      size,
      skills,
      kits,
      attachments: attachments.map(({ type, name, mimeType, data, frames }) => type === 'video'
        ? { type, name, mimeType, frames }
        : { type, name, mimeType, data }),
    });
    onRunStart?.();
    const result = await request;
    setStatus(statusElement, result?.saveWarning || (result?.cancelled ? 'Stopped. Completed edits are kept.' : ''), Boolean(result?.saveWarning));
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

function canvasInputDisplayText(message, request) {
  if (request?.kind === 'choice') {
    const label = request.options?.find((option) => option.value === request.value)?.label || request.value;
    if (label) return `Selected: ${label}`;
  }
  if (request?.kind === 'media') return request.prompt || 'Review the media I shared from the canvas.';
  const text = typeof message.content === 'string' ? message.content : '';
  // Older answers can outlive the bounded request list; their saved metadata carries the label.
  try {
    const metadata = JSON.parse(text.slice(text.lastIndexOf('\n\n') + 2));
    if (metadata.type === 'canvas_input' && metadata.label) return `Selected: ${metadata.label}`;
    if (metadata.type === 'canvas_media') return text.slice(0, text.lastIndexOf('\n\n'));
  } catch {}
  return text;
}

function wireRenderer({ document, client }) {
  const settingsDialog = document.getElementById('settings-dialog');
  const settingsSections = [
    { id: 'agent', tab: document.getElementById('settings-tab-agent'), section: document.getElementById('settings-agent') },
    { id: 'credentials', tab: document.getElementById('settings-tab-credentials'), section: document.getElementById('settings-credentials') },
    { id: 'models', tab: document.getElementById('settings-tab-models'), section: document.getElementById('settings-models') },
    { id: 'skills', tab: document.getElementById('settings-tab-skills'), section: document.getElementById('settings-skills') },
    { id: 'kits', tab: document.getElementById('settings-tab-kits'), section: document.getElementById('settings-kits') },
  ];
  const newCanvasDialog = document.getElementById('new-canvas-dialog');
  const canvasFilesDialog = document.getElementById('canvas-files-dialog');
  const canvasFilesButton = document.getElementById('canvas-files-open');
  const canvasDevicesButton = document.getElementById('canvas-devices-open');
  const canvasFilesList = document.getElementById('canvas-files-list');
  const canvasFilesSummary = document.getElementById('canvas-files-summary');
  const canvasFilePath = document.getElementById('canvas-file-path');
  const canvasFileSource = document.getElementById('canvas-file-source');
  const canvasFileStatus = document.getElementById('canvas-file-status');
  const canvasFilePrevious = document.getElementById('canvas-file-previous');
  const canvasFileNext = document.getElementById('canvas-file-next');
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
  const newCanvasStatus = document.getElementById('new-canvas-status');
  const newCanvasKits = document.getElementById('new-canvas-kits');
  const newCanvasAudioHint = document.getElementById('new-canvas-audio-hint');
  const chatForm = document.getElementById('chat-form');
  const messageInput = document.getElementById('message');
  const sendButton = document.getElementById('send');
  const mediaFileInput = document.getElementById('media-files');
  const attachMediaButton = document.getElementById('attach-media');
  const attachmentStrip = document.getElementById('attachment-strip');
  const composer = chatForm.querySelector('.composer');
  const statusElement = document.getElementById('status');
  const activityElement = document.getElementById('agent-activity');
  const activityLabel = document.getElementById('agent-activity-label');
  const messagesElement = document.getElementById('messages');
  const activitySettings = document.getElementById('settings-open');
  const installedKitList = document.getElementById('installed-kit-list');
  const leftColumn = document.querySelector('.left-column');
  const studio = document.querySelector('.studio');
  const workbenchSplitter = document.getElementById('workbench-splitter');
  const canvasHost = document.getElementById('canvas-host');
  const canvasEmpty = document.getElementById('canvas-empty');
  const canvasTitle = document.getElementById('canvas-title');
  const canvasState = document.getElementById('canvas-state');
  const canvasStateDot = document.getElementById('canvas-state-dot');
  const exportCurrentButton = document.getElementById('export-current');
  const undoCanvasButton = document.getElementById('canvas-undo');
  const modelSelect = document.getElementById('chat-model');
  const templateSelect = document.getElementById('prompt-template');
  const connectionDot = document.getElementById('connection-dot');
  const newChatButton = document.getElementById('new-chat');
  const chatHistoryButton = document.getElementById('chat-history-open');
  const chatHistoryPanel = document.getElementById('chat-history-panel');
  const chatHistoryList = document.getElementById('chat-history-list');
  const chatHistoryStatus = document.getElementById('chat-history-status');
  const conversationPanel = document.getElementById('conversation-panel');
  const conversationButton = document.getElementById('nav-chat');
  const unreadBadge = document.getElementById('chat-unread');
  const starterComposer = document.getElementById('canvas-start-composer');
  const conversationContent = document.getElementById('conversation-content');
  const historyNewChatButton = document.getElementById('history-new-chat');
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  const copyText = typeof navigator !== 'undefined' && navigator.clipboard?.writeText
    ? (value) => navigator.clipboard.writeText(value)
    : null;
  let activeCanvasId = '';
  let activeDocumentPath = '';
  let activePreviewKind = 'empty';
  let starterDocument = false;
  let starterSubmitted = false;
  let unreadMessages = 0;
  let insertedStarterPrompt = '';
  const notifiedCanvasInputs = new Set();
  let activeUndoAvailable = false;
  let creationKind = 'document';
  let modelSaving = false;
  let credentialsSaving = false;
  let chatBusy = true;
  let agentRunning = false;
  let stopPending = false;
  let canvasResumeBusy = false;
  let backendHistoryBusy = false;
  let chatSnapshotEpoch = 0;
  const canvasResumeRequests = new Set();
  const canvasInputs = new Map();
  const canvasInputNodes = new Map();
  const canvasAnswerIds = new Set();
  let activeChatId = '';
  const assetPreviews = new Map();
  const pendingAssetCaptions = new Map();
  let pendingAttachments = [];
  const messageObjectUrls = new Set();
  let localSkills = readLocalSkills(storage);
  let installedSkills = [];
  let editingSkillId = '';
  let savedSettings = { litellmModel: '', activeConnectionId: '', connections: [] };
  let nativeDialogOpen = false;
  let filesCanvasId = '';
  let fileReadVersion = 0;
  let fileReading = false;
  let fileDeleting = false;
  let currentFilePage = null;
  let themedDropdowns = [];
  let agentControlUi = null;
  const streamingMessages = new Map();
  const notifiedMediaJobs = new Set();
  const workspace = createProjectWorkspace({
    document, client, storage,
    onSelection: updateCanvasState,
    onStatus: (text, error) => setStatus(statusElement, text, error),
    onBounds: updateCanvasBounds,
    onAttach: (file) => {
      if (agentControlUi?.isExternal()) { setStatus(statusElement, 'Use media through your connected MCP client, or switch agents under Settings > Agent.'); return; }
      showConversation(); addAttachmentFiles([file]); messageInput.focus();
    },
    onCreate: openNewCanvasDialog,
    onFiles: openCanvasFiles,
    onBusy: updateSendState,
    onDrawerChange: (open) => {
      if (open) {
        studio.dataset.sidebar = 'open';
        chatHistoryPanel.hidden = true;
        chatHistoryPanel.inert = true;
        chatHistoryButton.setAttribute('aria-expanded', 'false');
      }
      conversationPanel.inert = open || !chatHistoryPanel.hidden || studio.dataset.sidebar === 'closed';
      conversationButton.setAttribute('aria-pressed', String(!conversationPanel.inert));
      chatHistoryButton.setAttribute('aria-pressed', String(!open && !chatHistoryPanel.hidden));
      if (!conversationPanel.inert) clearUnreadMessages();
    },
    isBusy: () => chatBusy || canvasResumeBusy || backendHistoryBusy || Boolean(agentControlUi?.getState()?.busy),
  });
  async function loadChatMedia(asset) {
    try { return await client.getLibraryAsset(asset.assetId); }
    catch (error) {
      if (!asset.projectId) throw error;
      return client.getProjectAsset(asset.projectId, asset.assetId);
    }
  }
  const mediaPreviewOptions = {
    loadAsset: loadChatMedia,
    objectUrls: messageObjectUrls,
    newMedia: (assetId) => workspace.isMediaNew(assetId),
    onSeen: (assetId) => {
      workspace.markMediaSeen(assetId);
      const badge = assetPreviews.get(assetId)?.message.querySelector('.message-media-badge');
      if (badge) badge.hidden = true;
    },
    onOpen: async (asset) => {
      await workspace.openMediaReference(asset);
      mediaPreviewOptions.onSeen(asset.assetId);
    },
    onDownload: async (asset) => {
      nativeDialogOpen = true;
      updateCanvasBounds();
      try { await client.saveLibraryAsset(asset.assetId); }
      finally { nativeDialogOpen = false; updateCanvasBounds(); }
    },
    onUse: async (asset) => {
      if (agentControlUi?.isExternal()) throw new Error('Use this media through your connected MCP client, or switch agents under Settings > Agent.');
      if (chatBusy || canvasResumeBusy) throw new Error('Wait for the current reply before adding a reference.');
      const full = await loadChatMedia(asset);
      if (chatBusy || canvasResumeBusy) throw new Error('Wait for the current reply before adding a reference.');
      const bytes = Uint8Array.from(atob(full.data), (character) => character.charCodeAt(0));
      await addAttachmentFiles([new File([bytes], full.name || asset.name, { type: full.mimeType })]);
      mediaPreviewOptions.onSeen(asset.assetId);
      showConversation();
    },
  };
  function disposeMediaPreviews() {
    for (const preview of assetPreviews.values()) preview.dispose?.();
    assetPreviews.clear();
  }
  function showReadyMedia(event, { automatic = true } = {}) {
    workspace.announceMediaReady(event);
    if ((event.chatId || event.job?.chatId) !== activeChatId) return;
    const added = appendReadyMediaCards({ document, messagesElement, event, assetPreviews, options: mediaPreviewOptions });
    if (added) receivedMessage();
    const canOpen = () => canAutoPreviewMedia({ event, activeChatId, projectId: workspace.getProjectId(), previewKind: workspace.getPreviewKind(),
      busy: chatBusy || canvasResumeBusy, draft: messageInput.value, attachments: pendingAttachments.length });
    const assets = event.assets || event.result?.assets || event.job?.assets || [];
    if (automatic && added && canOpen() && assets[0]) workspace.openMediaReference(assets[0], { onlyWhenEmpty: true, canOpen })
      .then((opened) => { if (opened) mediaPreviewOptions.onSeen(assets[0].assetId || assets[0].id); })
      .catch((error) => setStatus(statusElement, `Media saved. Open it from Media to preview it: ${error.message}`, true));
  }
  themedDropdowns = [...document.querySelectorAll('select')].map((select) => createThemedDropdown(select, { onOpenChange: updateCanvasBounds }));

  function showConversation(focus = true) {
    const hadUnread = unreadMessages > 0;
    studio.dataset.sidebar = 'open';
    workspace.setDrawer(false, false);
    chatHistoryPanel.hidden = true;
    chatHistoryPanel.inert = true;
    conversationPanel.inert = false;
    conversationButton.setAttribute('aria-pressed', 'true');
    chatHistoryButton.setAttribute('aria-pressed', 'false');
    chatHistoryButton.setAttribute('aria-expanded', 'false');
    dockComposer(false);
    if (hadUnread) messagesElement.scrollTop = messagesElement.scrollHeight;
    clearUnreadMessages();
    updateCanvasBounds();
    if (focus) messageInput.focus();
  }

  function dockComposer(centered) {
    // Moving the same form preserves its draft, attachments, and event handlers.
    const target = centered ? starterComposer : conversationContent;
    if (chatForm.parentElement !== target) target.append(chatForm);
    if (statusElement.parentElement !== target) {
      if (centered) target.append(statusElement);
      else target.insertBefore(statusElement, chatForm);
    }
    canvasEmpty.dataset.composing = String(centered);
  }

  function showStarterComposer(focus = false) {
    studio.dataset.sidebar = 'closed';
    workspace.setDrawer(false, false);
    chatHistoryPanel.hidden = true;
    chatHistoryPanel.inert = true;
    conversationPanel.inert = true;
    conversationButton.setAttribute('aria-pressed', 'false');
    chatHistoryButton.setAttribute('aria-pressed', 'false');
    chatHistoryButton.setAttribute('aria-expanded', 'false');
    dockComposer(true);
    updateCanvasBounds();
    if (focus) messageInput.focus();
  }

  function clearUnreadMessages() {
    unreadMessages = 0;
    updateUnreadBadge();
  }

  function updateUnreadBadge() {
    unreadBadge.hidden = unreadMessages === 0;
    unreadBadge.textContent = unreadMessages > 99 ? '99+' : String(unreadMessages);
    const label = unreadMessages ? `Show conversation, ${unreadMessages} unread ${unreadMessages === 1 ? 'message' : 'messages'}` : 'Show conversation';
    conversationButton.setAttribute('aria-label', label);
    conversationButton.title = unreadMessages ? `${unreadMessages} unread ${unreadMessages === 1 ? 'message' : 'messages'}` : 'Conversation';
  }

  function receivedMessage() {
    if (conversationIsReadable() && messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 56) return;
    unreadMessages += 1;
    updateUnreadBadge();
  }

  document.getElementById('chat-hide').addEventListener('click', () => {
    studio.dataset.sidebar = 'closed';
    conversationPanel.inert = true;
    conversationButton.setAttribute('aria-pressed', 'false');
    if (!canvasEmpty.hidden) dockComposer(true);
    updateCanvasBounds();
    conversationButton.focus();
  });

  function showHistory() {
    studio.dataset.sidebar = 'open';
    chatHistoryPanel.hidden = false;
    workspace.setDrawer(false, false);
    chatHistoryPanel.inert = false;
    conversationPanel.inert = true;
    conversationButton.setAttribute('aria-pressed', 'false');
    chatHistoryButton.setAttribute('aria-pressed', 'true');
    chatHistoryButton.setAttribute('aria-expanded', 'true');
    refreshChatHistory();
    updateCanvasBounds();
    historyNewChatButton.focus();
  }
  conversationButton.addEventListener('click', () => showConversation());
  historyNewChatButton.addEventListener('click', () => newChatButton.click());

  function readStoredValue(key) {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  function workbenchWidthLimits() {
    const available = studio.getBoundingClientRect().width - 44 - 1 - 300;
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

  function selectSettingsSection(id) {
    if (id !== 'agent') agentControlUi?.clearToken();
    for (const item of settingsSections) {
      const active = item.id === id;
      item.tab.setAttribute('aria-selected', String(active));
      item.tab.tabIndex = active ? 0 : -1;
      item.section.hidden = !active;
    }
  }

  function openSettings(id = 'credentials', focusTarget = null) {
    selectSettingsSection(id);
    activitySettings.setAttribute('aria-pressed', 'true');
    if (!settingsDialog.open) openDialog(settingsDialog, focusTarget);
    else focusTarget?.focus();
  }

  function updateCanvasBounds() {
    if (!canvasHost || typeof client.setCanvasBounds !== 'function') return;
    if (nativeDialogOpen || document.querySelector('dialog[open]') || themedDropdowns.some((dropdown) => dropdown.isOpen())) {
      client.setCanvasBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    if (!activeCanvasId || activePreviewKind !== 'document' || !canvasEmpty.hidden) {
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

  function updateFileControls() {
    canvasFilesList.querySelectorAll('.canvas-file-item').forEach((button) => { button.disabled = fileReading || fileDeleting; });
    canvasFilesList.querySelectorAll('.delete-control').forEach((button) => { button.disabled = fileReading || fileDeleting || chatBusy || canvasResumeBusy || workspace.isOperating(); });
    canvasFilePrevious.disabled = fileReading || fileDeleting || !currentFilePage || currentFilePage.offsets.length < 2;
    canvasFileNext.disabled = fileReading || fileDeleting || !currentFilePage || currentFilePage.nextOffset === null;
  }

  async function readCanvasFilePage(path, offset = 0, offsets = [0]) {
    if (!filesCanvasId) return;
    const canvasId = filesCanvasId;
    const version = ++fileReadVersion;
    fileReading = true;
    canvasFilePath.textContent = path;
    setStatus(canvasFileStatus, 'Loading source...');
    updateFileControls();
    try {
      const result = await client.readCanvasFile(canvasId, { path, offset, maxBytes: 24_000 });
      if (version !== fileReadVersion || !canvasFilesDialog.open) return;
      currentFilePage = { path, offsets, nextOffset: result.nextOffset };
      canvasFileSource.textContent = result.text;
      canvasFileSource.scrollTop = 0;
      canvasFileSource.scrollLeft = 0;
      const end = result.nextOffset ?? result.totalBytes;
      setStatus(canvasFileStatus, result.totalBytes
        ? `Bytes ${(result.offset + 1).toLocaleString()}-${end.toLocaleString()} of ${result.totalBytes.toLocaleString()}`
        : 'This file is empty.');
      for (const button of canvasFilesList.querySelectorAll('.canvas-file-item')) button.setAttribute('aria-current', String(button.dataset.path === path));
    } catch (error) {
      if (version !== fileReadVersion || !canvasFilesDialog.open) return;
      canvasFileSource.textContent = '';
      currentFilePage = null;
      setStatus(canvasFileStatus, error?.message || 'Could not read this file. Select it to try again.', true);
    } finally {
      if (version === fileReadVersion) {
        fileReading = false;
        updateFileControls();
      }
    }
  }

  async function openCanvasFiles(selectedPath, projectId = activeCanvasId) {
    if (!projectId || typeof client.listCanvasFiles !== 'function') return;
    filesCanvasId = projectId;
    const canvasId = filesCanvasId;
    const version = ++fileReadVersion;
    currentFilePage = null;
    fileReading = true;
    canvasFilesList.replaceChildren();
    canvasFilePath.textContent = 'Select a file';
    canvasFileSource.textContent = '';
    document.getElementById('canvas-files-description').textContent = `${canvasTitle.textContent} - saved source. Edits are made through chat.`;
    setStatus(canvasFilesSummary, 'Loading files...');
    setStatus(canvasFileStatus, '');
    updateFileControls();
    if (!canvasFilesDialog.open) openDialog(canvasFilesDialog, document.getElementById('canvas-files-close'));
    try {
      const project = await client.listCanvasFiles(canvasId);
      if (version !== fileReadVersion || !canvasFilesDialog.open) return;
      const files = Array.isArray(project.files) ? project.files : [];
      document.getElementById('canvas-files-description').textContent = `${project.title || canvasTitle.textContent} - saved source. Edits are made through chat.`;
      canvasFilesList.replaceChildren(...files.map((file) => {
        const row = document.createElement('div');
        row.className = 'canvas-file-row';
        const button = createButton(document, '', 'canvas-file-item', () => readCanvasFilePage(file.path));
        button.dataset.path = file.path;
        const name = document.createElement('span');
        name.textContent = file.path;
        const size = document.createElement('small');
        size.textContent = `${Number(file.bytes || 0).toLocaleString()} bytes`;
        button.append(name, size);
        row.append(button, createDeleteButton(document, `Delete ${file.path}`, () => deleteCanvasSourceFile(file.path)));
        return row;
      }));
      const kitCount = project.manifest?.kits?.length || 0;
      const assetCount = project.manifest?.assets?.length || 0;
      setStatus(canvasFilesSummary, files.length
        ? `${files.length} source file${files.length === 1 ? '' : 's'}. ${kitCount} kit${kitCount === 1 ? '' : 's'} and ${assetCount} media asset${assetCount === 1 ? '' : 's'} are stored separately.`
        : 'No saved source files are available for this canvas.');
      fileReading = false;
      updateFileControls();
      const initial = files.find((file) => file.path === selectedPath) || files.find((file) => file.path === activeDocumentPath) || files.find((file) => file.path === project.manifest?.entry) || files[0];
      if (initial) await readCanvasFilePage(initial.path);
    } catch (error) {
      if (version !== fileReadVersion || !canvasFilesDialog.open) return;
      fileReading = false;
      updateFileControls();
      setStatus(canvasFilesSummary, error?.message || 'Could not load canvas files. Close this panel and try again.', true);
    }
  }

  async function handleDeletionEvent(event) {
    const selectedPath = currentFilePage?.path;
    await workspace.acceptDeletion(event);
    if ((event.type === 'project-deleted' || event.projectDeleted) && canvasFilesDialog.open && filesCanvasId === event.projectId) {
      canvasFilesDialog.close();
      return;
    }
    if (event.type === 'project-file-deleted' && canvasFilesDialog.open && filesCanvasId === event.projectId) {
      await openCanvasFiles(selectedPath === event.deletedPath ? event.documentPath : selectedPath, event.projectId);
    }
  }

  async function deleteCanvasSourceFile(path) {
    if (!filesCanvasId || fileReading || fileDeleting || chatBusy || canvasResumeBusy || workspace.isOperating()) return;
    const projectId = filesCanvasId;
    fileDeleting = true;
    nativeDialogOpen = true;
    updateFileControls();
    updateCanvasBounds();
    try {
      const result = await client.deleteProjectFile(projectId, { path });
      if (!result?.deleted) return;
      await handleDeletionEvent({ ...result, type: result.projectDeleted ? 'project-deleted' : 'project-file-deleted', projectId, deletedPath: path });
      setStatus(statusElement, result.projectDeleted ? 'Project deleted.' : `Deleted ${path}.`);
    } catch (error) {
      setStatus(canvasFileStatus, error?.message || 'Could not delete this file. Try again.', true);
    } finally {
      fileDeleting = false;
      nativeDialogOpen = false;
      updateFileControls();
      updateCanvasBounds();
      canvasFilesList.querySelector('.canvas-file-item[aria-current="true"]')?.focus();
    }
  }

  canvasFilesButton?.addEventListener('click', () => openCanvasFiles());
  document.getElementById('canvas-files-close')?.addEventListener('click', () => canvasFilesDialog.close());
  canvasFilesDialog?.addEventListener('close', () => {
    fileReadVersion += 1;
    filesCanvasId = '';
    fileReading = false;
    updateCanvasBounds();
  });
  canvasFilePrevious?.addEventListener('click', () => {
    if (!currentFilePage || fileReading || currentFilePage.offsets.length < 2) return;
    const offsets = currentFilePage.offsets.slice(0, -1);
    readCanvasFilePage(currentFilePage.path, offsets.at(-1), offsets);
  });
  canvasFileNext?.addEventListener('click', () => {
    if (!currentFilePage || fileReading || currentFilePage.nextOffset === null) return;
    readCanvasFilePage(currentFilePage.path, currentFilePage.nextOffset, [...currentFilePage.offsets, currentFilePage.nextOffset]);
  });
  canvasDevicesButton?.addEventListener('click', async () => {
    if (!activeCanvasId || nativeDialogOpen || typeof client.manageCanvasDevices !== 'function') return;
    const canvasId = activeCanvasId;
    nativeDialogOpen = true;
    canvasDevicesButton.disabled = true;
    updateCanvasBounds();
    try {
      const permissions = await client.manageCanvasDevices(canvasId);
      setStatus(statusElement, `Camera ${permissions?.camera ? 'allowed' : 'not allowed'}; microphone ${permissions?.microphone ? 'allowed' : 'not allowed'}.`);
    } catch (error) {
      setStatus(statusElement, error?.message || 'Could not manage canvas devices. Try again.', true);
    } finally {
      nativeDialogOpen = false;
      canvasDevicesButton.disabled = !activeCanvasId || activePreviewKind !== 'document';
      updateCanvasBounds();
    }
  });

  function updateSendState() {
    const control = agentControlUi?.getState();
    const external = agentControlUi?.isExternal();
    const busy = chatBusy || canvasResumeBusy || backendHistoryBusy || Boolean(control?.busy) || workspace.isOperating();
    const running = agentRunning || canvasResumeBusy || Boolean(control?.busy);
    const ready = agentControlUi?.isReady() && (control.backend !== 'builtin' || Boolean(savedSettings.litellmModel));
    agentControlUi?.setBusy(chatBusy || canvasResumeBusy || backendHistoryBusy || agentRunning || workspace.isOperating());
    workspace.updateBusy();
    document.getElementById('new-canvas-open').disabled = busy;
    document.querySelectorAll('[data-starter], .prompt-suggestion').forEach((button) => { button.disabled = busy || external; });
    undoCanvasButton.disabled = busy || activePreviewKind !== 'document' || !activeUndoAvailable;
    sendButton.disabled = external || (running ? stopPending : busy || modelSaving || credentialsSaving || !ready || (!messageInput.value.trim() && pendingAttachments.length === 0));
    sendButton.dataset.action = running ? 'stop' : 'send';
    document.getElementById('send-label').textContent = running ? stopPending ? 'Stopping...' : 'Stop' : 'Send';
    sendButton.setAttribute('aria-label', running ? stopPending ? 'Stopping agent' : 'Stop agent' : 'Send message');
    sendButton.title = running ? 'Stop the current reply; completed edits are kept' : 'Send message';
    sendButton.querySelector('svg path').setAttribute('d', running ? 'M4 4h8v8H4Z' : 'M3 8h9M8 4l4 4-4 4');
    messageInput.disabled = busy || external;
    attachMediaButton.disabled = busy || external;
    mediaFileInput.disabled = busy || external;
    attachmentStrip.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
    newChatButton.disabled = busy || agentControlUi?.isExternal();
    historyNewChatButton.disabled = busy || agentControlUi?.isExternal();
    chatHistoryButton.disabled = busy;
    chatHistoryList.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
    modelSelect.disabled = busy || modelSaving || credentialsSaving || !modelSelect.querySelector('option[value]:not([value=""])');
    templateSelect.disabled = busy || external;
    for (const node of canvasInputNodes.values()) if (node.retry) node.retry.disabled = busy || external || !ready || modelSaving || credentialsSaving || node.retrying;
    if (canvasResumeBusy) activityElement.hidden = false;
    updateFileControls();
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
    if (chatBusy || canvasResumeBusy) return;
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

  function refreshSkillUi() {
    renderSkillList({
      document,
      listElement: skillList,
      emptyElement: skillEmpty,
      skills: localSkills,
      compatibility: localSkillCompatibility,
      onToggle: (id, enabled) => {
        const support = localSkillCompatibility(localSkills.find((skill) => skill.id === id));
        if (enabled && !support.supported) { setStatus(skillStatus, support.reason, true); refreshSkillUi(); return; }
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
    const supported = installedSkills.filter((skill) => skill.compatibility === 'supported');
    const rows = supported.map((skill) => {
      const row = document.createElement('div');
      row.className = 'installed-skill-row';
      const name = document.createElement('span');
      name.className = 'installed-skill-name';
      name.textContent = skill.name;
      name.title = [skill.description, skill.requiredKits?.length ? `Uses project kits: ${skill.requiredKits.join(', ')}.` : ''].filter(Boolean).join(' ');
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
    const unavailable = installedSkills.filter((skill) => skill.compatibility !== 'supported');
    if (unavailable.length) {
      const details = document.createElement('details');
      details.className = 'unavailable-skills';
      const summary = document.createElement('summary');
      summary.textContent = `${unavailable.length} unavailable recipes`;
      details.append(summary);
      for (const skill of unavailable) {
        const item = document.createElement('p');
        item.textContent = `${skill.name}: ${skill.reason || 'Compatibility with this client has not been reviewed.'}`;
        details.append(item);
      }
      rows.push(details);
    }
    installedSkillList.replaceChildren(...rows);
    installedSkillCount.textContent = `${supported.length} compatible`;
  }
  function localSkillCompatibility(skill) {
    return skillCompatibility(skill, installedSkills);
  }

  async function refreshInstalledSkillCatalog() {
    try {
      installedSkills = await client.listInstalledSkills();
      const next = localSkills.map((skill) => skill.enabled && !localSkillCompatibility(skill).supported ? { ...skill, enabled: false } : skill);
      if (next.some((skill, index) => skill.enabled !== localSkills[index].enabled)) localSkills = writeLocalSkills(next, storage);
      refreshSkillUi();
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

  function attachmentPreviews(attachments) {
    return (attachments || []).flatMap((attachment) => {
      if (!attachment || !['image', 'audio', 'video'].includes(attachment.type)) return [];
      const preview = { type: attachment.type, name: attachment.name || 'Canvas capture', mimeType: attachment.mimeType };
      if (typeof attachment.data === 'string') {
        try {
          const bytes = Uint8Array.from(atob(attachment.data), (character) => character.charCodeAt(0));
          preview.previewUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
          messageObjectUrls.add(preview.previewUrl);
        } catch {}
      }
      return [preview];
    });
  }

  function renderCanvasInputNote(request) {
    if (!request || typeof request.id !== 'string') return;
    canvasInputs.set(request.id, request);
    const previous = canvasInputNodes.get(request.id);
    if (['cancelled', 'superseded'].includes(request.status) || (request.status === 'completed' && !request.actionError)) {
      previous?.message.remove();
      canvasInputNodes.delete(request.id);
      return;
    }
    const shouldFollow = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 56;
    const note = previous?.message || document.createElement('article');
    note.className = 'canvas-input-note';
    note.dataset.status = request.status || 'pending';
    note.dataset.requestId = request.id;
    const heading = document.createElement('strong');
    heading.textContent = request.kind === 'choice' ? request.question : 'Capture shared from canvas';
    const detail = document.createElement('p');
    const statusCopy = {
      pending: 'Choose an option in the canvas to continue.',
      answered: 'Your response is saved. The agent will continue when this canvas is open.',
      queued: 'Your capture is saved. The agent will continue when this canvas is open.',
      dispatching: 'Continuing from your canvas response...',
      failed: 'Your response is saved. The agent could not continue.',
      interrupted: 'Your response is saved. The previous reply was interrupted.',
      completed: 'Your response was sent to the agent.',
    };
    detail.textContent = statusCopy[request.status] || 'Your response is saved.';
    if (request.error && ['failed', 'interrupted'].includes(request.status)) detail.textContent += ` ${request.error}`;
    if (request.actionError) detail.textContent += ' The canvas could not reset automatically.';
    note.replaceChildren(heading, detail);
    const actions = document.createElement('div');
    actions.className = 'button-row';
    if (request.canvasId !== activeCanvasId || activePreviewKind !== 'document' || (request.documentPath && request.documentPath !== activeDocumentPath)) {
      const open = createButton(document, 'Open canvas', 'button outline small', async () => {
        open.disabled = true;
        try {
          const documentPath = request.documentPath || (await client.listCanvasFiles(request.canvasId)).manifest.entry;
          await openCanvas({ id: request.canvasId, documentPath });
          for (const input of canvasInputs.values()) renderCanvasInputNote(input);
        } catch {} finally { open.disabled = false; }
      });
      actions.append(open);
    }
    const node = { message: note, retry: null, retrying: false };
    if (['failed', 'interrupted'].includes(request.status)) {
      node.retry = createButton(document, 'Retry response', 'button outline small', async () => {
        if (chatBusy || canvasResumeBusy || node.retrying || agentControlUi?.isExternal() || !agentControlUi?.isReady() || agentControlUi.getState()?.busy) return;
        node.retrying = true;
        node.retry.textContent = 'Retrying...';
        canvasResumeRequests.add(request.id);
        canvasResumeBusy = true;
        activityLabel.textContent = 'Continuing from your canvas response...';
        updateSendState();
        try {
          const result = await client.retryCanvasInput(request.id);
          if (result?.request && canvasInputs.get(request.id) === request) renderCanvasInputNote(result.request);
        } catch (error) {
          canvasResumeRequests.delete(request.id);
          canvasResumeBusy = canvasResumeRequests.size > 0;
          if (!chatBusy && !canvasResumeBusy) activityElement.hidden = true;
          detail.textContent = error?.message || 'Could not retry this response. Try again.';
          setStatus(statusElement, detail.textContent, true);
        } finally {
          node.retrying = false;
          node.retry.textContent = 'Retry response';
          updateSendState();
        }
      });
      node.retry.disabled = chatBusy || canvasResumeBusy || modelSaving || credentialsSaving || agentControlUi?.isExternal() || !agentControlUi?.isReady() || agentControlUi.getState()?.busy;
      actions.append(node.retry);
    }
    if (actions.children.length) note.append(actions);
    canvasInputNodes.set(request.id, node);
    if (!previous) messagesElement.append(note);
    if (shouldFollow) messagesElement.scrollTop = messagesElement.scrollHeight;
  }

  function renderCanvasInputAnswer(request, text, attachments = []) {
    if (!request?.id || canvasAnswerIds.has(request.id)) return;
    const displayText = request.kind === 'choice'
      ? canvasInputDisplayText({ content: text }, request)
      : text || request.prompt || 'Review the media I shared from the canvas.';
    appendTextMessage(document, messagesElement, 'user', displayText, { attachments: attachmentPreviews(attachments) });
    canvasAnswerIds.add(request.id);
  }

  function handleCanvasInputEvent(event) {
    if (!['canvas-input', 'canvas-input-answer', 'canvas-input-resume-start', 'canvas-input-resume-end'].includes(event?.type)) return false;
    const request = event.request;
    if (!request?.id) return true;
    const requestChatId = event.chatId || request.chatId;
    if (activeChatId && requestChatId && activeChatId !== requestChatId) return true;
    if (!activeChatId && requestChatId) activeChatId = requestChatId;
    if (event.type === 'canvas-input-resume-start') {
      canvasResumeRequests.add(request.id);
      canvasResumeBusy = true;
      activityLabel.textContent = 'Continuing from your canvas response...';
      activityElement.hidden = false;
      setStatus(statusElement, '');
    } else if (event.type === 'canvas-input-resume-end') {
      canvasResumeRequests.delete(request.id);
      canvasResumeBusy = canvasResumeRequests.size > 0;
      if (!canvasResumeBusy) stopPending = false;
      if (!chatBusy && !canvasResumeBusy) activityElement.hidden = true;
      if (event.saveWarning) setStatus(statusElement, event.saveWarning, true);
      else if (event.cancelled) setStatus(statusElement, 'Stopped. Your canvas response is saved; use Retry response to continue.');
      else if (event.error) setStatus(statusElement, event.error, true);
    } else if (event.type === 'canvas-input-answer') {
      renderCanvasInputAnswer(request, event.text, event.attachments?.length ? event.attachments : request.attachments);
    } else if (request.kind === 'choice' && request.value) {
      renderCanvasInputAnswer(request, '', []);
    }
    renderCanvasInputNote(request);
    updateSendState();
    return true;
  }

  function restoreChat(chat, { preserveComposer = false } = {}) {
    streamingMessages.clear();
    clearUnreadMessages();
    notifiedCanvasInputs.clear();
    activeChatId = chat.id || '';
    messagesElement.replaceChildren();
    canvasInputs.clear();
    canvasInputNodes.clear();
    canvasAnswerIds.clear();
    canvasResumeRequests.clear();
    for (const request of chat.canvasInputs || []) {
      canvasInputs.set(request.id, request);
      if (request.status === 'dispatching') canvasResumeRequests.add(request.id);
    }
    canvasResumeBusy = canvasResumeRequests.size > 0;
    disposeMediaPreviews();
    pendingAssetCaptions.clear();
    if (!preserveComposer) pendingAttachments = [];
    const retainedUrls = new Set(pendingAttachments.map((attachment) => attachment.previewUrl));
    for (const url of messageObjectUrls) {
      if (retainedUrls.has(url)) continue;
      URL.revokeObjectURL(url);
      messageObjectUrls.delete(url);
    }
    renderPendingAttachments();
    const images = new Map((chat.images || []).map((image) => [image.assetId, image]));
    const media = new Map((chat.media || []).map((asset) => [`${asset.requestId}:${asset.assetId}`, asset]));
    const generatedMedia = new Map((chat.media || []).filter((asset) => !asset.requestId).map((asset) => [asset.assetId, asset]));
    for (const message of chat.history || []) {
      if (message.role === 'tool' || message.mediaJobResult) {
        try {
          const result = message.mediaJobResult || JSON.parse(message.content);
          if (message.mediaJobResult && result.status !== 'ready') appendTextMessage(document, messagesElement, 'assistant', `Generation failed: ${result.error || 'The service reported a failure.'}`, { copyText });
          const assets = (result.assets || []).map((asset) => ({ ...asset, ...(images.get(asset.assetId) || generatedMedia.get(asset.assetId) || {}) }));
          if (message.mediaJobResult) {
            workspace.announceMediaReady({ job: result, assets });
            notifiedMediaJobs.add(message.mediaJobId);
          }
          appendReadyMediaCards({ document, messagesElement, event: { ...result, chatId: chat.id, assets }, assetPreviews, options: mediaPreviewOptions });
        } catch {}
        continue;
      }
      if (!['user', 'assistant'].includes(message.role) || message.tool_calls?.length) continue;
      const parts = Array.isArray(message.content) ? message.content : [];
      let text = typeof message.content === 'string' ? message.content : parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      if (!text) continue;
      const references = message.canvasMediaRefs || [];
      const attachments = attachmentPreviews([
        ...parts.filter((part) => ['image', 'audio'].includes(part.type) && typeof part.data === 'string'),
        ...references.map((reference) => media.get(`${message.canvasInputRequestId}:${reference.assetId}`) || reference),
      ]);
      if (message.canvasInputRequestId) {
        text = canvasInputDisplayText(message, canvasInputs.get(message.canvasInputRequestId));
        canvasAnswerIds.add(message.canvasInputRequestId);
      }
      const imageMode = /^Create one image with size /.test(text);
      if (imageMode) text = text.replace(/^Create one image with size [^\n]*\n/, '');
      appendTextMessage(document, messagesElement, message.role, text, {
        mode: imageMode ? 'image' : 'chat', attachments, copyText, assetPreviews, pendingAssetCaptions,
      });
    }
    for (const request of [...canvasInputs.values()].reverse()) {
      if (request.kind === 'choice' && request.value) renderCanvasInputAnswer(request, '', []);
      renderCanvasInputNote(request);
    }
    if (!messagesElement.children.length) messagesElement.append(createWelcomeMessage(document, (prompt) => {
      messageInput.value = prompt;
      updateSendState();
      messageInput.focus();
    }));
    messagesElement.scrollTop = chat.history?.length ? messagesElement.scrollHeight : 0;
    if (chat.error) setStatus(statusElement, chat.error, true);
    if (chat.mediaTruncated && !chat.error) setStatus(statusElement, 'Some older capture previews were omitted. Their saved filenames are still shown.');
    if (canvasResumeBusy) activityLabel.textContent = 'Continuing from your canvas response...';
    updateSendState();
    if (typeof client.acknowledgeChat === 'function') client.acknowledgeChat(chat.id || '')
      .catch((error) => setStatus(statusElement, `Chat restored, but the agent could not resume: ${error.message}`, true));
  }

  async function restoreBackendChat(backend) {
    const snapshotEpoch = ++chatSnapshotEpoch;
    backendHistoryBusy = true;
    updateSendState();
    try {
      const chat = await client.getCurrentChat({ deferResume: true });
      if (snapshotEpoch !== chatSnapshotEpoch || backend !== agentControlUi.getState()?.backend) return;
      restoreChat(chat, { preserveComposer: true });
      if (!chatHistoryPanel.hidden) await refreshChatHistory();
    } catch (error) {
      if (snapshotEpoch === chatSnapshotEpoch) setStatus(statusElement, error?.message || 'Could not restore this agent conversation. Try reopening its chat.', true);
    } finally {
      if (snapshotEpoch === chatSnapshotEpoch) { backendHistoryBusy = false; updateSendState(); }
    }
  }

  async function refreshChatHistory() {
    setStatus(chatHistoryStatus, 'Loading saved chats…');
    try {
      const chats = await client.listChats();
      chatHistoryList.replaceChildren(...chats.map((chat) => {
        const button = createButton(document, '', 'chat-history-row', async () => {
          if (chatBusy || canvasResumeBusy || backendHistoryBusy || agentControlUi.getState()?.busy) return;
          const snapshotEpoch = ++chatSnapshotEpoch;
          chatBusy = true;
          updateSendState();
          setStatus(chatHistoryStatus, 'Opening chat…');
          try {
            const snapshot = await client.openChat(chat.id);
            if (snapshotEpoch !== chatSnapshotEpoch) return;
            restoreChat(snapshot);
            showConversation(false);
            setStatus(statusElement, `Opened ${chat.title}.`);
          } catch (error) {
            setStatus(chatHistoryStatus, error?.message || 'Could not open this chat.', true);
          } finally {
            chatBusy = false;
            updateSendState();
            if (chatHistoryPanel.hidden) messageInput.focus();
          }
        });
        button.title = chat.title;
        const title = document.createElement('strong');
        title.textContent = chat.title || 'Untitled chat';
        button.disabled = chatBusy || canvasResumeBusy;
        if (chat.id === activeChatId) button.setAttribute('aria-current', 'true');
        const date = document.createElement('time');
        date.dateTime = new Date(chat.updatedAt).toISOString();
        date.textContent = new Date(chat.updatedAt).toLocaleDateString();
        button.append(title, date);
        return button;
      }));
      setStatus(chatHistoryStatus, chats.length ? '' : 'No saved chats yet. Start a new chat to make something.');
    } catch (error) {
      setStatus(chatHistoryStatus, error?.message || 'Could not load saved chats.', true);
    }
  }

  chatHistoryButton.addEventListener('click', () => {
    showHistory();
  });

  async function refreshAssets() {
    try { await workspace.refreshAssets(); }
    catch (error) { setStatus(statusElement, error?.message || 'Could not load media.', true); }
  }

  async function refreshCanvases(restore = false) {
    try { await workspace.refreshProjects(restore); }
    catch (error) { setStatus(statusElement, error?.message || 'Could not load projects.', true); }
  }

  function updateCanvasState(canvas) {
    const nextId = canvas?.projectId || canvas?.id || '';
    const nextPath = canvas?.documentPath || '';
    if (nextId !== activeCanvasId || nextPath !== activeDocumentPath) starterSubmitted = false;
    activeCanvasId = nextId;
    activeDocumentPath = nextPath;
    activePreviewKind = canvas?.previewKind || 'empty';
    starterDocument = activePreviewKind === 'document' && canvas?.starterDocument === true;
    activeUndoAvailable = canvas?.undoAvailable === true;
    canvasTitle.textContent = canvas?.documentTitle || canvas?.title || 'Project';
    const mediaPreview = ['image', 'video', 'audio'].includes(activePreviewKind);
    canvasState.textContent = mediaPreview ? activePreviewKind[0].toUpperCase() + activePreviewKind.slice(1) : starterDocument ? 'Ready' : activePreviewKind === 'document' ? 'HTML' : activeCanvasId ? 'Project' : 'Ready';
    canvasStateDot.classList.toggle('ready', Boolean(activeCanvasId));
    exportCurrentButton.textContent = mediaPreview ? `Download ${activePreviewKind}` : 'Export project';
    exportCurrentButton.disabled = !activeCanvasId && !mediaPreview;
    canvasFilesButton.disabled = !activeCanvasId;
    canvasDevicesButton.disabled = activePreviewKind !== 'document' || nativeDialogOpen;
    canvasEmpty.hidden = activePreviewKind !== 'empty' && !starterDocument;
    if (canvasEmpty.hidden) dockComposer(false);
    else if (!starterSubmitted && !agentRunning && !canvasResumeBusy) showStarterComposer();
    for (const request of canvasInputs.values()) renderCanvasInputNote(request);
    updateSendState();
    updateCanvasBounds();
  }

  async function openCanvas(canvas) {
    try { await workspace.openProject(canvas.id, canvas.documentPath); }
    catch (error) { setStatus(statusElement, error?.message || 'Could not open project.', true); throw error; }
  }

  const connectionUi = createConnectionSettings({
    document, client, onSettings: applySettings,
    onBusy: (busy) => { credentialsSaving = busy; updateSendState(); },
    onRendered: updateSendState,
  });

  agentControlUi = createAgentControlUi({
    document, client, copyText,
    onStateChange: () => { updateConnectionStatus(); updateSendState(); updateCanvasBounds(); },
    onOpenSettings: () => openSettings('agent'),
  });

  function updateConnectionStatus() {
    const control = agentControlUi?.getState();
    const configured = control?.backend === 'external' ? Boolean(control.external?.enabled && control.external?.connectedClients)
      : control?.backend === 'codex' ? agentControlUi.isReady()
        : Boolean(savedSettings.activeConnectionId && savedSettings.litellmModel);
    connectionDot.classList.toggle('ready', configured);
    connectionDot.classList.toggle('needs-setup', !configured);
    connectionDot.title = control?.backend === 'external' ? configured ? 'External agent connected' : 'Connect an external MCP client under Settings > Agent'
      : control?.backend === 'codex' ? configured ? 'Codex is ready' : 'Connect and sign in under Settings > Agent'
        : configured ? 'Endpoint and model selected' : 'Add credentials and choose a model in chat';
  }

  function applySettings(settings) {
    savedSettings = settings;
    updateConnectionStatus();
    connectionUi.load(settings);
    updateSendState();
  }

  function refreshModelCatalog() { return connectionUi.refresh(); }

  modelSelect.addEventListener('change', async () => {
    if (agentControlUi.getState()?.backend !== 'builtin' || chatBusy || canvasResumeBusy || agentControlUi.getState()?.busy || modelSaving || credentialsSaving || !modelSelect.value) return;
    modelSaving = true;
    updateSendState();
    setStatus(statusElement, 'Switching model...');
    try {
      applySettings(await client.selectModel(JSON.parse(modelSelect.value)));
      setStatus(statusElement, '');
    } catch (error) {
      modelSelect.value = connectionUi.selectedValue();
      setStatus(statusElement, error?.message || 'Could not switch models. Try again.', true);
    } finally { modelSaving = false; updateSendState(); }
  });
  chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (agentControlUi.isExternal()) return;
    if (agentRunning || canvasResumeBusy || agentControlUi.getState()?.busy) {
      if (stopPending) return;
      stopPending = true;
      updateSendState();
      setStatus(statusElement, 'Stopping...');
      try {
        const result = await client.stopAgent();
        if (!result?.stopping) stopPending = false;
      } catch (error) {
        stopPending = false;
        setStatus(statusElement, error?.message || 'Could not stop the agent. Try again.', true);
      }
      updateSendState();
      return;
    }
    if (chatBusy || canvasResumeBusy || backendHistoryBusy || workspace.isOperating() || modelSaving || credentialsSaving || !agentControlUi.isReady() || (agentControlUi.getState()?.backend === 'builtin' && !savedSettings.litellmModel)) return;
    if (!messageInput.value.trim() && pendingAttachments.length === 0) return;
    const startNewChat = chatForm.parentElement === starterComposer && !starterSubmitted && Boolean(activeChatId);
    chatSnapshotEpoch += 1;
    starterSubmitted = true;
    showConversation(false);
    chatBusy = true;
    updateSendState();
    try {
      const attachments = await preparePendingAttachments();
      if (startNewChat) {
        await client.clearChat();
        activeChatId = '';
        messagesElement.replaceChildren();
        streamingMessages.clear();
        canvasInputs.clear();
        canvasInputNodes.clear();
        canvasAnswerIds.clear();
        notifiedCanvasInputs.clear();
        disposeMediaPreviews();
        pendingAssetCaptions.clear();
        const pendingUrls = new Set(pendingAttachments.map((attachment) => attachment.previewUrl));
        for (const url of messageObjectUrls) if (!pendingUrls.has(url)) { URL.revokeObjectURL(url); messageObjectUrls.delete(url); }
      }
      const result = await handleChatSubmit({
        client,
        document,
        input: messageInput,
        button: sendButton,
        statusElement,
        messagesElement,
        mode: 'chat',
        skills: localSkills.filter((skill) => skill.enabled).map(({ name, instructions }) => ({ name, instructions })),
        kits: workspace.getKits(),
        attachments,
        activityElement,
        activityLabel,
        newChatButton,
        copyText,
        onRunStart: () => { agentRunning = true; updateSendState(); },
      });
      activeChatId = result.chatId || activeChatId;
      if (!chatHistoryPanel.hidden) await refreshChatHistory();
      pendingAttachments = [];
      renderPendingAttachments();
    } catch (error) {
      if (startNewChat && activeChatId) starterSubmitted = false;
      if (!statusElement.classList.contains('error')) setStatus(statusElement, error?.message || 'Could not prepare the attached media.', true);
    } finally {
      agentRunning = false;
      stopPending = false;
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
  const promptTemplates = {
    image: 'Generate an image using the image generation tool. Use a square format unless I specify another shape. Brief: ',
    canvas: 'Create an interactive canvas with the selected offline kits. Include clear controls and make it work without network access. Idea: ',
    audio: 'Create an audio sketch on a canvas using Tone.js. Include a Play button that calls Tone.start() from the user gesture, plus Stop and volume controls. Idea: ',
    video: 'Generate a short video with an available video Media model. Submit one job and keep its ID so we can retrieve it when ready. Brief: ',
    storyboard: 'Plan a video storyboard with scenes, timing, transitions, and an audio direction. Present it as a canvas; this is a storyboard, not a generated video. Brief: ',
  };
  templateSelect.addEventListener('change', () => {
    const template = promptTemplates[templateSelect.value];
    if (template) {
      messageInput.value = template + messageInput.value;
      updateSendState();
      messageInput.focus();
      messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
    }
    templateSelect.value = '';
  });
  document.querySelectorAll('.prompt-suggestion').forEach((button) => {
    button.addEventListener('click', () => {
      messageInput.value = button.dataset.prompt || '';
      updateSendState();
      messageInput.focus();
    });
  });
  const starterPrompts = {
    ink: 'Create an interactive generative ink canvas with p5.js. Give me controls for density, motion, and a new seed. Keep it offline. Once it is visible, use a canvas choice to ask whether I prefer a calm or expressive direction, then refine the result from my answer.',
    audio: 'Create a playable ambient soundscape with Tone.js and a responsive visual canvas. Include Play, Stop, and volume controls; start audio only from my Play click and use a worker-free scheduler. Once it is visible, ask me through the canvas whether I want a warm or bright sound and refine from my answer.',
    image: 'Generate an editorial still life of citrus, glass, and soft morning light using an available image model. Save the image to this project. Present a canvas with the image and ask me to choose warm or cool lighting for a variation.',
  };
  document.querySelectorAll('[data-starter]').forEach((button) => {
    button.addEventListener('click', () => {
      if (chatBusy || canvasResumeBusy || workspace.isOperating() || agentControlUi.isExternal() || agentControlUi.getState()?.busy) return;
      const prompt = starterPrompts[button.dataset.starter];
      if (!prompt) return;
      if (messageInput.value.trim() && messageInput.value !== insertedStarterPrompt) messageInput.value = `${messageInput.value.trim()}\n\n${prompt}`;
      else messageInput.value = prompt;
      insertedStarterPrompt = prompt;
      if (!canvasEmpty.hidden) showStarterComposer();
      updateSendState();
      messageInput.focus();
      messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
    });
  });
  for (const [index, item] of settingsSections.entries()) {
    item.tab.addEventListener('click', () => selectSettingsSection(item.id));
    item.tab.addEventListener('keydown', (event) => {
      const direction = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0;
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? settingsSections.length - 1 : direction ? (index + direction + settingsSections.length) % settingsSections.length : null;
      if (target === null) return;
      event.preventDefault();
      selectSettingsSection(settingsSections[target].id);
      settingsSections[target].tab.focus();
    });
  }
  let workbenchPointerId = null;
  const resizeWorkbenchAt = (clientX) => {
    const bounds = leftColumn.getBoundingClientRect();
    applyWorkbenchWidth(clientX - bounds.left);
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
  activitySettings.addEventListener('click', () => openSettings('credentials'));
  document.getElementById('connections-open').addEventListener('click', () => openSettings('credentials'));
  document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
  settingsDialog.addEventListener('close', () => {
    agentControlUi.clearToken();
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
  function openNewCanvasDialog(kind = 'document', name = '') {
    if (chatBusy || canvasResumeBusy) return;
    creationKind = kind === 'document' && !activeCanvasId ? 'project' : kind;
    const rename = creationKind === 'rename';
    const label = rename ? 'Rename project' : creationKind === 'project' ? 'Create project' : 'Create HTML canvas';
    document.getElementById('new-canvas-title').textContent = label;
    document.getElementById('new-item-name-label').textContent = creationKind === 'document' ? 'Canvas name' : 'Project name';
    newCanvasSubmit.textContent = rename ? 'Save name' : label;
    newCanvasName.value = name;
    newCanvasName.placeholder = creationKind === 'document' ? 'e.g. Audio study' : 'e.g. Spring campaign';
    newCanvasDialog.querySelector('.new-canvas-kits').hidden = rename;
    setStatus(newCanvasStatus, '');
    const catalog = workspace.getKitCatalog();
    const kits = creationKind === 'project' ? DEFAULT_RUNTIME_KITS.filter((id) => !catalog.length || catalog.some((kit) => kit.id === id && kit.installed)) : workspace.getKits();
    newCanvasKits.textContent = kits.map((id) => catalog.find((kit) => kit.id === id)?.name || (id === 'canvas-2d' ? 'HTML + Canvas 2D' : id === 'tone' ? 'Tone.js' : id)).join(', ');
    newCanvasAudioHint.textContent = kits.includes('tone')
      ? 'Tone.js is included. Audio starts when you click Play in the canvas.'
      : 'Add Tone.js under Project files > Canvas kits for audio synthesis.';
    openDialog(newCanvasDialog, newCanvasName);
  }
  document.getElementById('new-canvas-open').addEventListener('click', () => openNewCanvasDialog('document'));
  document.getElementById('new-canvas-close').addEventListener('click', () => newCanvasDialog.close());
  newCanvasDialog.addEventListener('close', updateCanvasBounds);
  newCanvasForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    newCanvasSubmit.disabled = true;
    newCanvasSubmit.textContent = creationKind === 'rename' ? 'Saving...' : 'Creating...';
    try {
      const canvas = await workspace.create(creationKind, newCanvasName.value.trim());
      newCanvasDialog.close();
      newCanvasName.value = '';
      setStatus(statusElement, creationKind === 'rename' ? 'Project renamed.' : `Created ${canvas.documentTitle || canvas.title}.`);
    } catch (error) {
      setStatus(newCanvasStatus, error?.message || 'Could not save this project. Try again.', true);
    } finally {
      newCanvasSubmit.disabled = false;
      newCanvasSubmit.textContent = creationKind === 'rename' ? 'Save name' : creationKind === 'project' ? 'Create project' : 'Create HTML canvas';
    }
  });
  exportCurrentButton.addEventListener('click', async () => {
    nativeDialogOpen = true;
    exportCurrentButton.disabled = true;
    updateCanvasBounds();
    try { await workspace.exportCurrent(); }
    catch (error) { setStatus(statusElement, error?.message || 'Could not export. Try again.', true); }
    finally {
      nativeDialogOpen = false;
      exportCurrentButton.disabled = !activeCanvasId && !['image', 'video', 'audio'].includes(activePreviewKind);
      updateCanvasBounds();
    }
  });
  undoCanvasButton.addEventListener('click', () => undoCanvas({
    client,
    canvasId: activeCanvasId,
    statusElement,
    onCanvasChange: (canvas) => workspace.changed(canvas).catch((error) => setStatus(statusElement, error.message, true)),
  }).catch(() => {}));
  newChatButton.addEventListener('click', async () => {
    if (chatBusy || canvasResumeBusy || backendHistoryBusy || agentControlUi.getState()?.busy) return;
    chatSnapshotEpoch += 1;
    chatBusy = true;
    updateSendState();
    try {
      await client.clearChat();
      clearUnreadMessages();
      notifiedCanvasInputs.clear();
      starterSubmitted = false;
      activeChatId = '';
      canvasInputs.clear();
      canvasInputNodes.clear();
      canvasAnswerIds.clear();
      canvasResumeRequests.clear();
      canvasResumeBusy = false;
      if (!chatHistoryPanel.hidden) await refreshChatHistory();
      messagesElement.replaceChildren(createWelcomeMessage(document, (prompt) => {
        messageInput.value = prompt;
        updateSendState();
        messageInput.focus();
      }));
      streamingMessages.clear();
      disposeMediaPreviews();
      pendingAssetCaptions.clear();
      pendingAttachments = [];
      for (const objectUrl of messageObjectUrls) URL.revokeObjectURL(objectUrl);
      messageObjectUrls.clear();
      renderPendingAttachments();
      messagesElement.scrollTop = 0;
      setStatus(statusElement, 'New chat started.');
      if (!canvasEmpty.hidden) showStarterComposer();
      else showConversation(false);
    } catch (error) {
      const message = error?.message || 'Could not start a new chat.';
      setStatus(statusElement, message, true);
      if (!chatHistoryPanel.hidden) setStatus(chatHistoryStatus, message, true);
    } finally {
      chatBusy = false;
      updateSendState();
      if (chatHistoryPanel.hidden) messageInput.focus();
    }
  });

  const unsubscribe = client.onAgentEvent((event) => {
    if (event.type === 'agent-control') {
      const previous = agentControlUi.getState()?.backend;
      agentControlUi.applyState(event.state);
      if (previous && previous !== event.state?.backend && event.reason === 'backend-switch') restoreBackendChat(event.state.backend);
      return;
    }
    if (backendHistoryBusy && ['token', 'assistant', 'tool-start', 'canvas-input-resume-start', 'media-job-resume-start'].includes(event.type)) {
      chatSnapshotEpoch += 1;
      backendHistoryBusy = false;
      updateSendState();
    }
    const streamingStatus = renderStreamingAgentEvent({ document, messagesElement, event, streams: streamingMessages, chatId: activeChatId, copyText, assetPreviews, pendingAssetCaptions });
    if (streamingStatus) {
      if (event.type === 'assistant' && streamingStatus === 'updated') {
        receivedMessage();
        activityElement.hidden = true;
        setStatus(statusElement, '');
      }
      return;
    }
    if (event.type === 'media-job') {
      if (!workspace.updateMediaJob(event.job)) refreshAssets();
      return;
    }
    if (event.type === 'media-job-removed' || event.type === 'media-job-ready') {
      refreshAssets();
      if (event.type === 'media-job-ready') showReadyMedia(event);
      return;
    }
    if (event.type === 'media-job-notification') {
      showReadyMedia(event);
      const jobId = event.jobId || event.job?.id;
      if (event.chatId === activeChatId && !notifiedMediaJobs.has(jobId)) {
        notifiedMediaJobs.add(jobId);
        if (event.job?.status === 'failed' || event.result?.status === 'failed') appendTextMessage(document, messagesElement, 'assistant', event.text, { copyText });
      }
      return;
    }
    if (event.type === 'media-metadata') {
      refreshAssets();
      for (const asset of event.assets || []) {
        const preview = assetPreviews.get(asset.assetId || asset.id);
        if (!preview) continue;
        const poster = normalizeResultSource(asset.thumbnail || asset.thumbnailDataUrl);
        if (poster && asset.mimeType?.startsWith('video/')) preview.image.poster = poster;
        if (asset.name) {
          preview.caption.textContent = asset.name;
          preview.image.alt = asset.name;
          preview.image.setAttribute('aria-label', asset.name);
          preview.message.querySelector('.message-media-play')?.setAttribute('aria-label', `Play ${asset.name}`);
        }
      }
      return;
    }
    if (event.type === 'project-kits') {
      if (event.projectId === workspace.getProjectId()) workspace.refreshKits().catch((error) => setStatus(statusElement, error.message, true));
      return;
    }
    if (event.type === 'media-job-resume-start' || event.type === 'media-job-resume-end') {
      if (event.chatId !== activeChatId) return;
      const key = `media:${event.jobId}`;
      if (event.type === 'media-job-resume-start') {
        canvasResumeRequests.add(key);
        activityLabel.textContent = 'Continuing with your generated media...';
        activityElement.hidden = false;
      } else {
        canvasResumeRequests.delete(key);
        if (event.error || event.saveWarning) setStatus(statusElement, event.error || event.saveWarning, true);
      }
      canvasResumeBusy = canvasResumeRequests.size > 0;
      if (!canvasResumeBusy) { stopPending = false; if (!chatBusy) activityElement.hidden = true; }
      updateSendState();
      return;
    }
    if (event.type === 'project-deleted' || event.type === 'project-file-deleted' || event.type === 'media-deleted') {
      handleDeletionEvent(event).catch((error) => setStatus(statusElement, `Deleted, but the project list could not refresh: ${error.message}`, true));
      return;
    }
    if (event.type === 'canvas-file-preview') {
      openCanvasFiles(event.path, event.projectId).catch((error) => setStatus(statusElement, `Could not preview ${event.path || 'this file'}: ${error.message}`, true));
      return;
    }
    if (event.type === 'canvas-media-preview') {
      workspace.previewMedia(event).catch((error) => setStatus(statusElement, `Could not preview this media: ${error.message}. Open it from Project files & media to try again.`, true));
      return;
    }
    if (event.type === 'agent-stopped') {
      activityElement.hidden = true;
      setStatus(statusElement, event.saveWarning || (event.canvasInputRequestId ? 'Stopped. Your canvas response is saved; use Retry response to continue.' : 'Stopped. Completed edits are kept.'), Boolean(event.saveWarning));
      return;
    }
    if (event.type === 'project-assets') {
      workspace.assetsChanged(event).catch((error) => setStatus(statusElement, error.message, true));
      return;
    }
    if (event.type === 'media' && !event.generated) {
      refreshAssets();
      setStatus(statusElement, `${event.name || 'Media capture'} saved to the library.`);
      return;
    }
    if (handleCanvasInputEvent(event)) {
      if (event.type === 'canvas-input' && event.request?.status === 'pending' && canvasInputs.has(event.request.id) && !notifiedCanvasInputs.has(event.request.id)) {
        notifiedCanvasInputs.add(event.request.id);
        receivedMessage();
      }
      return;
    }
    if (event.type === 'assistant' && typeof event.text === 'string' && event.text) receivedMessage();
    if (['image', 'media'].includes(event.type) && event.assetId) receivedMessage();
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
      mediaPreviewOptions,
      onLibraryRefresh: refreshAssets,
      onCanvasChange: (canvas) => workspace.changed(canvas).catch((error) => setStatus(statusElement, error.message, true)),
      onCapabilities: (tools) => {
        if (!tools.includes('generate_image') && !tools.includes('generate_video')) setStatus(statusElement, 'Enable an image or video Media model in Settings > Models to generate media.');
      },
    });
    if (canvasResumeBusy) updateSendState();
  });
  client.getSettings().then((settings) => {
    applySettings(settings);
    return refreshModelCatalog();
  }).catch((error) => setStatus(document.getElementById('connection-status'), error?.message || 'Could not load settings.', true));
  client.getAgentControl().then((state) => agentControlUi.applyState(state)).catch((error) => agentControlUi.loadError(error));
  client.getAvailableKits().then((catalog) => renderInstalledKitCatalog(document, installedKitList, catalog))
    .catch((error) => setStatus(document.getElementById('kit-status'), error?.message || 'Could not read installed kits.', true));
  const initialChatEpoch = chatSnapshotEpoch;
  client.getCurrentChat({ deferResume: true }).then((chat) => { if (initialChatEpoch === chatSnapshotEpoch) restoreChat(chat); })
    .catch((error) => setStatus(statusElement, error?.message || 'Could not restore the last chat.', true))
    .finally(() => {
      chatBusy = false;
      updateSendState();
      refreshCanvases(true);
    });

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateCanvasBounds) : null;
  resizeObserver?.observe(canvasHost);
  selectSettingsSection('credentials');
  const savedWorkbenchWidth = readStoredValue(WORKBENCH_WIDTH_STORAGE_KEY);
  applyWorkbenchWidth(savedWorkbenchWidth === null ? 360 : Number(savedWorkbenchWidth));
  const handleWindowResize = () => {
    applyWorkbenchWidth(Number(workbenchSplitter.getAttribute('aria-valuenow')) || 360);
    updateCanvasBounds();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('scroll', updateCanvasBounds, true);
    window.addEventListener('focus', acknowledgeVisibleConversation);
  }
  function acknowledgeVisibleConversation() {
    if (conversationIsReadable() && messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 56) clearUnreadMessages();
  }
  function conversationIsReadable() {
    return !conversationPanel.inert && studio.dataset.sidebar !== 'closed' && document.visibilityState !== 'hidden' && document.hasFocus();
  }
  document.addEventListener('visibilitychange', acknowledgeVisibleConversation);
  messagesElement.addEventListener('scroll', acknowledgeVisibleConversation);
  refreshSkillUi();
  refreshInstalledSkillCatalog();
  updateSendState();
  refreshCanvases();
  updateCanvasBounds();
  showStarterComposer();

  return {
    dispose() {
      unsubscribe();
      agentControlUi.dispose();
      streamingMessages.clear();
      disposeMediaPreviews();
      for (const url of messageObjectUrls) URL.revokeObjectURL(url);
      messageObjectUrls.clear();
      resizeObserver?.disconnect();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', handleWindowResize);
        window.removeEventListener('scroll', updateCanvasBounds, true);
        window.removeEventListener('focus', acknowledgeVisibleConversation);
      }
      document.removeEventListener('visibilitychange', acknowledgeVisibleConversation);
      messagesElement.removeEventListener('scroll', acknowledgeVisibleConversation);
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    appendTextMessage,
    appendMediaPreviewMessage,
    appendReadyMediaCards,
    canAutoPreviewMedia,
    renderInstalledKitCatalog,
    renderSkillList,
    skillCompatibility,
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
    renderStreamingAgentEvent,
    renderAssetLibrary,
    renderCanvasLibrary,
    setStatus,
    wireRenderer,
  };
}

if (typeof window !== 'undefined' && window.document && window.easelClient) {
  wireRenderer({ document: window.document, client: window.easelClient });
}
