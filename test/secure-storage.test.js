const test = require('node:test');
const assert = require('node:assert/strict');
const { configureSecureStorage } = require('../src/secure-storage');

function commandLine(initial = {}) {
  const switches = new Map(Object.entries(initial));
  const app = { commandLine: {
    hasSwitch: (name) => switches.has(name),
    appendSwitch: (name, value) => switches.set(name, value),
  } };
  return { app, switches };
}

test('uses Secret Service on Linux compositors Chromium does not recognize', () => {
  for (const desktop of ['Hyprland', 'sway', 'GNOME', 'XFCE', '']) {
    const { app, switches } = commandLine();
    configureSecureStorage(app, { platform: 'linux', env: { XDG_CURRENT_DESKTOP: desktop } });
    assert.equal(switches.get('password-store'), 'gnome-libsecret');
  }
});

test('keeps KDE wallet selection and explicit password store choices', () => {
  for (const env of [
    { XDG_CURRENT_DESKTOP: 'KDE' }, { XDG_CURRENT_DESKTOP: 'KDE:Plasma' },
    { XDG_SESSION_DESKTOP: 'KDE' }, { DESKTOP_SESSION: 'plasmawayland' },
    { KDE_FULL_SESSION: 'true' },
  ]) {
    const { app, switches } = commandLine();
    configureSecureStorage(app, { platform: 'linux', env });
    assert.equal(switches.size, 0);
  }
  for (const backend of ['gnome-libsecret', 'kwallet6', 'basic']) {
    const { app, switches } = commandLine({ 'password-store': backend });
    configureSecureStorage(app, { platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'Hyprland' } });
    assert.equal(switches.get('password-store'), backend);
  }
});

test('leaves macOS and Windows secure storage configuration unchanged', () => {
  for (const platform of ['darwin', 'win32']) {
    const { app, switches } = commandLine();
    configureSecureStorage(app, { platform, env: { XDG_CURRENT_DESKTOP: 'Hyprland' } });
    assert.equal(switches.size, 0);
  }
});
