function configureSecureStorage(app, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux' || app.commandLine.hasSwitch('password-store')) return;
  const desktop = env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP || env.DESKTOP_SESSION || '';
  if (desktop.split(':').some((name) => /^(kde|plasma)/i.test(name.trim())) || env.KDE_FULL_SESSION === 'true') return;

  // Chromium does not recognize Hyprland/Sway; select Secret Service before startup.
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

module.exports = { configureSecureStorage };
