const SETUP_STORAGE_KEY = 'easel-setup-v1';

function setupReadiness(settings, control) {
  if (!settings || !control) return false;
  if (control.backend === 'codex') {
    return Boolean(control.codex?.available && control.codex.connected && control.codex.authenticated
      && control.codex.models?.some((model) => model.id === control.codex.model));
  }
  if (control.backend === 'external') return Boolean(control.external?.enabled && control.external.connectedClients > 0);
  return Boolean(settings.connections?.some((connection) => connection.id === settings.activeConnectionId)
    && settings.models?.some((model) => model.connectionId === settings.activeConnectionId
      && model.model === settings.litellmModel && model.enabled && model.roles.includes('agent')));
}

function createSetupWizard({ document, client, storage, onSettings, onAgentState, onOpen, onSection, onAddEndpoint, onClose, onBusy, isBusy = () => false }) {
  const node = (id) => document.getElementById(id);
  const dialog = node('settings-dialog');
  const select = node('setup-model');
  const status = node('setup-status');
  const next = node('setup-next');
  const builtinHint = node('agent-builtin-setup-hint');
  const settingsBuiltinHint = builtinHint.textContent;
  const listeners = [];
  let settings;
  let control;
  let active = false;
  let initialized = false;
  let busy = false;
  let disposed = false;
  let step = 0;
  let previousFocus;

  function listen(element, event, action) {
    element.addEventListener(event, action);
    listeners.push(() => element.removeEventListener(event, action));
  }
  function savedState() { try { return storage?.getItem(SETUP_STORAGE_KEY); } catch { return null; } }
  function remember(value) { try { storage?.setItem(SETUP_STORAGE_KEY, value); } catch {} }
  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  function locked() { return busy || Boolean(control?.busy) || isBusy(); }

  function render() {
    if (!active || disposed) return;
    const backend = control?.backend || 'builtin';
    const ready = setupReadiness(settings, control);
    const options = backend === 'codex'
      ? (control.codex?.models || []).map((model) => ({ value: model.id, label: model.displayName || model.name || model.id }))
      : (settings?.models || []).filter((model) => model.roles.includes('agent')
        && settings.connections.some((connection) => connection.id === model.connectionId)).map((model) => ({
        value: JSON.stringify({ connectionId: model.connectionId, model: model.model }),
        label: `${settings.connections.find((connection) => connection.id === model.connectionId).name} / ${model.name || model.model}`,
      }));
    const mediaModels = (settings?.models || []).filter((model) => model.roles.includes('media')
      && settings.connections.some((connection) => connection.id === model.connectionId));
    node('setup-media-models').replaceChildren(...mediaModels.map((model) => {
      const row = document.createElement('label');
      row.className = 'setup-media-model';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(model.enabled);
      checkbox.disabled = locked() || (model.enabled && model.roles.includes('agent')
        && settings.activeConnectionId === model.connectionId && settings.litellmModel === model.model);
      checkbox.dataset.selection = JSON.stringify({ connectionId: model.connectionId, model: model.model });
      const name = document.createElement('span');
      const connection = settings.connections.find((item) => item.id === model.connectionId);
      const mediaTypes = (model.mediaTypes || []).map((type) => type[0].toUpperCase() + type.slice(1)).join(', ');
      name.textContent = `${connection.name} / ${model.name || model.model}${mediaTypes ? ` (${mediaTypes})` : ''}`;
      row.append(checkbox, name);
      return row;
    }));
    node('setup-media-empty').hidden = mediaModels.length > 0;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.textContent = options.length ? 'Choose a chat model' : 'No chat models available';
    select.replaceChildren(placeholder, ...options.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    select.value = backend === 'codex' ? control.codex?.model || ''
      : settings?.litellmModel ? JSON.stringify({ connectionId: settings.activeConnectionId, model: settings.litellmModel }) : '';
    select.disabled = locked() || !options.length || (backend === 'codex' && !control.codex?.authenticated);
    node('setup-model-field').hidden = backend === 'external';
    node('setup-refresh').hidden = backend !== 'builtin';
    node('setup-refresh').disabled = locked();
    node('setup-model-title').textContent = backend === 'external' ? 'Connect your external agent' : 'Choose a chat model';
    node('setup-model-hint').textContent = backend === 'builtin'
      ? 'Choose one model to enable for chat and tools. Image, video and audio models are optional; an Easel media endpoint alone does not provide a chat agent.'
      : backend === 'codex' ? 'Use a model from your signed-in Codex account. API endpoints are optional for media generation.'
        : 'Your external controller supplies its own chat model. Go back to Agent to copy the connection details, then connect your controller.';
    node('setup-ready').textContent = ready ? 'Your agent is ready.'
      : backend === 'codex' ? 'Sign in under Agent, then select a Codex model.'
        : backend === 'external' ? 'Waiting for an external controller to connect.'
          : options.length ? 'Select a chat model before finishing setup.' : 'Add a chat endpoint in Credentials, then refresh its models.';
    node('setup-back').disabled = step === 0 || locked();
    node('setup-skip').disabled = locked();
    node('setup-media-skip').disabled = locked();
    node('setup-media-refresh').disabled = locked() || backend !== 'builtin';
    next.disabled = locked() || !control || (step === 1 && backend === 'builtin' && !settings?.connections.length) || (step >= 2 && !ready);
    next.textContent = step === 3 ? 'Start creating' : step === 1 && backend !== 'builtin' && !settings?.connections.length ? 'Continue without media' : 'Continue';
    node('setup-progress').textContent = `Step ${step + 1} of 4`;
    ['agent', 'credentials', 'model', 'media'].forEach((name, index) => {
      const item = node(`setup-step-${name}`);
      if (index === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  function showStep(value) {
    step = Math.max(0, Math.min(3, value));
    message('');
    onSection(step === 0 ? 'agent' : step === 1 ? 'credentials' : null);
    node('setup-model-panel').hidden = step !== 2;
    node('setup-media-panel').hidden = step !== 3;
    render();
    if (step === 1 && !settings?.connections.length && control?.backend === 'builtin') onAddEndpoint?.();
    else if (step === 2) (node('setup-model-trigger') || select).focus();
    else if (step === 3) node('setup-media-title').focus();
    else node(`agent-backend-${control?.backend || 'builtin'}`).focus();
  }

  function open() {
    if (!settings || !control || locked() || disposed) return;
    previousFocus = document.activeElement;
    active = true;
    remember('started');
    dialog.dataset.setup = 'true';
    dialog.setAttribute('aria-describedby', 'setup-description');
    node('settings-title').textContent = 'Set up Easel';
    node('settings-description').hidden = true;
    node('settings-close').hidden = true;
    node('setup-open').hidden = true;
    node('setup-header').hidden = false;
    node('setup-footer').hidden = false;
    builtinHint.textContent = 'Continue to Credentials to save a chat endpoint, then choose a model in Chat model. Easel will enable your selection.';
    onOpen();
    showStep(0);
  }

  function dismiss(value = 'skipped') {
    if (!active || locked()) return;
    remember(value);
    active = false;
    dialog.dataset.setup = 'false';
    dialog.removeAttribute('aria-describedby');
    node('settings-title').textContent = 'Settings';
    node('settings-description').hidden = false;
    node('settings-close').hidden = false;
    node('setup-open').hidden = false;
    node('setup-header').hidden = true;
    node('setup-footer').hidden = true;
    node('setup-model-panel').hidden = true;
    builtinHint.textContent = settingsBuiltinHint;
    onClose?.();
    onSection('agent');
    dialog.close();
    previousFocus?.focus();
  }

  async function run(action) {
    if (locked() || disposed) return;
    busy = true;
    onBusy?.(true);
    message('Saving your selection...');
    render();
    try { await action(); if (!disposed) message(''); }
    catch (error) { if (!disposed) message(error?.message || 'Could not update setup. Try again.', true); }
    finally { busy = false; onBusy?.(false); render(); }
  }

  listen(node('setup-open'), 'click', open);
  listen(node('setup-back'), 'click', () => { if (!locked()) showStep(step - 1); });
  listen(node('setup-skip'), 'click', () => dismiss());
  listen(next, 'click', () => {
    if (next.disabled || locked()) return;
    if (step === 3) { if (setupReadiness(settings, control)) dismiss('complete'); }
    else showStep(step + 1);
  });
  listen(select, 'change', () => {
    const value = select.value;
    if (!value) return;
    run(async () => {
      if (control.backend === 'codex') {
        onAgentState(await client.selectCodexModel(value));
      } else {
        const selection = JSON.parse(value);
        const model = settings.models.find((entry) => entry.connectionId === selection.connectionId && entry.model === selection.model);
        if (!model || !model.roles.includes('agent')) throw new Error('Choose a chat model from the available list.');
        if (!model.enabled) onSettings(await client.updateModel({ ...selection, enabled: true, roles: model.roles }));
        onSettings(await client.selectModel(selection));
      }
    });
  });
  async function refreshModels() {
    const result = await client.getModelCatalog();
    onSettings(result.settings);
    const errors = result.catalog.filter((entry) => entry.error);
    if (errors.length) throw new Error('Some endpoints could not be reached. Check their credentials and try again.');
  }
  listen(node('setup-refresh'), 'click', () => run(refreshModels));
  listen(node('setup-media-refresh'), 'click', () => run(refreshModels));
  listen(node('setup-media-models'), 'change', (event) => {
    const checkbox = event.target;
    if (checkbox?.type !== 'checkbox' || !checkbox.dataset.selection) return;
    const selection = JSON.parse(checkbox.dataset.selection);
    run(async () => {
      const model = settings.models.find((entry) => entry.connectionId === selection.connectionId && entry.model === selection.model);
      if (!model || !model.roles.includes('media')) throw new Error('This model is no longer available for media. Refresh the model list.');
      onSettings(await client.updateModel({ ...selection, enabled: checkbox.checked, roles: model.roles }));
    });
  });
  listen(node('setup-media-skip'), 'click', () => { if (!locked()) dismiss('complete'); });
  listen(dialog, 'cancel', (event) => {
    if (!active) return;
    event.preventDefault();
    dismiss();
  });

  return {
    open,
    update(nextSettings, nextControl) {
      settings = nextSettings;
      control = nextControl;
      if (!initialized && settings && control && !locked()) {
        initialized = true;
        const saved = savedState();
        const existing = settings.connections?.length || settings.litellmModel || control.backend !== 'builtin';
        if (saved === 'started' || (!saved && !existing)) open();
      }
      render();
    },
    isActive: () => active,
    dispose() { disposed = true; listeners.forEach((remove) => remove()); },
  };
}

if (typeof module !== 'undefined') module.exports = { createSetupWizard, setupReadiness, SETUP_STORAGE_KEY };
