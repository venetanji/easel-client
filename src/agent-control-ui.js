function createAgentControlUi({ document, client, copyText, onStateChange, onOpenSettings }) {
  const node = (id) => document.getElementById(id);
  const choices = ['builtin', 'external', 'codex'].map((backend) => ({ backend, input: node(`agent-backend-${backend}`) }));
  const status = node('agent-control-status');
  const modelSelect = node('codex-model');
  const listeners = [];
  let state = null;
  let pending = false;
  let disconnectPending = false;
  let localBusy = false;
  let disposed = false;
  let tokenVisible = false;
  let tokenRequest = 0;
  let refreshingModels = false;

  function listen(element, event, action) {
    element.addEventListener(event, action);
    listeners.push(() => element.removeEventListener(event, action));
  }

  function message(text = '', error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function forgetToken() {
    tokenRequest += 1;
    tokenVisible = false;
    node('agent-mcp-token').value = '';
    node('agent-mcp-token-field').hidden = true;
    node('agent-mcp-reveal').textContent = 'Reveal token';
    node('agent-mcp-reveal').setAttribute('aria-expanded', 'false');
  }

  function isBusy() { return pending || disconnectPending || localBusy || Boolean(state?.busy); }
  function isExternal() { return state?.backend === 'external'; }
  function isReady() {
    if (!state || pending || isExternal()) return false;
    if (state.backend !== 'codex') return true;
    return Boolean(state.codex?.available && state.codex?.connected && state.codex?.authenticated && state.codex?.model);
  }

  function renderModels(codex) {
    const models = Array.isArray(codex.models) ? codex.models : [];
    const options = models.map((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.displayName || model.name || model.id;
      return option;
    });
    if (!options.length || !models.some((model) => model.id === codex.model)) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = !codex.authenticated ? 'Sign in to choose a model' : options.length ? 'Choose a model' : 'No models available';
      options.unshift(placeholder);
    }
    modelSelect.replaceChildren(...options);
    modelSelect.value = codex.model || '';
    modelSelect.disabled = isBusy() || !codex.authenticated || !codex.connected || !models.length;
    refreshingModels = true;
    try { modelSelect.dispatchEvent(new Event('change')); }
    finally { refreshingModels = false; }
  }

  function render() {
    const backend = state?.backend || 'builtin';
    const busy = isBusy();
    const codex = state?.codex || {};
    const external = state?.external || {};
    choices.forEach(({ backend: value, input }) => { input.checked = backend === value; input.disabled = !state || busy; });
    node('agent-backend-lock').hidden = !busy;
    node('agent-builtin-panel').hidden = backend !== 'builtin';
    node('agent-external-panel').hidden = backend !== 'external';
    node('agent-codex-panel').hidden = backend !== 'codex';
    node('builtin-model-picker').hidden = backend !== 'builtin';
    node('codex-model-picker').hidden = backend !== 'codex';
    node('composer-external').hidden = backend !== 'external';
    node('chat-form').querySelector('.composer').hidden = backend === 'external';
    node('agent-mcp-url').textContent = external.url || 'Connection unavailable';
    const count = Number(external.connectedClients) || 0;
    node('agent-mcp-status').textContent = !external.enabled ? 'MCP server is unavailable.' : count ? `${count} connected ${count === 1 ? 'client' : 'clients'}` : 'Waiting for an external client';
    node('agent-mcp-status').dataset.ready = String(Boolean(external.enabled && count));
    node('agent-mcp-command').textContent = external.url ? `codex mcp add easel --url "${external.url}" --bearer-token-env-var EASEL_MCP_TOKEN` : '';
    node('agent-mcp-reveal').disabled = pending || !external.enabled;
    node('agent-mcp-copy').disabled = pending || !external.enabled || !copyText;
    node('agent-mcp-disconnect').disabled = disconnectPending || !external.enabled || !(count || state?.busy);
    node('agent-mcp-disconnect').textContent = disconnectPending ? 'Disconnecting...' : 'Disconnect controller';
    node('agent-codex-runtime').textContent = !codex.available ? 'Codex runtime not found' : codex.connected ? 'Codex is connected' : 'Codex is disconnected';
    node('agent-codex-install').hidden = Boolean(codex.available);
    node('agent-codex-account').textContent = codex.authenticated ? codex.accountLabel || 'Signed in to Codex' : 'Sign in to use Codex inside Easel.';
    node('agent-codex-login-actions').hidden = Boolean(codex.authenticated || codex.login || !codex.available);
    node('agent-codex-browser').disabled = busy || !codex.connected;
    node('agent-codex-device').disabled = busy || !codex.connected;
    node('agent-codex-signout-section').hidden = !codex.authenticated;
    node('agent-codex-signout').disabled = busy;
    node('agent-codex-login-panel').hidden = !codex.login;
    node('agent-codex-login-description').textContent = codex.login?.type === 'chatgptDeviceCode' ? 'Open this address in your browser and enter the code.' : 'Finish signing in through the browser window.';
    node('agent-codex-verification-url').textContent = codex.login?.verificationUrl || codex.login?.authUrl || '';
    node('agent-codex-user-code').textContent = codex.login?.userCode || '';
    node('agent-codex-user-code').hidden = !codex.login?.userCode;
    node('agent-codex-cancel').disabled = pending || !codex.login?.loginId;
    node('agent-codex-open-login').disabled = pending || !(codex.login?.verificationUrl || codex.login?.authUrl);
    node('agent-codex-error').textContent = codex.error || '';
    renderModels(codex);
  }

  function applyState(value) {
    const next = value?.state || value;
    if (!next || !['builtin', 'external', 'codex'].includes(next.backend) || disposed) return;
    if (next.backend !== state?.backend || next.external?.url !== state?.external?.url) forgetToken();
    state = next;
    render();
    onStateChange?.(state);
  }

  async function run(action, success = '') {
    if (isBusy() || disposed) return;
    pending = true;
    message();
    render();
    onStateChange?.(state);
    try {
      const result = await action();
      if (disposed) return;
      if (result?.backend || result?.state?.backend) applyState(result);
      else applyState(await client.getAgentControl());
      message(success);
    } catch (error) {
      if (!disposed) message(error?.message || 'Could not update agent settings. Try again.', true);
    } finally {
      pending = false;
      if (!disposed) { render(); onStateChange?.(state); }
    }
  }

  choices.forEach(({ backend, input }) => listen(input, 'change', () => {
    if (!input.checked || backend === state?.backend) return;
    if (isBusy()) { render(); return; }
    run(() => client.setAgentBackend(backend));
  }));
  listen(node('agent-codex-browser'), 'click', () => run(() => client.codexLogin({ type: 'chatgpt' })));
  listen(node('agent-codex-device'), 'click', () => run(() => client.codexLogin({ type: 'chatgptDeviceCode' })));
  listen(node('agent-codex-cancel'), 'click', () => run(() => client.codexCancelLogin(state?.codex?.login?.loginId)));
  listen(node('agent-codex-open-login'), 'click', async () => {
    const url = state?.codex?.login?.verificationUrl || state?.codex?.login?.authUrl;
    if (!url || pending || disposed) return;
    try { await client.openExternal(url); }
    catch (error) { if (!disposed) message(error?.message || 'Could not open the sign-in page. Copy the address into your browser.', true); }
  });
  listen(node('agent-codex-signout'), 'click', () => run(() => client.codexLogout(), 'Signed out of the shared Codex account.'));
  listen(modelSelect, 'change', () => {
    // Programmatic picker refreshes update the themed dropdown without saving.
    if (refreshingModels || !modelSelect.value || modelSelect.value === state?.codex?.model) return;
    if (isBusy()) { render(); return; }
    const model = modelSelect.value;
    run(() => client.selectCodexModel(model));
  });
  listen(node('composer-external-settings'), 'click', () => onOpenSettings?.());
  listen(node('agent-mcp-disconnect'), 'click', async () => {
    if (disconnectPending || !isExternal() || !state?.external?.enabled || !(state.external.connectedClients || state.busy)) return;
    disconnectPending = true;
    message('Disconnecting controller...');
    render();
    try {
      await client.stopAgent();
      if (disposed) return;
      forgetToken();
      applyState(await client.getAgentControl());
      message('Controller disconnected. Accepted media jobs continue and stay saved.');
    } catch (error) {
      if (!disposed) message(error?.message || 'Could not disconnect the controller. Try again.', true);
    } finally { disconnectPending = false; if (!disposed) { render(); onStateChange?.(state); } }
  });

  async function getToken() {
    if (disposed || pending || !state?.external?.enabled) return;
    const request = ++tokenRequest;
    const connection = await client.getMcpConnection();
    if (disposed || request !== tokenRequest || !isExternal()) return;
    if (typeof connection?.bearerToken !== 'string' || !connection.bearerToken) throw new Error('The MCP token is unavailable. Try again.');
    return connection.bearerToken;
  }
  listen(node('agent-mcp-reveal'), 'click', async () => {
    if (tokenVisible) { forgetToken(); return; }
    try {
      const token = await getToken();
      if (!token) return;
      tokenVisible = true;
      node('agent-mcp-token').value = token;
      node('agent-mcp-token-field').hidden = false;
      node('agent-mcp-reveal').textContent = 'Hide token';
      node('agent-mcp-reveal').setAttribute('aria-expanded', 'true');
    } catch (error) { if (!disposed) message(error.message, true); }
  });
  listen(node('agent-mcp-copy'), 'click', async () => {
    if (!copyText) return;
    try {
      const token = await getToken();
      if (!token) return;
      await copyText(token);
      if (!disposed) message('Token copied. Set it as EASEL_MCP_TOKEN in your controller environment.');
    } catch (error) { if (!disposed) message(error.message || 'Could not copy the token.', true); }
  });

  render();
  return {
    applyState, getState: () => state, isReady, isExternal, isBusy,
    setBusy(value) { if (localBusy !== Boolean(value)) { localBusy = Boolean(value); render(); } },
    loadError(error) { message(error?.message || 'Could not load agent settings. Reopen Easel to try again.', true); },
    clearToken: forgetToken,
    dispose() { disposed = true; forgetToken(); listeners.forEach((remove) => remove()); },
  };
}

if (typeof module !== 'undefined') module.exports = { createAgentControlUi };
