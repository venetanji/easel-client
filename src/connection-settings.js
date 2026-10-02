function createConnectionSettings({ document, client, onSettings, onBusy, onRendered }) {
  const modelSelect = document.getElementById('chat-model');
  const catalogElement = document.getElementById('model-catalog');
  const catalogStatus = document.getElementById('model-catalog-status');
  const refreshButton = document.getElementById('models-refresh');
  const list = document.getElementById('connection-list');
  const status = document.getElementById('connection-status');
  const form = document.getElementById('connection-form');
  const add = document.getElementById('connection-add');
  const url = document.getElementById('connection-url');
  const name = document.getElementById('connection-name');
  const key = document.getElementById('connection-key');
  const clear = document.getElementById('connection-clear-key');
  let settings = { connections: [], activeConnectionId: '', litellmModel: '' };
  let catalog = [];
  let loading = false;
  let busy = false;
  let requestId = 0;
  let editingId = '';

  function message(element, text, error = false) {
    element.textContent = text;
    element.classList.toggle('error', error);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, label, action) {
    const node = element('button', className, text);
    node.type = 'button';
    node.disabled = busy;
    node.setAttribute('aria-label', label);
    node.addEventListener('click', action);
    return node;
  }

  function renderConnections() {
    list.replaceChildren(...settings.connections.map((connection) => {
      const row = element('div', 'endpoint-row');
      const info = element('div', 'endpoint-info');
      info.append(element('div', 'endpoint-name', connection.name), element('p', 'endpoint-detail', connection.baseUrl + ' / ' + (connection.hasApiKey ? 'Key saved' : 'No API key')));
      const actions = element('div', 'button-row');
      actions.append(
        button('Edit', 'button quiet small', 'Edit ' + connection.name, () => edit(connection)),
        button('Remove', 'button quiet small danger', 'Remove ' + connection.name, () => remove(connection)),
      );
      row.append(info, actions);
      return row;
    }));
    document.getElementById('connections-empty').hidden = settings.connections.length > 0;
  }

  function selectedValue() {
    return settings.litellmModel ? JSON.stringify({ connectionId: settings.activeConnectionId, model: settings.litellmModel }) : '';
  }

  function roleIcon(entry, role) {
    const label = role === 'agent' ? 'Agent' : 'Media';
    const verified = entry.capabilities?.[role]?.status === 'supported';
    const control = element('span', 'model-capability' + (verified ? ' verified' : ''));
    const detail = label + (verified ? ' support confirmed' : ' category / not yet verified') + ': ' + (entry.capabilities?.[role]?.message || 'Suggested by discovery; check to confirm.');
    control.title = detail;
    control.setAttribute('role', 'img');
    control.setAttribute('aria-label', detail);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', role === 'agent'
      ? 'M5 5.5h10a2 2 0 0 1 2 2V13a2 2 0 0 1-2 2H8l-4 2v-2a2 2 0 0 1-1-2V7.5a2 2 0 0 1 2-2ZM7 10h.1M13 10h.1M10 5.5V3'
      : 'M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V5A1.5 1.5 0 0 1 4 3.5ZM4.5 14l4-4 3 3 2-2 3 3M7 7h.1');
    svg.append(path);
    control.append(svg);
    return control;
  }

  async function checkCapabilities(entry) {
    if (busy) return;
    setBusy(true);
    message(catalogStatus, 'Checking Agent and Media support for ' + entry.name + '...');
    try {
      onSettings(await client.checkModelCapabilities({ connectionId: entry.connectionId, model: entry.model }));
      const checked = settings.models.find((model) => model.connectionId === entry.connectionId && model.model === entry.model);
      const unknown = ['agent', 'media'].some((role) => checked?.capabilities?.[role]?.status === 'unknown');
      message(catalogStatus, unknown ? 'Some checks could not be completed. Hover the status icons for details and try again.' : 'Capabilities checked. Model categories updated.', unknown);
    } catch (error) {
      message(catalogStatus, error?.message || 'Could not check capabilities. Try again.', true);
    } finally {
      setBusy(false);
      const value = JSON.stringify({ connectionId: entry.connectionId, model: entry.model });
      [...catalogElement.querySelectorAll('li')].find((node) => node.dataset.key === value)?.querySelector('.model-check')?.focus();
    }
  }

  function renderModels() {
    const selected = selectedValue();
    const placeholder = element('option', '', loading ? 'Discovering models...' : settings.connections.length ? 'Enable an Agent model in Settings' : 'Add an endpoint in Settings');
    placeholder.value = '';
    placeholder.disabled = true;
    const options = [placeholder];
    const sections = settings.connections.map((connection) => {
      const result = catalog.find((entry) => entry.connectionId === connection.id);
      const models = (settings.models || []).filter((entry) => entry.connectionId === connection.id).sort((a, b) => a.name.localeCompare(b.name));
      const group = element('optgroup');
      group.label = connection.name;
      const section = element('section', 'model-group');
      const head = element('div', 'model-group-head');
      head.append(element('h4', '', connection.name), element('p', '', connection.baseUrl));
      section.append(head);
      const columns = element('div', 'model-list-head');
      const spacer = element('span');
      spacer.setAttribute('aria-hidden', 'true');
      columns.append(spacer, element('span', '', 'Model'), element('span', '', 'Capabilities'));
      if (models.length) section.append(columns);
      const modelList = element('ul', 'model-catalog-list');
      for (const entry of models) {
        const value = JSON.stringify({ connectionId: connection.id, model: entry.model });
        const listed = result?.models.some((model) => model.id === entry.model);
        if (entry.enabled && entry.roles.includes('agent')) {
          const option = element('option', '', entry.name + (!loading && result && !result.error && !listed ? ' (not listed)' : ''));
          option.value = value;
          group.append(option);
        }
        const row = element('li');
        row.dataset.enabled = String(entry.enabled);
        row.dataset.key = value;
        const enableLabel = element('label', 'model-enabled');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.checked = entry.enabled;
        checkbox.disabled = busy || !entry.roles.length;
        checkbox.dataset.unavailable = String(!entry.roles.length);
        checkbox.setAttribute('aria-label', 'Enable ' + entry.name + ' from ' + connection.name);
        checkbox.addEventListener('change', () => updateModel(entry, { enabled: checkbox.checked }));
        enableLabel.append(checkbox);
        const info = element('div', 'model-info');
        info.append(element('span', 'model-name', entry.name));
        if (entry.name !== entry.model) info.append(element('span', 'model-unlisted', entry.model));
        if (value === selected) info.append(element('span', 'model-selected', 'Selected in chat'));
        if (!loading && result && !result.error && !listed) info.append(element('span', 'model-unlisted', 'Saved / not returned by discovery'));
        if (!entry.capabilities) info.append(element('span', 'model-unlisted', 'Not checked'));
        else if (!entry.roles.length) info.append(element('span', 'model-unlisted', 'No supported capability confirmed'));
        const controls = element('div', 'model-controls');
        const icons = element('div', 'model-capabilities');
        const summary = ['agent', 'media'].map((role) => role + ': ' + (entry.capabilities?.[role]?.message || 'Not checked')).join('\n');
        icons.title = summary;
        for (const role of entry.roles) icons.append(roleIcon(entry, role));
        if (!entry.roles.length) icons.append(element('span', 'model-unlisted', entry.capabilities ? 'Unavailable' : 'Unverified'));
        const check = button(entry.capabilities ? 'Recheck' : 'Check', 'button outline small model-check', 'Check capabilities of ' + entry.name, () => checkCapabilities(entry));
        check.title = 'Checks tool calling and makes a real image generation request.';
        controls.append(icons, check);
        row.append(enableLabel, info, controls);
        modelList.append(row);
      }
      if (models.length) section.append(modelList);
      if (result?.error && !loading) section.append(element('p', 'error', 'Refresh failed. Saved models have been kept. ' + result.error + ' Check this endpoint in Credentials, then refresh.'));
      else if (!models.length) section.append(element('p', '', loading ? 'Discovering models...' : 'No models available. Check access in Credentials or provider settings, then refresh.'));
      if (group.children.length) options.push(group);
      return section;
    });
    if (!sections.length) sections.push(element('p', '', 'Add an endpoint in Credentials to discover its models.'));
    modelSelect.replaceChildren(...options);
    modelSelect.value = selected;
    const selectedConnection = settings.connections.find((connection) => connection.id === settings.activeConnectionId);
    modelSelect.title = settings.litellmModel ? selectedConnection?.name + ' / ' + settings.litellmModel : 'Enable an Agent model in Settings > Models';
    catalogElement.replaceChildren(...sections);
    onRendered();
  }

  async function updateModel(entry, patch) {
    if (busy) return;
    setBusy(true);
    message(catalogStatus, 'Saving model...');
    try {
      onSettings(await client.updateModel({ connectionId: entry.connectionId, model: entry.model, enabled: entry.enabled, roles: entry.roles, ...patch }));
      message(catalogStatus, 'Model settings saved.');
    } catch (error) {
      renderModels();
      message(catalogStatus, error?.message || 'Could not save model settings. Try again.', true);
    } finally {
      setBusy(false);
      const value = JSON.stringify({ connectionId: entry.connectionId, model: entry.model });
      const row = [...catalogElement.querySelectorAll('li')].find((node) => node.dataset.key === value);
      row?.querySelector('input')?.focus();
    }
  }

  function setBusy(value) {
    busy = value;
    add.disabled = value;
    for (const control of form.querySelectorAll('input, button')) control.disabled = value;
    renderConnections();
    for (const control of catalogElement.querySelectorAll('input, button')) control.disabled = value || control.dataset.unavailable === 'true';
    refreshButton.disabled = value || loading;
    onBusy(value);
  }

  function closeEditor() {
    editingId = '';
    form.reset();
    form.hidden = true;
    add.setAttribute('aria-expanded', 'false');
  }

  function edit(connection = null) {
    editingId = connection?.id || '';
    form.reset();
    url.value = connection?.baseUrl || '';
    name.value = connection?.name || '';
    key.placeholder = connection?.hasApiKey ? 'Saved securely' : 'Optional for local endpoints';
    document.getElementById('connection-key-hint').textContent = connection?.hasApiKey ? 'Leave blank to keep the saved key.' : 'Leave blank if this endpoint needs no key.';
    document.getElementById('connection-clear-wrap').hidden = !connection?.hasApiKey;
    document.getElementById('connection-editor-title').textContent = connection ? 'Edit endpoint' : 'Add endpoint';
    document.getElementById('connection-save').textContent = connection ? 'Save changes' : 'Save endpoint';
    form.hidden = false;
    add.setAttribute('aria-expanded', 'true');
    message(status, '');
    url.focus();
  }

  async function refresh() {
    const currentRequest = ++requestId;
    loading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing...';
    catalogElement.setAttribute('aria-busy', 'true');
    message(catalogStatus, settings.connections.length ? 'Discovering models...' : '');
    renderModels();
    try {
      const discovered = await client.getModelCatalog();
      if (currentRequest !== requestId) return;
      catalog = discovered.catalog;
      onSettings(discovered.settings);
      const failed = catalog.filter((entry) => entry.error).length;
      const count = catalog.reduce((sum, entry) => sum + entry.models.length, 0);
      message(catalogStatus, failed ? count + ' models found; ' + failed + ' endpoint' + (failed === 1 ? '' : 's') + ' could not be reached.' : count ? count + ' models available.' : '', Boolean(failed));
    } catch (error) {
      if (currentRequest === requestId) message(catalogStatus, error?.message || 'Could not discover models. Try refreshing.', true);
    } finally {
      if (currentRequest === requestId) {
        loading = false;
        refreshButton.disabled = busy;
        refreshButton.textContent = 'Refresh models';
        catalogElement.setAttribute('aria-busy', 'false');
        renderModels();
      }
    }
  }

  async function remove(connection) {
    if (busy) return;
    setBusy(true);
    message(status, 'Removing endpoint...');
    try {
      const next = await client.removeConnection(connection.id);
      if (editingId === connection.id) closeEditor();
      catalog = catalog.filter((entry) => entry.connectionId !== connection.id);
      onSettings(next);
      message(status, 'Endpoint removed.' + (next.litellmModel ? '' : ' Choose a model in chat before sending.'));
      await refresh();
    } catch (error) {
      message(status, error?.message || 'Could not remove endpoint.', true);
    } finally { setBusy(false); }
  }

  add.addEventListener('click', () => edit());
  document.getElementById('connection-cancel').addEventListener('click', () => { closeEditor(); add.focus(); });
  refreshButton.addEventListener('click', refresh);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    message(status, 'Saving endpoint...');
    try {
      const next = await client.saveConnection({ ...(editingId ? { id: editingId } : {}), name: name.value, baseUrl: url.value, apiKey: key.value, clearApiKey: clear.checked });
      closeEditor();
      onSettings(next);
      const inSetup = document.getElementById('settings-dialog')?.dataset?.setup === 'true';
      const savedMessage = !inSetup ? 'Endpoint saved. Review and enable its models in Models.'
        : document.getElementById('agent-backend-builtin')?.checked
          ? 'Endpoint saved. Continue to Chat model to choose one. Easel will enable it for you.'
          : 'Endpoint saved. Continue to check your agent. Media models can be enabled later in Settings > Models.';
      message(status, savedMessage);
      await refresh();
    } catch (error) {
      message(status, error?.message || 'Could not save endpoint.', true);
    } finally {
      setBusy(false);
      if (form.hidden) add.focus();
    }
  });

  return {
    refresh,
    selectedValue,
    startAdd: () => edit(),
    closeEditor,
    load(next) {
      settings = next;
      renderConnections();
      renderModels();
    },
  };
}

if (typeof module !== 'undefined') module.exports = { createConnectionSettings };
