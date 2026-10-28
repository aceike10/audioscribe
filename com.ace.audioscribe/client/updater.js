/* AudioScribe updater.
   Checks a GitHub repo for a newer ExtensionBundleVersion in CSXS/manifest.xml,
   downloads the repo, copies it over this extension's folder, then reloads the
   host script and the panel in place. No AE restart needed. */
(function () {
  'use strict';

  const req = typeof cep_node !== 'undefined' ? cep_node.require : require;
  const fs = req('fs'), path = req('path'), os = req('os'), https = req('https'), cp = req('child_process');
  const CEP = window.__adobe_cep__;
  const $ = (id) => document.getElementById(id);
  const SKEY = 'audioscribe.v2.settings';
  const LAST = 'audioscribe.lastUpdateCheck';
  const BUNDLE = 'com.ace.audioscribe';

  const settings = () => { try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; } };
  const say = (m) => { $('status').textContent = m; $('status').title = m; };

  function extDir() {
    const p = decodeURI(CEP.getSystemPath('extension'));
    return os.platform() === 'win32' ? p.replace(/^file:\/\/\//, '') : p.replace(/^file:\/\//, '');
  }
  const versionOf = (xml) => (xml.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1] || '0.0.0';
  const localVersion = () => versionOf(fs.readFileSync(path.join(extDir(), 'CSXS', 'manifest.xml'), 'utf8'));
  function isNewer(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  }

  // Repo from Settings, else from config.json shipped with the panel.
  function configRepo() {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(extDir(), 'config.json'), 'utf8')).updateRepo || '';
      return r.indexOf('YOUR-GITHUB-NAME') >= 0 ? '' : r;
    } catch (e) { return ''; }
  }

  // "owner/name" or "owner/name#branch"; also accepts a pasted github.com URL.
  function repoOf(s) {
    const raw = (s.repo || configRepo()).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+(#[\w./-]+)?$/.test(raw)) return null;
    const [name, branch] = raw.split('#');
    return { name, branch: branch || 'main' };
  }
  const auth = (s) => (s.token ? { Authorization: 'Bearer ' + s.token.trim() } : {});

  function get(url, headers, toFile, hops) {
    hops = hops || 0;
    return new Promise((resolve, reject) => {
      const r = https.get(url, { headers: Object.assign({ 'User-Agent': 'AudioScribe-updater' }, headers) }, (res) => {
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
          res.resume();
          if (hops > 5) return reject(new Error('Too many redirects from GitHub.'));
          const next = new URL(res.headers.location, url);
          const keep = next.host === 'api.github.com' ? headers : { 'User-Agent': 'AudioScribe-updater' };
          return resolve(get(next.toString(), keep, toFile, hops + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(
            res.statusCode === 404 ? 'Repo not found. Check the name, and add a token if the repo is private.' :
              res.statusCode === 401 ? 'GitHub rejected the token. Make a new one with Contents: Read-only.' :
                res.statusCode === 403 ? 'GitHub limited requests for now. Try again in an hour.' :
                  'GitHub returned error ' + res.statusCode + '.'));
        }
        if (toFile) {
          const f = fs.createWriteStream(toFile);
          res.pipe(f);
          f.on('finish', () => f.close(() => resolve(toFile)));
          f.on('error', reject);
        } else {
          let d = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { d += c; });
          res.on('end', () => resolve(d));
        }
      });
      r.on('error', (e) => reject(new Error('Could not reach GitHub: ' + e.message)));
      r.setTimeout(30000, () => r.destroy(new Error('Timed out reaching GitHub.')));
    });
  }

  async function remoteVersion(s, repo) {
    const xml = await get('https://api.github.com/repos/' + repo.name + '/contents/CSXS/manifest.xml?ref=' +
      encodeURIComponent(repo.branch), Object.assign({ Accept: 'application/vnd.github.raw' }, auth(s)));
    if (xml.indexOf(BUNDLE) < 0) throw new Error('That repo doesn\'t contain AudioScribe at its top level.');
    return versionOf(xml);
  }

  // Finds the folder holding CSXS/manifest.xml inside the extracted download.
  function findRoot(dir, depth) {
    const m = path.join(dir, 'CSXS', 'manifest.xml');
    if (fs.existsSync(m) && fs.readFileSync(m, 'utf8').indexOf(BUNDLE) >= 0) return dir;
    if (depth <= 0) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const hit = findRoot(path.join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
    return null;
  }

  function copyInto(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === '__pycache__') continue;
      const a = path.join(src, e.name), b = path.join(dst, e.name);
      if (e.isDirectory()) copyInto(a, b);
      else fs.copyFileSync(a, b);
    }
  }

  function extract(zip, dir) {
    try { cp.execFileSync('tar', ['-xf', zip, '-C', dir]); return; } catch (e) { /* fall through */ }
    try {
      if (os.platform() === 'darwin') cp.execFileSync('/usr/bin/ditto', ['-x', '-k', zip, dir]);
      else cp.execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
    } catch (e) { throw new Error('Could not unpack the update.'); }
  }

  let pending = null;

  async function check(manual) {
    const s = settings();
    const repo = repoOf(s);
    if (!repo) { if (manual) say('Add your GitHub repo in Settings first, like yourname/audioscribe.'); return; }
    try {
      if (manual) say('Checking for updates…');
      const remote = await remoteVersion(s, repo);
      localStorage.setItem(LAST, String(Date.now()));
      const local = localVersion();
      if (isNewer(remote, local)) {
        pending = remote;
        $('btnUpdate').textContent = 'Update to ' + remote;
        $('btnUpdate').hidden = false;
        say('Version ' + remote + ' is available.');
      } else if (manual) {
        say('You have the latest version (' + local + ').');
      }
    } catch (e) {
      if (manual) say(e.message);
    }
  }

  async function install() {
    const s = settings();
    const repo = repoOf(s);
    if (!repo || !pending) return;
    const btn = $('btnUpdate');
    btn.disabled = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audioscribe-update-'));
    try {
      say('Downloading ' + pending + '…');
      const zip = path.join(tmp, 'update.zip');
      await get('https://api.github.com/repos/' + repo.name + '/zipball/' + encodeURIComponent(repo.branch),
        Object.assign({ Accept: 'application/vnd.github+json' }, auth(s)), zip);
      say('Installing…');
      const out = path.join(tmp, 'x');
      fs.mkdirSync(out);
      extract(zip, out);
      const root = findRoot(out, 3);
      if (!root) throw new Error('The download didn\'t contain AudioScribe. Check what\'s in the repo.');
      copyInto(root, extDir());
      const host = path.join(extDir(), 'host', 'host.jsx').replace(/\\/g, '/');
      CEP.evalScript('$.evalFile(' + JSON.stringify(host) + ')', () => {
        sessionStorage.setItem('audioscribe.justUpdated', pending);
        location.reload();
      });
    } catch (e) {
      say('Update failed: ' + e.message);
      btn.disabled = false;
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }

  $('btnUpdate').onclick = install;
  $('btnCheck').onclick = () => check(true);
  $('appVersion').textContent = 'Version ' + localVersion();
  if (configRepo()) $('setRepo').placeholder = configRepo();

  const just = sessionStorage.getItem('audioscribe.justUpdated');
  if (just) {
    sessionStorage.removeItem('audioscribe.justUpdated');
    say('Updated to ' + just + '.');
  }

  // Quietly check once every 12 hours when the panel opens.
  const last = Number(localStorage.getItem(LAST) || 0);
  if (Date.now() - last > 12 * 3600 * 1000) setTimeout(() => check(false), 3000);
})();
