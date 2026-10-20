// Deterministic browser previews: ?state=starting, ?state=permission&path=/Volumes/Drive or
// ?state=foreign&path=~/.pacer&port=5000&appPort=4317.
const query = new URLSearchParams(location.search);
const pages = {
  welcome: ['Your planner plans. Your other agents do the work.', ''],
  consent: ["Here's what pacer will change", ''],
  existing: ['You already have pacer', ''],
  relink: ["pacer's terminal command was removed", 'Recreate it so you and your agents can run pacer from the terminal.'],
  incomplete: ['This copy of pacer is incomplete', "The app runs pacer through a command-line tool that should come inside it, and it's missing. Download pacer again and replace this app. Your settings are kept."],
  stuck: ['pacer could not finish signing in', 'The desktop app could not connect and sign in to the local pacer service. Retrying automatically in the background.'],
  install: ['pacer needs its command-line tool', "The pacer app runs its background service through the pacer command-line tool, which isn't installed. Install it and this window continues on its own."],
  foreign: ['Another pacer is running', 'The background service belongs to the pacer folder {path}, and this app uses a different one.'],
  foreignPort: ['Another pacer is running', 'The background service for the pacer folder {path} runs on port {port}, and this app uses port {appPort}.'],
  oldService: ['Update pacer', 'This service uses an older protocol. Install a newer version of pacer.'],
  oldApp: ['Update the pacer app', 'This service uses a newer protocol. Install a newer desktop app.'],
  protocol: ['Unable to connect', 'The local service returned an incompatible response. Install a compatible version of pacer.'],
};
// Keep recovery markup local to this shell; no IPC capability is needed.
const relink = document.createElement('section');
relink.id = 'relink';
relink.hidden = true;
const relinkActions = document.createElement('div');
relinkActions.className = 'actions';
for (const [id, text, href, primary] of [
  ['recreate-link', 'Recreate it', 'tauri://localhost/action/relink', true],
  ['skip-relink', 'Not now', 'tauri://localhost/index.html?state=starting', false],
]) {
  const action = document.createElement('a');
  action.id = id;
  action.textContent = text;
  action.href = href;
  action.className = primary ? 'button primary' : 'button';
  relinkActions.append(action);
}
relink.append(relinkActions);
document.querySelector('main').append(relink);
const pathChoice = document.querySelector('#path');
const pathRow = document.querySelector('#path-row');
let consentRc = null;
function updateConsentLink() {
  const addPath = !pathRow.hidden && pathChoice.checked;
  document.querySelector('#agree').href = `tauri://localhost/action/consent?path=${addPath ? '1' : '0'}`;
}
pathChoice.addEventListener('change', updateConsentLink);
function renderShell(detail) {
  const permission = detail.page === 'permission' || detail.prompt;
  for (const page of ['welcome', 'consent', 'existing', 'incomplete', 'relink', 'foreign']) {
    document.querySelector(`#${page}`).hidden = permission || detail.page !== page;
  }
  const showPath = !permission && detail.page === 'consent' && detail.onPath === false && Boolean(detail.rc);
  const nextRc = showPath ? detail.rc : null;
  if (!showPath || consentRc !== nextRc) pathChoice.checked = false;
  consentRc = nextRc;
  pathRow.hidden = !showPath;
  document.querySelector('#rc').textContent = detail.rc || '';
  updateConsentLink();
  document.querySelector('#existing-path').textContent = detail.path || '';
  document.querySelector('#installed-version').textContent = detail.installed || '';
  document.querySelector('#app-version').textContent = detail.version || '';
  // Same folder, different port: say so instead of claiming the folders differ.
  const copy = detail.page === 'foreign' && detail.port ? 'foreignPort' : detail.page;
  const [title, message] = pages[copy] || ['Starting pacer…', ''];
  document.querySelector('h1').textContent = permission ? '' : title;
  const target = String(detail.path || '').split('/').filter(Boolean).pop() || 'your external drive';
  const status = document.querySelector('#message');
  status.textContent = permission
    ? `macOS needs your permission for pacer to read ${target}. Click Allow in the macOS dialog.`
    : message.replace('{path}', () => detail.path || 'another folder').replace('{port}', () => detail.port).replace('{appPort}', () => detail.appPort) + (detail.page === 'stuck' ? ` Last error: ${detail.error || 'Waiting for sign-in to complete'}. Logs: ~/Library/Logs/pacer/desktop.log (Linux: ~/.local/state/pacer/desktop.log).` : '');
  status.hidden = !status.textContent;
  document.querySelector('#privacy').hidden = !permission;
  document.querySelector('#install-help').hidden = permission || detail.page !== 'install';
  // Only the plain starting state spins; permission and error pages ask for something.
  document.querySelector('#spinner').hidden = permission || Boolean(pages[detail.page]);
}
window.renderShell = renderShell;
renderShell({
  page: query.get('state'), prompt: query.get('prompt') === '1', path: query.get('path'),
  port: query.get('port'), appPort: query.get('appPort'),
  rc: query.get('rc'), onPath: query.has('onPath') ? query.get('onPath') !== 'false' : undefined,
  installed: query.get('installed'), version: query.get('version'),
});
if (query.get('compact') === '1') document.body.classList.add('compact');
