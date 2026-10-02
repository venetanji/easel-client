function createThemedDropdown(select, { onOpenChange } = {}) {
  const document = select.ownerDocument;
  const wrapper = document.createElement('span');
  wrapper.className = `themed-dropdown themed-dropdown-${select.id}`;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = `${select.id}-trigger`;
  trigger.className = 'themed-dropdown-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'themed-dropdown-value';
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  caret.setAttribute('viewBox', '0 0 16 16');
  caret.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm4 6 4 4 4-4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  caret.append(path);
  trigger.append(label, caret);
  const popup = document.createElement('div');
  popup.className = `themed-dropdown-popup themed-dropdown-popup-${select.id}`;
  popup.hidden = true;
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'themed-dropdown-search';
  search.placeholder = select.id === 'chat-model' ? 'Search models or endpoints' : 'Search options';
  search.setAttribute('aria-label', search.placeholder);
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list');
  const list = document.createElement('div');
  list.id = `${select.id}-options`;
  list.className = 'themed-dropdown-options';
  list.setAttribute('role', 'listbox');
  trigger.setAttribute('aria-controls', list.id);
  search.setAttribute('aria-controls', list.id);
  popup.append(search, list);
  select.before(wrapper);
  wrapper.append(select, trigger);
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  for (const existingLabel of document.querySelectorAll('label')) {
    if (existingLabel.htmlFor === select.id) existingLabel.htmlFor = trigger.id;
  }
  (select.closest?.('dialog') || document.body).append(popup);
  let options = [];
  let visible = [];
  let active = -1;
  let optionRows = [];
  let searchable = false;
  let typeahead = '';
  let lastTyped = 0;

  function position() {
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(window.innerWidth - 16, Math.max(bounds.width, select.id === 'chat-model' ? 310 : 220));
    const below = window.innerHeight - bounds.bottom - 12;
    const above = bounds.top - 12;
    const height = Math.min(360, Math.max(below, above));
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${Math.max(100, height)}px`;
    popup.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`;
    popup.style.top = `${below >= Math.min(300, above) ? bounds.bottom + 5 : Math.max(8, bounds.top - Math.min(popup.scrollHeight, height) - 5)}px`;
  }

  function markActive(index, scroll = true) {
    if (optionRows[active]) optionRows[active].dataset.active = 'false';
    active = index;
    const row = optionRows[active];
    if (row) row.dataset.active = 'true';
    for (const control of [trigger, search]) {
      if (row) control.setAttribute('aria-activedescendant', row.id);
      else control.removeAttribute('aria-activedescendant');
    }
    if (row && scroll) row.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    const query = search.value.trim().toLocaleLowerCase();
    visible = options.filter((entry) => !query || `${entry.text} ${entry.group}`.toLocaleLowerCase().includes(query));
    list.replaceChildren();
    optionRows = [];
    let previousGroup = '';
    for (const [index, entry] of visible.entries()) {
      if (entry.group && entry.group !== previousGroup) {
        const group = document.createElement('div');
        group.className = 'themed-dropdown-group';
        group.textContent = entry.group;
        group.setAttribute('role', 'presentation');
        list.append(group);
      }
      previousGroup = entry.group;
      const row = document.createElement('div');
      row.id = `${select.id}-option-${entry.index}`;
      row.className = 'themed-dropdown-option';
      row.tabIndex = -1;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(entry.value === select.value));
      row.setAttribute('aria-disabled', String(entry.disabled));
      row.setAttribute('aria-label', entry.group ? `${entry.text}, ${entry.group}` : entry.text);
      row.textContent = entry.text;
      row.addEventListener('pointermove', () => { if (!entry.disabled) markActive(index, false); });
      row.addEventListener('click', () => choose(index));
      list.append(row);
      optionRows.push(row);
    }
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'themed-dropdown-empty';
      empty.textContent = 'No matching options.';
      empty.setAttribute('role', 'status');
      list.append(empty);
    }
    const selected = visible.findIndex((entry) => entry.value === select.value && !entry.disabled);
    markActive(selected >= 0 ? selected : visible.findIndex((entry) => !entry.disabled), false);
    position();
  }

  function sync() {
    options = [...select.options].map((option, index) => ({ index, value: option.value, text: option.textContent, group: option.parentElement.tagName === 'OPTGROUP' ? option.parentElement.label : '', disabled: option.disabled || option.parentElement.disabled }));
    searchable = select.id === 'chat-model' || options.length > 12;
    search.hidden = !searchable;
    trigger.disabled = select.disabled;
    label.textContent = select.selectedOptions[0]?.textContent || options[0]?.text || 'Select an option';
    const name = select.getAttribute('aria-label');
    if (name) trigger.setAttribute('aria-label', `${name}: ${label.textContent}`);
    if (select.getAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
    trigger.title = label.textContent;
    if (trigger.disabled) close(false);
    if (!popup.hidden) render();
  }

  function close(focus = true) {
    if (popup.hidden) return;
    popup.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    search.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    search.removeAttribute('aria-activedescendant');
    if (focus && !trigger.disabled) trigger.focus();
    onOpenChange?.(false);
  }

  function open() {
    if (trigger.disabled) return;
    document.dispatchEvent(new CustomEvent('easel-dropdown-opening', { detail: trigger.id }));
    search.value = '';
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-expanded', 'true');
    render();
    onOpenChange?.(true);
    if (searchable) search.focus();
    markActive(active);
  }

  function choose(index) {
    const entry = visible[index];
    if (!entry || entry.disabled || trigger.disabled) return;
    select.value = entry.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
    close();
  }

  function move(direction, edge = false) {
    const enabled = visible.map((entry, index) => entry.disabled ? -1 : index).filter((index) => index >= 0);
    if (!enabled.length) return;
    const current = enabled.indexOf(active);
    const index = edge ? direction > 0 ? enabled.at(-1) : enabled[0] : enabled[Math.max(0, Math.min(enabled.length - 1, current + direction))];
    markActive(index);
  }

  function keydown(event) {
    if (event.key === 'Escape') { if (!popup.hidden) { event.preventDefault(); event.stopPropagation(); close(); } return; }
    if (event.key === 'Tab') { close(event.target === search); return; }
    if (event.target === search && ['Home', 'End'].includes(event.key)) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (popup.hidden) open();
      else move(event.key === 'ArrowUp' || event.key === 'Home' ? -1 : 1, event.key === 'Home' || event.key === 'End');
      return;
    }
    if (event.key === 'Enter' || (event.key === ' ' && event.target === trigger)) {
      event.preventDefault();
      if (popup.hidden) open();
      else choose(active);
      return;
    }
    if (event.target === trigger && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (popup.hidden) open();
      if (searchable) { search.value += event.key; render(); }
      else {
        const now = Date.now();
        typeahead = now - lastTyped < 700 ? typeahead + event.key : event.key;
        lastTyped = now;
        const index = visible.findIndex((entry) => !entry.disabled && entry.text.toLocaleLowerCase().startsWith(typeahead.toLocaleLowerCase()));
        if (index >= 0) markActive(index);
      }
    }
  }

  trigger.addEventListener('click', () => popup.hidden ? open() : close());
  trigger.addEventListener('keydown', keydown);
  search.addEventListener('keydown', keydown);
  search.addEventListener('input', render);
  select.addEventListener('change', () => queueMicrotask(sync));
  document.addEventListener('pointerdown', (event) => { if (!wrapper.contains(event.target) && !popup.contains(event.target)) close(false); });
  document.addEventListener('focusin', (event) => { if (!wrapper.contains(event.target) && !popup.contains(event.target)) close(false); });
  document.addEventListener('easel-dropdown-opening', (event) => { if (event.detail !== trigger.id) close(false); });
  window.addEventListener('resize', () => close(false));
  document.addEventListener('scroll', (event) => { if (!popup.contains(event.target)) close(false); }, true);
  const observer = new MutationObserver(sync);
  observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
  sync();
  return { sync, close, isOpen: () => !popup.hidden };
}

if (typeof module !== 'undefined') module.exports = { createThemedDropdown };
