// Updates from GitHub releases. The installed version downloads in the background and installs on restart;
// the portable exe can't replace itself, so it only finds out about new versions and links to the download.
const { app, net } = require('electron');

const REPO = 'phsrp/hearth';
const RELEASES = `https://github.com/${REPO}/releases/latest`;

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;
const newer = (a, b) => {
  const x = String(a).replace(/^v/, '').split('.').map(Number);
  const y = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

function createUpdater(send) {
  // state: idle | checking | latest | available (portable / dev) | downloading | ready | error
  // HEARTH_UPDATE_TEST can pretend to be an older version, to see the banner
  let state = { status: 'idle', current: process.env.HEARTH_UPDATE_TEST || app.getVersion(), portable: isPortable() };
  const set = (patch) => { state = { ...state, ...patch }; send(state); };
  let auto = null;

  if (app.isPackaged && !isPortable()) {
    auto = require('electron-updater').autoUpdater;
    auto.autoDownload = true;
    auto.autoInstallOnAppQuit = true;
    auto.on('checking-for-update', () => set({ status: 'checking' }));
    auto.on('update-not-available', () => set({ status: 'latest', checkedAt: Date.now() }));
    auto.on('update-available', (i) => set({ status: 'downloading', version: i.version, percent: 0 }));
    auto.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    auto.on('update-downloaded', (i) => set({ status: 'ready', version: i.version }));
    auto.on('error', (e) => set({ status: 'error', error: String(e?.message || e).split('\n')[0] }));
  }

  // Portable and unpackaged builds ask the GitHub API which release is newest.
  async function checkManually() {
    set({ status: 'checking' });
    try {
      const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hearth' } });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
      const j = await r.json();
      const version = String(j.tag_name || '').replace(/^v/, '');
      if (version && newer(version, state.current)) set({ status: 'available', version, url: j.html_url || RELEASES });
      else set({ status: 'latest', checkedAt: Date.now() });
    } catch (e) {
      set({ status: 'error', error: e.message });
    }
  }

  return {
    get: () => state,
    check() {
      if (state.status === 'downloading' || state.status === 'ready' || state.status === 'checking') return state;
      if (auto) auto.checkForUpdates().catch((e) => set({ status: 'error', error: String(e?.message || e).split('\n')[0] }));
      else checkManually();
      return state;
    },
    install() { if (auto && state.status === 'ready') auto.quitAndInstall(false, true); },
    releasesUrl: RELEASES,
  };
}

module.exports = { createUpdater, newer };
