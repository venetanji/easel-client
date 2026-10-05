const { IPC_CHANNELS } = require('./ipc-contract');

function registerTemplateIpc({ ipcMain, assertSender, withCanvas, service }) {
  ipcMain.handle(IPC_CHANNELS.LIST_TEMPLATES, (event, input = {}) => {
    assertSender(event);
    return service.listTemplates(input);
  });
  ipcMain.handle(IPC_CHANNELS.CREATE_TEMPLATE_INSTANCE, (event, input) => {
    assertSender(event);
    return withCanvas(() => service.createTemplateInstance(input));
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_TEMPLATE_INSTANCE, (event, input) => {
    assertSender(event);
    return withCanvas(() => service.openTemplateInstance(input));
  });
}

async function chooseTemplateInstance(result, showDialog) {
  const size = 8;
  let offset = 0;
  while (true) {
    const page = result.choices.slice(offset, offset + size);
    const more = result.choices.length > size;
    const { response } = await showDialog({
      type: 'question', title: result.kind === 'legacy' ? 'Choose the legacy timeline owner' : 'Choose a video sketch',
      message: result.message,
      detail: page.map((entry, index) => `${index + 1}. ${entry.title}\n${entry.documentPath}`).join('\n\n'),
      buttons: ['Cancel', ...page.map((entry, index) => `${index + 1}. ${entry.title.slice(0, 60)}`), ...(more ? ['More sketches…'] : [])],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (more && response === page.length + 1) { offset = offset + size < result.choices.length ? offset + size : 0; continue; }
    if (!Number.isInteger(response) || response < 1 || response > page.length) return null;
    const selected = page[response - 1];
    return { projectId: result.projectId, ...(result.kind === 'legacy' ? { legacyDocumentPath: selected.documentPath } : { instanceId: selected.instanceId }) };
  }
}
module.exports = { registerTemplateIpc, chooseTemplateInstance };
