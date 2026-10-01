function showCanvasInput(request) {
  const previous = document.querySelector('[data-easel-input-overlay]');
  if (previous?.dataset.easelInputOverlay === request.id) return { rendered: true, requestId: request.id };
  if (previous) { previous.__easelDisposeInputUI?.(); previous.remove(); }
  if (typeof window.EaselHost?.submitInput !== 'function') throw new Error('Canvas input bridge is unavailable.');
  const focused = document.activeElement;
  const host = document.createElement('div');
  host.dataset.easelTransient = 'canvas-input';
  host.dataset.easelInputOverlay = request.id;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{font:16px Georgia,serif;color:#243d32;color-scheme:light}
    *{box-sizing:border-box}
    .backdrop{height:100%;display:grid;place-items:center;padding:24px;background:rgba(29,45,37,.3)}
    .panel{width:min(100%,520px);max-height:100%;overflow:auto;padding:32px;border-radius:12px;background:#fffdf3;box-shadow:0 12px 40px rgba(20,35,27,.2)}
    h2{margin:0 0 24px;font-size:28px;line-height:1.25;font-weight:400;overflow-wrap:anywhere}
    .choices{display:grid;gap:10px}
    button{width:100%;text-align:left;padding:14px 18px;background:#fffdf7;color:#243d32;border:1px solid #c3cfbd;border-radius:10px;font:inherit;cursor:pointer;overflow-wrap:anywhere}
    button:hover{border-color:#4d7057;background:#f0f5e8}
    button:focus-visible{outline:3px solid #64886a;outline-offset:3px}
    button:disabled{opacity:.6;cursor:wait}
    .status{margin:16px 0 0;font:13px/1.5 Georgia,serif;color:#586859;min-height:20px}
    .status.error{color:#9a362e}
    .dismiss{width:auto;margin-top:12px;padding:6px 0;border:0;background:none;font-size:14px;text-decoration:underline;color:#59695c}
    .dismiss:hover{background:none;color:#243d32}
    @media(max-width:480px){.backdrop{padding:14px}.panel{padding:24px}h2{font-size:24px}}
  `;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'easel-input-question');
  const heading = document.createElement('h2');
  heading.id = 'easel-input-question';
  heading.textContent = request.question;
  const choices = document.createElement('div');
  choices.className = 'choices';
  const status = document.createElement('p');
  status.className = 'status';
  status.setAttribute('role', 'status');
  status.textContent = request.contextNote || 'Your choice is saved before the conversation continues.';
  const dismiss = document.createElement('button');
  dismiss.className = 'dismiss';
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss question';
  dismiss.hidden = typeof window.EaselHost.cancelInput !== 'function';
  const listeners = [];
  const listen = (element, type, handler) => {
    element.addEventListener(type, handler);
    listeners.push({ element, type, handler });
  };
  host.__easelDisposeInputUI = () => {
    for (const { element, type, handler } of listeners) element.removeEventListener(type, handler);
    listeners.length = 0;
  };
  for (const option of request.options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    listen(button, 'click', async () => {
      for (const item of choices.children) item.disabled = true;
      dismiss.disabled = true;
      status.classList.remove('error');
      status.textContent = 'Saving your choice...';
      try {
        const result = await window.EaselHost.submitInput({ requestId: request.id, value: option.value });
        if (result?.ok === false) throw new Error(result.error || 'Your choice could not be saved.');
        if (host.isConnected) {
          host.__easelDisposeInputUI();
          host.remove();
          if (focused?.isConnected && typeof focused.focus === 'function') focused.focus();
        }
      } catch (error) {
        status.classList.add('error');
        status.textContent = error?.message || 'Your choice could not be saved. Try again.';
        for (const item of choices.children) item.disabled = false;
        dismiss.disabled = false;
      }
    });
    choices.append(button);
  }
  listen(dismiss, 'click', async () => {
    for (const item of choices.children) item.disabled = true;
    dismiss.disabled = true;
    status.classList.remove('error');
    status.textContent = 'Dismissing question...';
    try {
      const result = await window.EaselHost.cancelInput({ requestId: request.id });
      if (result?.ok === false) throw new Error(result.error || 'The question could not be dismissed.');
      if (host.isConnected) {
        host.__easelDisposeInputUI();
        host.remove();
        if (focused?.isConnected && typeof focused.focus === 'function') focused.focus();
      }
    } catch (error) {
      status.classList.add('error');
      status.textContent = error?.message || 'The question could not be dismissed. Try again.';
      for (const item of choices.children) item.disabled = false;
      dismiss.disabled = false;
    }
  });
  listen(panel, 'keydown', (event) => {
    if (event.key !== 'Tab') return;
    const buttons = [...panel.querySelectorAll('button:not(:disabled):not([hidden])')];
    if (!buttons.length) { event.preventDefault(); return; }
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  panel.append(heading, choices, status, dismiss);
  backdrop.append(panel);
  shadow.append(style, backdrop);
  document.body.append(host);
  host.__easelRestoreFocus = () => { if (focused?.isConnected && typeof focused.focus === 'function') focused.focus(); };
  choices.firstElementChild?.focus();
  return { rendered: true, requestId: request.id, transient: true };
}

function dismissCanvasInput(requestId) {
  const host = [...document.querySelectorAll('[data-easel-input-overlay]')].find((element) => element.dataset.easelInputOverlay === requestId);
  if (!host) return { dismissed: false, requestId };
  host.__easelDisposeInputUI?.();
  host.remove();
  host.__easelRestoreFocus?.();
  return { dismissed: true, requestId, restoredPreviousView: true };
}

function scriptArgument(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }
function renderCanvasInputScript(request) { return `(${showCanvasInput.toString()})(${scriptArgument({ id: request.id, question: request.question, options: request.options, contextNote: request.contextNote || '' })})`; }
function dismissCanvasInputScript(requestId) { return `(${dismissCanvasInput.toString()})(${scriptArgument(requestId)})`; }

module.exports = { renderCanvasInputScript, dismissCanvasInputScript };
