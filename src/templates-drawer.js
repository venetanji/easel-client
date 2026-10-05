// Catalog content only. ProjectWorkspace owns the mutually exclusive rail drawers.
function createTemplatesDrawer({ document, client, onOpen, onPrompt, onStatus, isBusy, getProjectId = () => '', onBusy }) {
  const panel = document.getElementById('templates-drawer');
  const list = document.getElementById('templates-list');
  const detail = document.getElementById('templates-detail');
  const status = document.getElementById('templates-status');
  const recovery = document.getElementById('templates-recovery');
  const refreshButton = document.getElementById('templates-refresh');
  const listeners = { list: [], detail: [], recovery: [], shell: [] };
  let entries = [];
  let selectedId = '';
  let catalogVersion = 0;
  let loading = false;
  let loaded = false;
  let operating = false;
  let destroyed = false;
  let open = false;
  let viewVersion = 0;
  let recoveryVersion = 0;
  let saved = null;
  let openError = '';
  let controls = [];
  let contextHint = null;
  let retryButton = null;
  let dismissButton = null;

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function clear(group) {
    for (const [item, callback] of listeners[group]) item.removeEventListener('click', callback);
    listeners[group] = [];
  }
  function button(label, action, group, className = 'button outline') {
    const item = node('button', className, label);
    item.type = 'button';
    const callback = () => { if (!destroyed && !item.disabled) return action(); };
    item.addEventListener('click', callback);
    listeners[group].push([item, callback]);
    return item;
  }
  function setStatus(text, error = false) {
    if (destroyed) return;
    status.textContent = text;
    status.setAttribute('role', error ? 'alert' : 'status');
    status.setAttribute('aria-live', error ? 'assertive' : 'polite');
    status.dataset.error = String(error);
  }
  function selected() { return entries.find((entry) => entry.id === selectedId); }
  function available(entry) { return entry?.status === 'ready' && entry.availability?.available === true; }
  function blocked() { return destroyed || operating || Boolean(isBusy?.()); }
  function updateBusy() {
    if (destroyed) return;
    const busy = operating || Boolean(isBusy?.());
    const entry = selected();
    for (const [item, kind] of controls) {
      const supported = entry?.actions?.includes(kind === 'current' ? 'add-to-current-project' : 'create-project');
      item.disabled = busy || loading || !available(entry) || (kind !== 'prompt' && (!supported || Boolean(saved))) || (kind === 'current' && !getProjectId());
    }
    if (contextHint) contextHint.textContent = !getProjectId() ? 'Open a project to add a new sketch to it.' : 'Each action creates a new sketch. Existing work stays in Project files.';
    if (retryButton) retryButton.disabled = busy;
    if (dismissButton) dismissButton.disabled = busy;
    refreshButton.disabled = loading || operating;
    panel.setAttribute('aria-busy', String(loading || operating));
  }
  function renderRecovery() {
    clear('recovery');
    retryButton = null;
    dismissButton = null;
    recovery.replaceChildren();
    recovery.hidden = !saved;
    if (!saved) return;
    recovery.append(node('h3', '', 'Sketch created'), node('p', '', `Saved at creation as ${saved.documentPath}. ${openError || 'The preview could not open.'} Retry Open, or dismiss this retry to continue. Dismissing does not delete or recreate any sketch.`));
    retryButton = button('Retry Open', retryOpen, 'recovery');
    dismissButton = button('Dismiss Open retry', () => {
      if (blocked()) return;
      const view = viewVersion;
      const focused = document.activeElement;
      const ownedFocus = focused === retryButton || focused === dismissButton;
      clearRecovery('Open retry dismissed. No sketch was deleted or recreated. Existing work is in Project files.');
      if (ownedFocus && !destroyed && open && view === viewVersion && (document.activeElement === focused || document.activeElement === document.body)) {
        const current = detail.hidden ? list : detail;
        [...current.querySelectorAll('button'), refreshButton, document.getElementById('templates-collapse')]
          .find((item) => item?.isConnected && !item.disabled && !item.hidden)?.focus();
      }
    }, 'recovery', 'button quiet');
    recovery.append(retryButton, dismissButton);
    updateBusy();
  }
  function clearRecovery(message) {
    recoveryVersion += 1;
    saved = null; openError = '';
    renderRecovery();
    updateBusy();
    setStatus(message);
  }
  function acceptDeletion(event) {
    if (destroyed || !saved || event?.canceled || event?.deleted === false || event?.projectId !== saved.projectId) return false;
    const matches = event.type === 'project-deleted' || (event.type === 'project-file-deleted' && event.deletedPath === saved.documentPath);
    if (!matches) return false;
    clearRecovery('The saved sketch was deleted. You can create a new sketch.');
    return true;
  }
  function renderDetails(focus = false) {
    clear('detail');
    controls = [];
    contextHint = null;
    detail.replaceChildren();
    const entry = selected();
    detail.hidden = !entry;
    list.hidden = Boolean(entry);
    if (!entry) return;
    const back = button('All templates', () => {
      viewVersion += 1;
      const previous = selectedId;
      selectedId = '';
      renderList();
      Array.from(list.querySelectorAll('button')).find((item) => item.dataset.templateId === previous)?.focus();
    }, 'detail', 'button quiet small');
    const heading = node('h3', 'template-detail-title', entry.title);
    heading.id = 'template-detail-title';
    heading.setAttribute('tabindex', '-1');
    detail.append(back, heading, node('p', '', entry.purpose));
    if (!available(entry)) detail.append(node('p', 'template-unavailable', entry.availability?.reason || 'This template is unavailable in this build.'));
    detail.append(node('p', 'template-kits', `Required kits: ${(entry.requiredKits || []).join(', ') || 'None'}`));
    for (const [title, values] of [['Outputs', entry.outputs], ['Limits', entry.limitations]]) {
      if (!values?.length) continue;
      const items = node('ul');
      for (const value of values) items.append(node('li', '', value));
      detail.append(node('h4', '', title), items);
    }
    const actions = node('div', 'template-actions');
    const createButton = button('Create project', () => create('new-project'), 'detail', 'button primary');
    const add = button('Add to current project', () => create('current-project'), 'detail');
    // Explicit destination choices always stay visible, including unavailable kits.
    controls.push([createButton, 'new'], [add, 'current']);
    actions.append(createButton, add);
    contextHint = node('p', 'template-context');
    contextHint.id = 'template-context';
    add.setAttribute('aria-describedby', 'template-context');
    detail.append(actions, contextHint);
    if (entry.questions?.length) {
      const explore = button('Explore this idea', () => {
        if (blocked() || !available(selected())) return;
        try { onPrompt?.(`Help me develop a creative brief for a ${entry.title} sketch. ${entry.questions.join(' ')} Start by discussing ideas with me.`); }
        catch (error) { setStatus(error.message || 'The conversation is unavailable.', true); }
      }, 'detail', 'button quiet');
      controls.push([explore, 'prompt']);
      detail.append(explore, node('p', 'template-context', 'Prepares an editable chat prompt for you to send.'));
    }
    updateBusy();
    if (focus && open) heading.focus();
  }
  function renderList() {
    clear('list');
    list.replaceChildren();
    const ordered = [...entries].sort((a, b) => Number(available(b)) - Number(available(a)) || Number(a.status === 'planned') - Number(b.status === 'planned'));
    for (const entry of ordered) {
      const row = node('div', 'template-entry');
      row.dataset.templateId = entry.id;
      if (entry.status === 'planned') {
        row.append(node('h3', '', entry.title), node('span', 'template-state', 'Planned'), node('p', '', entry.purpose));
      } else {
        const choice = button(entry.title, () => {
          viewVersion += 1;
          selectedId = entry.id;
          for (const item of list.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item.dataset.templateId === selectedId));
          renderDetails(true);
        }, 'list', 'template-choice');
        choice.dataset.templateId = entry.id;
        choice.setAttribute('aria-controls', 'templates-detail');
        choice.setAttribute('aria-pressed', String(selectedId === entry.id));
        row.append(choice, node('span', 'template-state', available(entry) ? 'Ready' : 'Unavailable'), node('p', '', entry.purpose));
      }
      list.append(row);
    }
    if (!entries.length && loaded) list.append(node('p', 'empty-library', 'No templates are available in this build.'));
    renderDetails();
  }
  async function refresh() {
    if (destroyed) return;
    const version = ++catalogVersion;
    loading = true;
    setStatus('Loading templates…');
    updateBusy();
    try {
      const result = await client.listTemplates();
      if (destroyed || version !== catalogVersion) return;
      if (!Array.isArray(result)) throw Error('The template catalog could not be read.');
      entries = result;
      loaded = true;
      if (!selected()) selectedId = '';
      renderList();
      setStatus('');
    } catch (error) {
      if (destroyed || version !== catalogVersion) return;
      entries = []; selectedId = ''; loaded = false;
      renderList();
      setStatus(`${error.message || 'Could not load templates.'} Use Refresh to try again.`, true);
    } finally {
      if (!destroyed && version === catalogVersion) { loading = false; updateBusy(); }
    }
  }
  async function present(result, view, recoveryEpoch) {
    saved = result;
    if (result.opened === false) throw Error(result.openError || 'The preview could not open.');
    await onOpen?.(result, { isCurrentView: () => !destroyed && open && view === viewVersion && recoveryEpoch === recoveryVersion });
    if (destroyed || recoveryEpoch !== recoveryVersion) return;
    saved = null; openError = '';
    renderRecovery();
    setStatus('Sketch ready. Edit its source in Project files.');
    onStatus?.('Sketch ready. Edit its source in Project files.', false);
  }
  async function run(action) {
    if (blocked()) return;
    operating = true;
    let focusRecovery = false;
    const view = viewVersion;
    const recoveryEpoch = recoveryVersion;
    updateBusy();
    onBusy?.(true);
    setStatus(saved ? 'Opening saved sketch…' : 'Creating sketch…');
    try {
      const result = await action();
      if (destroyed || recoveryEpoch !== recoveryVersion) return;
      await present(result, view, recoveryEpoch);
    } catch (error) {
      if (destroyed || recoveryEpoch !== recoveryVersion) return;
      if (saved) {
        openError = error.message || 'The preview could not open.';
        renderRecovery();
        setStatus('Sketch creation succeeded. Retry Open or dismiss this retry.', true);
        onStatus?.(`Sketch created. ${openError} Retry Open or dismiss the retry in Templates.`, true);
        focusRecovery = true;
      } else {
        setStatus(error.message || 'Could not create this template. Try again.', true);
        onStatus?.(error.message || 'Could not create this template.', true);
      }
    } finally {
      if (!destroyed) {
        operating = false; updateBusy(); onBusy?.(false);
        if (focusRecovery && open && view === viewVersion) retryButton?.focus();
      }
    }
  }
  function create(target) {
    const entry = selected();
    const projectId = getProjectId();
    if (blocked() || loading || saved || !available(entry) || (target === 'current-project' && !projectId)) return;
    if (!entry.actions?.includes(target === 'current-project' ? 'add-to-current-project' : 'create-project')) return;
    return run(() => client.createTemplateInstance({ templateId: entry.id, target, ...(target === 'current-project' ? { projectId } : {}) }));
  }
  function retryOpen() {
    if (!saved) return;
    const { projectId, instanceId } = saved;
    return run(() => client.openTemplateInstance({ projectId, instanceId }));
  }
  function setOpen(value) {
    if (destroyed) return;
    if (open !== Boolean(value)) viewVersion += 1;
    open = Boolean(value);
    panel.hidden = !open;
    panel.inert = !open;
    if (open && !loaded && !loading) refresh();
    updateBusy();
  }
  const refreshAction = () => refresh();
  refreshButton.addEventListener('click', refreshAction);
  listeners.shell.push([refreshButton, refreshAction]);
  detail.hidden = true;
  recovery.hidden = true;
  return { refresh, setOpen, updateBusy, acceptDeletion, destroy() {
    destroyed = true;
    catalogVersion += 1;
    for (const group of Object.keys(listeners)) clear(group);
  } };
}
if (typeof module !== 'undefined') module.exports = { createTemplatesDrawer };
