// Auto Dark Mode — content script
// Runs on every page at document_start.
// Strategy:
//   1. As early as possible, hint the page that the user prefers dark mode
//      (color-scheme: dark on <html>, plus a <meta name="color-scheme">).
//   2. After the page renders, measure the real luminance of the background
//      and primary text. If it looks light, apply a true dark-mode stylesheet
//      that remaps light surfaces/text/borders to dark palette colors while
//      leaving media colors alone.
//   3. Watch for navigation / late style changes and re-evaluate.

(() => {
  if (window.top !== window.self) return; // top frame only

  const STYLE_ID = '__auto_dark_mode_styles__';
  const META_ID = '__auto_dark_mode_meta__';
  const DARK_THRESHOLD = 0.32;       // avg bg luminance below this = already dark
  const LIGHT_TEXT_THRESHOLD = 0.55; // text luminance above this = light text (dark mode signal)

  // Defaults
  let userEnabled = true;
  let darkness = 100;       // 0..100 — controls how dark the generated theme looks
  let whitelist = [];       // hostnames where extension is disabled

  // ---- Storage ----------------------------------------------------------
  function loadPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['enabled', 'darkness', 'whitelist'], (res) => {
          userEnabled = res.enabled !== false;
          if (typeof res.darkness === 'number') darkness = clampDarkness(res.darkness);
          whitelist = Array.isArray(res.whitelist) ? res.whitelist.slice() : [];
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  function clampDarkness(v) {
    v = Number(v);
    if (!isFinite(v)) return 100;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function isWhitelisted() {
    const host = location.hostname;
    return whitelist.some((h) => h === host || host.endsWith('.' + h));
  }

  function isActive() {
    if (!userEnabled) return false;
    if (isWhitelisted()) return false;
    return true;
  }

  // ---- Step 1: hint the page ASAP --------------------------------------
  function hintDarkScheme() {
    try {
      document.documentElement.style.colorScheme = 'dark';
    } catch (_) {}
    insertMetaWhenReady();
  }

  function insertMetaWhenReady() {
    const tryInsert = () => {
      if (!document.head) return false;
      if (document.getElementById(META_ID)) return true;
      const meta = document.createElement('meta');
      meta.id = META_ID;
      meta.name = 'color-scheme';
      meta.content = 'dark light';
      document.head.appendChild(meta);
      return true;
    };
    if (tryInsert()) return;
    const obs = new MutationObserver(() => {
      if (tryInsert()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---- Detection --------------------------------------------------------
  function parseColor(str) {
    if (!str) return null;
    if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const isColorFunction = /^color\(/i.test(str.trim());
    const m = str.match(/-?\d*\.?\d+%?/g);
    if (!m || m.length < 3) return null;
    const component = (token) => {
      if (token.endsWith('%')) return clamp(Number(token.slice(0, -1)) * 2.55, 0, 255);
      const n = Number(token);
      return isColorFunction ? clamp(n * 255, 0, 255) : clamp(n, 0, 255);
    };
    const alpha = (token) => {
      if (!token) return 1;
      if (token.endsWith('%')) return clamp(Number(token.slice(0, -1)) / 100, 0, 1);
      return clamp(Number(token), 0, 1);
    };
    const [r, g, b] = m.slice(0, 3).map(component);
    const a = m.length >= 4 ? alpha(m[m.length - 1]) : 1;
    return { r, g, b, a };
  }

  function relLuminance({ r, g, b }) {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  function effectiveBgLuminance(el) {
    while (el) {
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.5) return relLuminance(c);
      el = el.parentElement;
    }
    return null;
  }

  function detectIsDark() {
    const samples = [];
    const root = document.documentElement;
    const body = document.body;
    if (root) {
      const c = parseColor(getComputedStyle(root).backgroundColor);
      if (c && c.a > 0.5) samples.push(relLuminance(c));
    }
    if (body) {
      const lum = effectiveBgLuminance(body);
      if (lum !== null) samples.push(lum);
    }
    const selectors = ['main', 'article', '[role="main"]', '#content', '.content', '#root', '#app'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const lum = effectiveBgLuminance(el);
        if (lum !== null) samples.push(lum);
      }
    }
    if (samples.length === 0) return { isDark: false, bgLum: null, textLum: null };
    const bgAvg = samples.reduce((a, b) => a + b, 0) / samples.length;
    let textLum = null;
    if (body) {
      const tc = parseColor(getComputedStyle(body).color);
      if (tc) textLum = relLuminance(tc);
    }
    const bgIsDark = bgAvg < DARK_THRESHOLD;
    const textIsLight = textLum !== null && textLum > LIGHT_TEXT_THRESHOLD;
    const isDark = bgIsDark && (textIsLight || textLum === null);
    return { isDark, bgLum: bgAvg, textLum };
  }

  // ---- Application ------------------------------------------------------
  const THEME_ATTR_SELECTOR = [
    '[data-adm-bg]',
    '[data-adm-fg]',
    '[data-adm-border]',
    '[data-adm-bg-image]',
  ].join(',');
  const SKIP_THEME_SELECTOR = [
    'script',
    'style',
    'link',
    'meta',
    'title',
    'noscript',
    'template',
    'head',
    'br',
    'wbr',
    'source',
    'track',
    '[data-keep-color]',
  ].join(',');
  const MEDIA_SELECTOR = 'img, video, picture, iframe, canvas, svg, embed, object';
  const THEME_VARS = ['--adm-bg-color', '--adm-fg-color', '--adm-border-color'];
  const MAX_THEME_ELEMENTS = 6000;

  let themeApplied = false;
  let isApplyingTheme = false;

  function mix(a, b, t) {
    return Math.round(a + (b - a) * t);
  }

  function rgbCss(rgb) {
    return 'rgb(' + rgb.map((n) => clamp(Math.round(n), 0, 255)).join(', ') + ')';
  }

  function rgbaCss(rgb, a) {
    return 'rgba(' + rgb.map((n) => clamp(Math.round(n), 0, 255)).join(', ') + ', ' + a.toFixed(2) + ')';
  }

  function mixRgb(a, b, t) {
    return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
  }

  function paletteForDarkness(d) {
    const t = clamp(d / 100, 0, 1);
    return {
      pageBg: rgbCss(mixRgb([48, 52, 59], [7, 9, 14], t)),
      surfaceBg: rgbCss(mixRgb([59, 64, 72], [18, 22, 29], t)),
      controlBg: rgbCss(mixRgb([66, 72, 82], [24, 29, 38], t)),
      codeBg: rgbCss(mixRgb([56, 61, 69], [14, 18, 25], t)),
      text: '#eef2f7',
      muted: '#c5ccd6',
      link: '#8ab4f8',
      border: rgbCss(mixRgb([91, 98, 110], [45, 52, 63], t)),
      imageOverlay: rgbaCss([5, 8, 13], 0.26 + 0.28 * t),
    };
  }

  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }

    return { h, s, l };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;

    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  function hslCss(h, s, l) {
    return rgbCss(hslToRgb(h, s, l));
  }

  function darkSurfaceFor(color, palette, isRoot) {
    if (!color || color.a < 0.15) return null;
    const lum = relLuminance(color);
    if (lum < 0.24) return null;

    const hsl = rgbToHsl(color);
    const t = clamp(darkness / 100, 0, 1);
    if (isRoot && hsl.s < 0.08) return palette.pageBg;

    const baseLightness = isRoot ? (0.19 - 0.145 * t) : (0.31 - 0.22 * t);
    const hierarchyBoost = Math.max(0, 0.78 - lum) * 0.05;
    const targetLightness = clamp(baseLightness + hierarchyBoost, isRoot ? 0.04 : 0.07, isRoot ? 0.24 : 0.34);
    const targetSaturation = hsl.s < 0.08 ? 0 : clamp(hsl.s * 0.42, 0.08, 0.34);
    return hslCss(hsl.h, targetSaturation, targetLightness);
  }

  function lightTextFor(color, palette, el) {
    if (!color || color.a < 0.35) return null;
    const lum = relLuminance(color);
    if (lum > 0.58) return null;

    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'a' || el.closest && el.closest('a')) return palette.link;

    const hsl = rgbToHsl(color);
    if (hsl.s < 0.10) return palette.text;
    return hslCss(hsl.h, clamp(hsl.s * 0.62, 0.18, 0.58), 0.82);
  }

  function borderFor(colors, palette) {
    const visible = colors.filter((c) => c && c.a > 0.2 && relLuminance(c) > 0.28);
    if (visible.length === 0) return null;
    const strongest = visible[0];
    const hsl = rgbToHsl(strongest);
    if (hsl.s < 0.12) return palette.border;
    const t = clamp(darkness / 100, 0, 1);
    return hslCss(hsl.h, clamp(hsl.s * 0.35, 0.08, 0.28), 0.34 - 0.14 * t);
  }

  function hasVisibleBorder(cs) {
    return ['Top', 'Right', 'Bottom', 'Left'].some((side) => (
      cs['border' + side + 'Style'] !== 'none' &&
      cs['border' + side + 'Width'] !== '0px'
    ));
  }

  function isLargeBackgroundImage(el, cs) {
    if (!cs.backgroundImage || cs.backgroundImage === 'none') return false;
    if (el.matches && el.matches(MEDIA_SELECTOR)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 48 && rect.height >= 24;
  }

  function clearElementTheme(el) {
    if (!el || !el.removeAttribute || !el.style) return;
    el.removeAttribute('data-adm-bg');
    el.removeAttribute('data-adm-fg');
    el.removeAttribute('data-adm-border');
    el.removeAttribute('data-adm-bg-image');
    THEME_VARS.forEach((name) => el.style.removeProperty(name));
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }

  function clearThemeAttributes() {
    clearElementTheme(document.documentElement);
    clearElementTheme(document.body);
    document.querySelectorAll(THEME_ATTR_SELECTOR).forEach(clearElementTheme);
  }

  function shouldThemeElement(el) {
    if (!el || !el.matches) return false;
    if (el.matches(SKIP_THEME_SELECTOR)) return false;
    if (el.matches(MEDIA_SELECTOR)) return false;
    if (el.closest && el.closest('svg')) return false;
    return true;
  }

  function themeElement(el, palette) {
    if (!shouldThemeElement(el)) return;
    clearElementTheme(el);

    const cs = getComputedStyle(el);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return;

    const isRoot = el === document.documentElement || el === document.body;
    const bg = darkSurfaceFor(parseColor(cs.backgroundColor), palette, isRoot);
    if (bg) {
      el.setAttribute('data-adm-bg', '');
      el.style.setProperty('--adm-bg-color', bg);
    }

    const fg = lightTextFor(parseColor(cs.color), palette, el);
    if (fg) {
      el.setAttribute('data-adm-fg', '');
      el.style.setProperty('--adm-fg-color', fg);
    }

    if (hasVisibleBorder(cs)) {
      const border = borderFor([
        parseColor(cs.borderTopColor),
        parseColor(cs.borderRightColor),
        parseColor(cs.borderBottomColor),
        parseColor(cs.borderLeftColor),
      ], palette);
      if (border) {
        el.setAttribute('data-adm-border', '');
        el.style.setProperty('--adm-border-color', border);
      }
    }

    if (isLargeBackgroundImage(el, cs)) {
      el.setAttribute('data-adm-bg-image', '');
    }
  }

  function themeDocument() {
    const palette = paletteForDarkness(darkness);
    themeElement(document.documentElement, palette);
    if (document.body) {
      themeElement(document.body, palette);
      const all = document.body.querySelectorAll('*');
      const limit = Math.min(all.length, MAX_THEME_ELEMENTS);
      for (let i = 0; i < limit; i++) themeElement(all[i], palette);
    }
  }

  function buildCss() {
    const palette = paletteForDarkness(darkness);
    return `
      :root {
        color-scheme: dark !important;
        --adm-page-bg: ${palette.pageBg};
        --adm-surface-bg: ${palette.surfaceBg};
        --adm-control-bg: ${palette.controlBg};
        --adm-code-bg: ${palette.codeBg};
        --adm-text: ${palette.text};
        --adm-muted: ${palette.muted};
        --adm-link: ${palette.link};
        --adm-border: ${palette.border};
        --adm-image-overlay: ${palette.imageOverlay};
      }
      html, body {
        background-color: var(--adm-page-bg) !important;
        color: var(--adm-text) !important;
      }
      [data-adm-bg] { background-color: var(--adm-bg-color) !important; }
      [data-adm-fg] { color: var(--adm-fg-color) !important; }
      [data-adm-border] { border-color: var(--adm-border-color) !important; }
      [data-adm-bg-image] {
        box-shadow: inset 0 0 0 9999px var(--adm-image-overlay) !important;
      }
      a:not([data-adm-fg]), a:not([data-adm-fg]) * { color: var(--adm-link) !important; }
      input, textarea, select, button, option {
        color-scheme: dark !important;
        background-color: var(--adm-control-bg) !important;
        color: var(--adm-text) !important;
        border-color: var(--adm-border) !important;
      }
      ::placeholder { color: var(--adm-muted) !important; opacity: 1 !important; }
      table, thead, tbody, tfoot, tr, th, td, fieldset, hr {
        border-color: var(--adm-border) !important;
      }
      code, pre, kbd, samp {
        background-color: var(--adm-code-bg) !important;
        color: var(--adm-text) !important;
      }
      mark {
        background-color: #6b5b22 !important;
        color: var(--adm-text) !important;
      }
    `;
  }

  function ensureThemeStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    return style;
  }

  function applyTheme() {
    themeApplied = true;
    isApplyingTheme = true;

    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.disabled = true;

    try {
      themeDocument();
      const style = ensureThemeStyle();
      style.textContent = buildCss();
      style.disabled = false;
    } finally {
      setTimeout(() => { isApplyingTheme = false; }, 0);
    }
  }

  function removeTheme() {
    themeApplied = false;
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
    clearThemeAttributes();
  }

  function clearHints() {
    try { document.documentElement.style.colorScheme = ''; } catch (_) {}
    const m = document.getElementById(META_ID);
    if (m) m.remove();
  }

  // ---- Lifecycle --------------------------------------------------------
  let lastResult = null;

  function evaluate() {
    if (!isActive()) {
      removeTheme();
      clearHints();
      return;
    }
    if (themeApplied) {
      applyTheme();
      return;
    }
    const result = detectIsDark();
    lastResult = result;
    if (result.isDark) {
      removeTheme();
    } else {
      applyTheme();
    }
  }

  function scheduleEvaluations() {
    [50, 250, 800, 2000, 4000].forEach((ms) => setTimeout(() => evaluate(), ms));
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => evaluate());
    }
    window.addEventListener('load', () => evaluate());
  }

  function watchForChanges() {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (isApplyingTheme) return;
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        evaluate();
      }, themeApplied ? 120 : 0);
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'data-color-mode', 'style'],
      });
    }
  }

  // ---- Messaging --------------------------------------------------------
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.action) return;

      if (msg.action === 'getStatus') {
        const result = lastResult || (themeApplied ? null : detectIsDark());
        sendResponse({
          enabled: userEnabled,
          darkness,
          whitelist: whitelist.slice(),
          host: location.hostname,
          isWhitelisted: isWhitelisted(),
          detection: result,
          themeApplied: !!document.getElementById(STYLE_ID),
        });
        return;
      }

      if (msg.action === 'setEnabled') {
        userEnabled = !!msg.value;
        chrome.storage.local.set({ enabled: userEnabled });
        evaluate();
        sendResponse({ ok: true });
        return;
      }

      if (msg.action === 'setDarkness') {
        darkness = clampDarkness(msg.value);
        chrome.storage.local.set({ darkness });
        // If the generated theme is currently applied, refresh it with the
        // new palette; otherwise leave already-dark sites untouched.
        if (themeApplied || document.getElementById(STYLE_ID)) applyTheme();
        sendResponse({ ok: true, darkness });
        return;
      }

      if (msg.action === 'addToWhitelist') {
        const host = (msg.host || location.hostname).trim();
        if (!host) { sendResponse({ ok: false, error: 'empty host' }); return; }
        if (!whitelist.includes(host)) whitelist.push(host);
        chrome.storage.local.set({ whitelist }, () => {
          evaluate();
          sendResponse({ ok: true, whitelist });
        });
        return true; // async
      }

      if (msg.action === 'removeFromWhitelist') {
        const host = (msg.host || '').trim();
        whitelist = whitelist.filter((h) => h !== host);
        chrome.storage.local.set({ whitelist }, () => {
          evaluate();
          sendResponse({ ok: true, whitelist });
        });
        return true; // async
      }
    });
  } catch (_) { /* extension context might be gone */ }

  // React to storage changes from other surfaces (popup in another tab).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.enabled) userEnabled = changes.enabled.newValue !== false;
      if (changes.darkness) darkness = clampDarkness(changes.darkness.newValue);
      if (changes.whitelist) whitelist = Array.isArray(changes.whitelist.newValue) ? changes.whitelist.newValue.slice() : [];
      evaluate();
    });
  } catch (_) {}

  // ---- Boot -------------------------------------------------------------
  loadPrefs().then(() => {
    if (isActive()) hintDarkScheme();
    scheduleEvaluations();
    if (document.readyState !== 'loading') watchForChanges();
    else document.addEventListener('DOMContentLoaded', watchForChanges, { once: true });
  });
})();
