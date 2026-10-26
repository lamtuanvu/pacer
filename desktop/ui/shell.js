// Deterministic browser previews: ?state=starting, ?state=permission&path=/Volumes/Drive or
// ?state=foreign&path=~/.pacer&port=5000&appPort=4317.
const query = new URLSearchParams(location.search);
const pages = {
  welcome: ['Your planner plans. Your other agents do the work.', ''],
  consent: ["Here's what pacer will change", ''],
  existing: ['You already have pacer', ''],
  relink: ["pacer's terminal command was removed", 'Recreate it so you and your agents can run pacer from the terminal.'],
  incomplete: ['This copy of pacer is incomplete', "The app runs pacer through a command-line tool that should come inside it, and it's missing. Download pacer again and replace this app. Your settings are kept."],
  installing: ['Installing update', 'pacer will restart when installation finishes. Cancellation is no longer available.'],
  rollingBack: ['Restoring the previous version', "The update couldn't start. Restoring your previous version."],
  restored: ['Previous version restored', "The update couldn't start. Your previous version has been restored."],
  recoveryFailed: ['Recovery needs attention', "An update didn't finish, and pacer couldn't put the previous version back on its own. Your tasks and settings are safe. Keep this app installed and leave the files in your pacer folder as they are: pacer needs them to recover. Quit pacer, then report the problem."],
  stuck: ['pacer could not finish signing in', 'The desktop app could not connect and sign in to the local pacer service. Retrying automatically in the background.'],
  install: ['pacer needs its command-line tool', "The pacer app runs its background service through the pacer command-line tool, which isn't installed. Install it and this window continues on its own."],
  foreign: ['Another pacer is running', 'The background service belongs to the pacer folder {path}, and this app uses a different one.'],
  foreignPort: ['Another pacer is running', 'The background service for the pacer folder {path} runs on port {port}, and this app uses port {appPort}.'],
  oldService: ['Update pacer', 'This service uses an older protocol. Install a newer version of pacer.'],
  outdatedService: ['Your service needs an update', "The running service supplies this app's screens. Until it is updated, new Dispatcher controls are unavailable."],
  unverifiedService: ['Check the service version', "The desktop could not verify the running service's release. Its screens may differ from this app's version."],
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
// The native shell opens only this exact address externally (logic::RECOVERY_REPORT_URL).
const report = document.createElement('a');
report.id = 'report-issue';
report.textContent = 'Report the problem on GitHub';
report.href = 'https://github.com/lamtuanvu/pacer/issues';
report.className = 'button primary';
report.hidden = true;
const reportActions = document.createElement('div');
reportActions.className = 'actions actions--center';
reportActions.hidden = true;
reportActions.append(report);
document.querySelector('main').append(reportActions);
const progress = ['installing', 'rollingBack'];
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
  for (const page of ['welcome', 'consent', 'existing', 'incomplete', 'relink', 'foreign', 'outdated-service']) {
    document.querySelector(`#${page}`).hidden = permission || (page === 'outdated-service'
      ? !['outdatedService', 'unverifiedService'].includes(detail.page) : detail.page !== page);
  }
  document.querySelector('#live-service-version').textContent = detail.installed || 'Unknown';
  document.querySelector('#desktop-release-version').textContent = detail.version || 'Unknown';
  document.querySelector('#service-update-guide').hidden = compact || !['outdatedService', 'unverifiedService'].includes(detail.page);
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
    : (detail.page === 'recoveryFailed' && compact ? message.replace('report the problem.', 'report the problem at github.com/lamtuanvu/pacer/issues.') : message).replace('{path}', () => detail.path || 'another folder').replace('{port}', () => detail.port).replace('{appPort}', () => detail.appPort) + (detail.page === 'stuck' ? ` Last error: ${detail.error || 'Waiting for sign-in to complete'}. Logs: ~/Library/Logs/pacer/desktop.log (Linux: ~/.local/state/pacer/desktop.log).` : '');
  status.hidden = !status.textContent;
  document.querySelector('#privacy').hidden = !permission;
  document.querySelector('#install-help').hidden = permission || detail.page !== 'install';
  // The compact tray popover cannot open external links, so it shows no dead action.
  report.hidden = reportActions.hidden = permission || detail.page !== 'recoveryFailed' || compact;
  // Starting and update progress pages spin; permission and error pages ask for something.
  document.querySelector('#spinner').hidden = permission || (Boolean(pages[detail.page]) && !progress.includes(detail.page));
}
const compact = query.get('compact') === '1';
window.renderShell = renderShell;
renderShell({
  page: query.get('state'), prompt: query.get('prompt') === '1', path: query.get('path'),
  port: query.get('port'), appPort: query.get('appPort'),
  rc: query.get('rc'), onPath: query.has('onPath') ? query.get('onPath') !== 'false' : undefined,
  installed: query.get('installed'), version: query.get('version'),
});
if (compact) document.body.classList.add('compact');
