// Auto Dark Mode — popup script
const $ = (id) => document.getElementById(id);
const globalToggle = $('globalToggle');
const statusPill = $('statusPill');
const darknessSlider = $('darknessSlider');
const sliderValue = $('sliderValue');
const hostLabel = $('hostLabel');
const whitelistToggle = $('whitelistToggle');
const whitelistEl = $('whitelist');
const whitelistCount = $('whitelistCount');
const stats = $('stats');

let currentHost = null;
let currentWhitelist = [];

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setPill(text, cls) {
  statusPill.textContent = text;
  statusPill.className = 'pill ' + cls;
}

async function send(action, payload = {}) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { action, ...payload });
  } catch (_) {
    return null;
  }
}

async function refresh() {
  const tab = await getActiveTab();
  const isHttp = tab && /^https?:/.test(tab.url || '');

  // Always read prefs from storage so the popup works even on non-http pages
  const prefs = await chrome.storage.local.get(['enabled', 'darkness', 'whitelist']);
  const enabled = prefs.enabled !== false;
  const darkness = typeof prefs.darkness === 'number' ? prefs.darkness : 100;
  currentWhitelist = Array.isArray(prefs.whitelist) ? prefs.whitelist : [];

  globalToggle.classList.toggle('on', enabled);
  darknessSlider.value = darkness;
  sliderValue.textContent = darkness;
  renderWhitelist();

  if (!isHttp) {
    setPill('n/a', 'off');
    hostLabel.textContent = '(non-http page)';
    whitelistToggle.disabled = true;
    whitelistToggle.textContent = 'Disable on this site';
    return;
  }

  const url = new URL(tab.url);
  currentHost = url.hostname;
  hostLabel.textContent = currentHost;
  whitelistToggle.disabled = false;

  const onWhitelist = currentWhitelist.includes(currentHost);
  whitelistToggle.textContent = onWhitelist ? 'Re-enable on this site' : 'Disable on this site';
  whitelistToggle.classList.toggle('danger', !onWhitelist);

  const resp = await send('getStatus');
  if (!resp) {
    setPill('reload page', 'off');
    stats.textContent = '';
    return;
  }

  if (!enabled) setPill('extension off', 'off');
  else if (resp.isWhitelisted) setPill('whitelisted', 'off');
  else if (resp.detection && resp.detection.isDark) setPill('already dark', 'dark');
  else if (resp.themeApplied) setPill('true dark mode', 'applied');
  else setPill('light', 'light');

  if (resp.detection) {
    const bg = resp.detection.bgLum;
    const tx = resp.detection.textLum;
    stats.textContent =
      'bg lum: ' + (bg !== null && bg !== undefined ? bg.toFixed(2) : '–') +
      '   text lum: ' + (tx !== null && tx !== undefined ? tx.toFixed(2) : '–');
  } else {
    stats.textContent = '';
  }
}

function renderWhitelist() {
  whitelistEl.innerHTML = '';
  whitelistCount.textContent = currentWhitelist.length ? '(' + currentWhitelist.length + ')' : '';
  if (currentWhitelist.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wl-empty';
    empty.textContent = 'No sites whitelisted yet.';
    whitelistEl.appendChild(empty);
    return;
  }
  for (const host of currentWhitelist) {
    const row = document.createElement('div');
    row.className = 'wl-row';
    const span = document.createElement('span');
    span.className = 'wl-host';
    span.textContent = host;
    const btn = document.createElement('button');
    btn.className = 'wl-remove';
    btn.title = 'Remove from whitelist';
    btn.textContent = '×';
    btn.addEventListener('click', () => removeFromWhitelist(host));
    row.appendChild(span);
    row.appendChild(btn);
    whitelistEl.appendChild(row);
  }
}

async function removeFromWhitelist(host) {
  currentWhitelist = currentWhitelist.filter((h) => h !== host);
  await chrome.storage.local.set({ whitelist: currentWhitelist });
  // Notify content script(s) — the active tab listens for storage changes too,
  // but we explicitly poke it for snappy feedback.
  await send('removeFromWhitelist', { host });
  refresh();
}

globalToggle.addEventListener('click', async () => {
  const enabled = !globalToggle.classList.contains('on');
  globalToggle.classList.toggle('on', enabled);
  await chrome.storage.local.set({ enabled });
  await send('setEnabled', { value: enabled });
  refresh();
});

darknessSlider.addEventListener('input', () => {
  const value = parseInt(darknessSlider.value, 10);
  sliderValue.textContent = value;
  // Live preview while dragging — debounced to one message per animation frame.
  if (darknessSlider._raf) cancelAnimationFrame(darknessSlider._raf);
  darknessSlider._raf = requestAnimationFrame(() => {
    chrome.storage.local.set({ darkness: value });
    send('setDarkness', { value });
  });
});

whitelistToggle.addEventListener('click', async () => {
  if (!currentHost) return;
  const onWhitelist = currentWhitelist.includes(currentHost);
  if (onWhitelist) {
    currentWhitelist = currentWhitelist.filter((h) => h !== currentHost);
    await chrome.storage.local.set({ whitelist: currentWhitelist });
    await send('removeFromWhitelist', { host: currentHost });
  } else {
    currentWhitelist = currentWhitelist.concat([currentHost]);
    await chrome.storage.local.set({ whitelist: currentWhitelist });
    await send('addToWhitelist', { host: currentHost });
  }
  setTimeout(refresh, 100);
});

document.addEventListener('DOMContentLoaded', refresh);
refresh();
