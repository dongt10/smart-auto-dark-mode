// Auto Dark Mode — popup script
const $ = (id) => document.getElementById(id);
const globalToggle = $('globalToggle');
const statusPill = $('statusPill');
const darknessSlider = $('darknessSlider');
const sliderValue = $('sliderValue');
const hostLabel = $('hostLabel');
const modeLabel = $('modeLabel');
const standardMode = $('standardMode');
const betaMode = $('betaMode');
const whitelistToggle = $('whitelistToggle');
const whitelistEl = $('whitelist');
const whitelistCount = $('whitelistCount');
const stats = $('stats');

const hasChromeApi =
  typeof chrome !== 'undefined' &&
  chrome.tabs &&
  chrome.storage &&
  chrome.storage.local;
let demoPrefs = {
  enabled: true,
  darkness: 88,
  whitelist: ['docs.example.com'],
  siteModes: {},
};
let currentHost = null;
let currentWhitelist = [];
let currentSiteModes = {};
let currentMode = 'standard';

async function getActiveTab() {
  if (!hasChromeApi) {
    return { id: 1, url: 'https://example.com/article' };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getPrefs(keys) {
  if (!hasChromeApi) {
    return keys.reduce((prefs, key) => {
      prefs[key] = demoPrefs[key];
      return prefs;
    }, {});
  }
  return chrome.storage.local.get(keys);
}

async function setPrefs(values) {
  if (!hasChromeApi) {
    demoPrefs = { ...demoPrefs, ...values };
    return;
  }
  await chrome.storage.local.set(values);
}

function setPill(text, cls) {
  statusPill.textContent = text;
  statusPill.className = 'pill ' + cls;
}

function setSliderUi(value) {
  darknessSlider.value = value;
  darknessSlider.style.setProperty('--slider-progress', value + '%');
  sliderValue.textContent = value + '%';
}

function modeForHost(host) {
  return currentSiteModes[host] === 'beta' ? 'beta' : 'standard';
}

function setModeUi(mode, disabled = false) {
  currentMode = mode === 'beta' ? 'beta' : 'standard';
  modeLabel.textContent = currentMode === 'beta' ? 'Beta' : 'Standard';
  standardMode.classList.toggle('active', currentMode === 'standard');
  betaMode.classList.toggle('active', currentMode === 'beta');
  standardMode.setAttribute('aria-pressed', String(currentMode === 'standard'));
  betaMode.setAttribute('aria-pressed', String(currentMode === 'beta'));
  standardMode.disabled = disabled;
  betaMode.disabled = disabled;
}

async function send(action, payload = {}) {
  if (!hasChromeApi) {
    return {
      isWhitelisted: currentHost ? currentWhitelist.includes(currentHost) : false,
      siteMode: currentHost ? modeForHost(currentHost) : 'standard',
      themeApplied: action === 'getStatus' ? true : undefined,
      detection: action === 'getStatus' ? { isDark: false, bgLum: 0.76, textLum: 0.14 } : undefined,
      ...payload,
    };
  }
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
  const prefs = await getPrefs(['enabled', 'darkness', 'whitelist', 'siteModes']);
  const enabled = prefs.enabled !== false;
  const darkness = typeof prefs.darkness === 'number' ? prefs.darkness : 100;
  currentWhitelist = Array.isArray(prefs.whitelist) ? prefs.whitelist : [];
  currentSiteModes = prefs.siteModes && typeof prefs.siteModes === 'object' ? prefs.siteModes : {};

  globalToggle.classList.toggle('on', enabled);
  globalToggle.setAttribute('aria-checked', String(enabled));
  globalToggle.title = enabled ? 'Extension on' : 'Extension off';
  setSliderUi(darkness);
  renderWhitelist();

  if (!isHttp) {
    currentHost = null;
    setPill('n/a', 'off');
    hostLabel.textContent = '(non-http page)';
    setModeUi('standard', true);
    whitelistToggle.disabled = true;
    whitelistToggle.textContent = 'Disable on this site';
    stats.textContent = '';
    return;
  }

  const url = new URL(tab.url);
  currentHost = url.hostname;
  hostLabel.textContent = currentHost;
  whitelistToggle.disabled = false;
  setModeUi(modeForHost(currentHost));

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
  else if (resp.siteMode === 'beta') setPill('beta mode', 'applied');
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
    btn.setAttribute('aria-label', 'Remove ' + host + ' from whitelist');
    btn.textContent = '×';
    btn.addEventListener('click', () => removeFromWhitelist(host));
    row.appendChild(span);
    row.appendChild(btn);
    whitelistEl.appendChild(row);
  }
}

async function removeFromWhitelist(host) {
  currentWhitelist = currentWhitelist.filter((h) => h !== host);
  await setPrefs({ whitelist: currentWhitelist });
  // Notify content script(s) — the active tab listens for storage changes too,
  // but we explicitly poke it for snappy feedback.
  await send('removeFromWhitelist', { host });
  refresh();
}

globalToggle.addEventListener('click', async () => {
  const enabled = !globalToggle.classList.contains('on');
  globalToggle.classList.toggle('on', enabled);
  globalToggle.setAttribute('aria-checked', String(enabled));
  await setPrefs({ enabled });
  await send('setEnabled', { value: enabled });
  refresh();
});

darknessSlider.addEventListener('input', () => {
  const value = parseInt(darknessSlider.value, 10);
  setSliderUi(value);
  // Live preview while dragging — debounced to one message per animation frame.
  if (darknessSlider._raf) cancelAnimationFrame(darknessSlider._raf);
  darknessSlider._raf = requestAnimationFrame(() => {
    setPrefs({ darkness: value });
    send('setDarkness', { value });
  });
});

async function setSiteMode(mode) {
  if (!currentHost) return;
  const nextMode = mode === 'beta' ? 'beta' : 'standard';
  currentSiteModes = { ...currentSiteModes };
  if (nextMode === 'beta') currentSiteModes[currentHost] = 'beta';
  else delete currentSiteModes[currentHost];

  setModeUi(nextMode);
  await setPrefs({ siteModes: currentSiteModes });
  await send('setSiteMode', { host: currentHost, mode: nextMode });
  setTimeout(refresh, 100);
}

standardMode.addEventListener('click', () => setSiteMode('standard'));
betaMode.addEventListener('click', () => setSiteMode('beta'));

whitelistToggle.addEventListener('click', async () => {
  if (!currentHost) return;
  const onWhitelist = currentWhitelist.includes(currentHost);
  if (onWhitelist) {
    currentWhitelist = currentWhitelist.filter((h) => h !== currentHost);
    await setPrefs({ whitelist: currentWhitelist });
    await send('removeFromWhitelist', { host: currentHost });
  } else {
    currentWhitelist = currentWhitelist.concat([currentHost]);
    await setPrefs({ whitelist: currentWhitelist });
    await send('addToWhitelist', { host: currentHost });
  }
  setTimeout(refresh, 100);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', refresh);
} else {
  refresh();
}
