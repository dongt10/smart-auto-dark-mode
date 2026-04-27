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
  const MODE_STANDARD = 'standard';
  const MODE_BETA = 'beta';
  const DARK_THRESHOLD = 0.32;       // avg bg luminance below this = already dark
  const LIGHT_TEXT_THRESHOLD = 0.55; // text luminance above this = light text (dark mode signal)
  const VISIBLE_DARK_RATIO = 0.64;   // visible shell majority needed to treat SPA UIs as dark

  // Defaults
  let userEnabled = true;
  let darkness = 100;       // 0..100 — controls how dark the generated theme looks
  let whitelist = [];       // hostnames where extension is disabled
  let siteModes = {};       // per-host rendering mode overrides

  // ---- Storage ----------------------------------------------------------
  function loadPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['enabled', 'darkness', 'whitelist', 'siteModes'], (res) => {
          userEnabled = res.enabled !== false;
          if (typeof res.darkness === 'number') darkness = clampDarkness(res.darkness);
          whitelist = Array.isArray(res.whitelist) ? res.whitelist.slice() : [];
          siteModes = res.siteModes && typeof res.siteModes === 'object' ? { ...res.siteModes } : {};
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

  function normalizeMode(mode) {
    return mode === MODE_BETA ? MODE_BETA : MODE_STANDARD;
  }

  function currentSiteMode() {
    return normalizeMode(siteModes[location.hostname]);
  }

  function setStoredSiteMode(host, mode, callback) {
    const targetHost = (host || location.hostname || '').trim();
    if (!targetHost) {
      if (callback) callback({ ok: false, error: 'empty host' });
      return;
    }

    const nextMode = normalizeMode(mode);
    siteModes = { ...siteModes };
    if (nextMode === MODE_BETA) siteModes[targetHost] = MODE_BETA;
    else delete siteModes[targetHost];

    chrome.storage.local.set({ siteModes }, () => {
      evaluate();
      if (callback) callback({ ok: true, siteModes, mode: currentSiteMode() });
    });
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

  function sampleVisibleSurfaces() {
    if (!document.elementFromPoint || !window.innerWidth || !window.innerHeight) {
      return null;
    }

    const bgSamples = [];
    const textSamples = [];
    const xs = [0.12, 0.28, 0.5, 0.72, 0.88];
    const ys = [0.12, 0.26, 0.42, 0.58, 0.74, 0.9];
    const seen = new Set();

    for (const xPct of xs) {
      for (const yPct of ys) {
        const el = document.elementFromPoint(
          Math.max(0, Math.min(window.innerWidth - 1, Math.round(window.innerWidth * xPct))),
          Math.max(0, Math.min(window.innerHeight - 1, Math.round(window.innerHeight * yPct)))
        );
        if (!el || seen.has(el)) continue;
        seen.add(el);

        const bgLum = effectiveBgLuminance(el);
        if (bgLum !== null) bgSamples.push(bgLum);

        const textColor = parseColor(getComputedStyle(el).color);
        if (textColor && textColor.a > 0.35) textSamples.push(relLuminance(textColor));
      }
    }

    if (bgSamples.length === 0) return null;

    const bgAvg = bgSamples.reduce((a, b) => a + b, 0) / bgSamples.length;
    const darkCount = bgSamples.filter((lum) => lum < DARK_THRESHOLD).length;
    const darkRatio = darkCount / bgSamples.length;
    const textLum = textSamples.length
      ? textSamples.reduce((a, b) => a + b, 0) / textSamples.length
      : null;

    return { bgAvg, darkRatio, textLum, count: bgSamples.length };
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
    let isDark = bgIsDark && (textIsLight || textLum === null);

    const visible = sampleVisibleSurfaces();
    if (visible) {
      const visibleTextIsLight = visible.textLum !== null && visible.textLum > LIGHT_TEXT_THRESHOLD;
      if (visible.darkRatio >= VISIBLE_DARK_RATIO && (visibleTextIsLight || visible.textLum === null)) {
        isDark = true;
      }
    }

    return {
      isDark,
      bgLum: visible && isDark ? visible.bgAvg : bgAvg,
      textLum: visible && visible.textLum !== null ? visible.textLum : textLum,
      visibleBgLum: visible ? visible.bgAvg : null,
      visibleDarkRatio: visible ? visible.darkRatio : null,
    };
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
  const MAX_PENDING_THEME_ROOTS = 250;
  // Virtualized apps like Gmail update layout-only inline styles while scrolling.
  const COLOR_RELEVANT_STYLE = /(?:^|;)\s*(?:background(?:-color|-image)?|color|border(?:-(?:top|right|bottom|left))?(?:-color)?|box-shadow|text-shadow|fill|stroke|opacity|filter|--[\w-]*(?:color|bg|background|border|surface|theme|dark|light))\s*:/i;
  const OWN_STYLE_VAR = /(?:^|;)\s*--adm-(?:bg|fg|border)-color\s*:[^;]*/gi;

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

  function clearBetaThemeAttribute() {
    if (document.documentElement) document.documentElement.removeAttribute('data-adm-mode');
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

  function themeSubtree(root, palette) {
    if (!root || root.nodeType !== 1) return;
    themeElement(root, palette);
    if (!root.querySelectorAll) return;

    const all = root.querySelectorAll('*');
    const limit = Math.min(all.length, MAX_THEME_ELEMENTS);
    for (let i = 0; i < limit; i++) themeElement(all[i], palette);
  }

  function themeDocument() {
    const palette = paletteForDarkness(darkness);
    themeElement(document.documentElement, palette);
    if (document.body) themeSubtree(document.body, palette);
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
    clearBetaThemeAttribute();

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

  function buildBetaCss() {
    const t = clamp(darkness / 100, 0, 1);
    const brightness = (0.98 - 0.08 * t).toFixed(2);
    const contrast = (0.92 + 0.08 * t).toFixed(2);
    return `
      :root[data-adm-mode="beta"] {
        color-scheme: dark !important;
        background-color: #ffffff !important;
        filter: invert(1) hue-rotate(180deg) brightness(${brightness}) contrast(${contrast}) !important;
      }
      :root[data-adm-mode="beta"] body {
        background-color: #ffffff !important;
      }
      :root[data-adm-mode="beta"] img,
      :root[data-adm-mode="beta"] video,
      :root[data-adm-mode="beta"] picture,
      :root[data-adm-mode="beta"] canvas,
      :root[data-adm-mode="beta"] iframe,
      :root[data-adm-mode="beta"] embed,
      :root[data-adm-mode="beta"] object,
      :root[data-adm-mode="beta"] svg {
        filter: invert(1) hue-rotate(180deg) brightness(${(1 / Number(brightness)).toFixed(2)}) contrast(${(1 / Number(contrast)).toFixed(2)}) !important;
      }
    `;
  }

  function applyBetaTheme() {
    themeApplied = true;
    isApplyingTheme = true;

    try {
      clearThemeAttributes();
      document.documentElement.setAttribute('data-adm-mode', MODE_BETA);
      const style = ensureThemeStyle();
      style.textContent = buildBetaCss();
      style.disabled = false;
    } finally {
      setTimeout(() => { isApplyingTheme = false; }, 0);
    }
  }

  function detectWithoutGeneratedTheme() {
    const style = document.getElementById(STYLE_ID);
    const wasDisabled = style ? style.disabled : null;
    const oldMode = document.documentElement ? document.documentElement.getAttribute('data-adm-mode') : null;
    if (style) style.disabled = true;
    clearBetaThemeAttribute();

    try {
      return detectIsDark();
    } finally {
      if (style) style.disabled = wasDisabled;
      if (oldMode) document.documentElement.setAttribute('data-adm-mode', oldMode);
    }
  }

  function compactThemeRoots(roots) {
    const compact = [];
    const seen = new Set();

    for (const root of roots) {
      const el = root && (root.nodeType === 1 ? root : root.parentElement);
      if (!el || seen.has(el)) continue;
      if (!document.documentElement.contains(el)) continue;
      if (el === document.documentElement || el === document.body) return null;
      if (compact.some((parent) => parent.contains(el))) continue;

      for (let i = compact.length - 1; i >= 0; i--) {
        if (el.contains(compact[i])) compact.splice(i, 1);
      }

      seen.add(el);
      compact.push(el);
      if (compact.length >= MAX_PENDING_THEME_ROOTS) return null;
    }

    return compact;
  }

  function refreshThemeRoots(roots) {
    if (currentSiteMode() === MODE_BETA) {
      applyBetaTheme();
      return;
    }

    const compact = compactThemeRoots(roots);
    if (!compact) {
      applyTheme();
      return;
    }
    if (compact.length === 0) return;

    themeApplied = true;
    isApplyingTheme = true;

    try {
      const style = ensureThemeStyle();
      style.textContent = buildCss();
      style.disabled = false;

      const palette = paletteForDarkness(darkness);
      compact.forEach((root) => themeSubtree(root, palette));
    } finally {
      setTimeout(() => { isApplyingTheme = false; }, 0);
    }
  }

  function removeTheme() {
    themeApplied = false;
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
    clearBetaThemeAttribute();
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
    if (currentSiteMode() === MODE_BETA) {
      lastResult = null;
      applyBetaTheme();
      return;
    }
    const result = detectWithoutGeneratedTheme();
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

  function mutationElement(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  function isOwnNode(el) {
    return el && (el.id === STYLE_ID || el.id === META_ID);
  }

  function styleMutationLooksColorRelevant(el, oldValue) {
    const current = el && el.getAttribute ? (el.getAttribute('style') || '').replace(OWN_STYLE_VAR, '') : '';
    const previous = (oldValue || '').replace(OWN_STYLE_VAR, '');
    return COLOR_RELEVANT_STYLE.test(current) || COLOR_RELEVANT_STYLE.test(previous);
  }

  function collectMutationWork(mutations) {
    const roots = [];
    let needsFullEvaluate = false;

    for (const mutation of mutations) {
      const target = mutationElement(mutation.target);
      if (isOwnNode(target)) continue;

      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          const el = mutationElement(node);
          if (!el || isOwnNode(el)) return;

          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'style' || tag === 'link') {
            needsFullEvaluate = true;
            return;
          }

          roots.push(el);
        });
        continue;
      }

      if (mutation.type !== 'attributes' || !target) continue;

      if (mutation.attributeName === 'style' && !styleMutationLooksColorRelevant(target, mutation.oldValue)) {
        continue;
      }

      if (target === document.documentElement || target === document.body) {
        needsFullEvaluate = true;
      } else {
        roots.push(target);
      }
    }

    return { needsFullEvaluate, roots };
  }

  function watchForChanges() {
    let scheduled = false;
    let pendingFullEvaluate = false;
    let pendingRoots = [];

    const observer = new MutationObserver((mutations) => {
      if (isApplyingTheme) return;
      if (currentSiteMode() === MODE_BETA) {
        if (
          isActive() &&
          (!document.getElementById(STYLE_ID) ||
            document.documentElement.getAttribute('data-adm-mode') !== MODE_BETA)
        ) {
          applyBetaTheme();
        }
        return;
      }

      const work = collectMutationWork(mutations);
      if (!work.needsFullEvaluate && work.roots.length === 0) return;

      pendingFullEvaluate = pendingFullEvaluate || work.needsFullEvaluate || !themeApplied;
      if (themeApplied && !pendingFullEvaluate) pendingRoots = pendingRoots.concat(work.roots);

      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        const shouldFullEvaluate = pendingFullEvaluate || !themeApplied;
        const roots = pendingRoots;
        pendingFullEvaluate = false;
        pendingRoots = [];

        if (shouldFullEvaluate) evaluate();
        else refreshThemeRoots(roots);
      }, themeApplied ? 120 : 0);
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
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
          siteMode: currentSiteMode(),
          detection: result,
          themeApplied: !!document.getElementById(STYLE_ID),
          betaApplied: document.documentElement.getAttribute('data-adm-mode') === MODE_BETA,
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
        if (currentSiteMode() === MODE_BETA) applyBetaTheme();
        else if (themeApplied || document.getElementById(STYLE_ID)) applyTheme();
        sendResponse({ ok: true, darkness });
        return;
      }

      if (msg.action === 'setSiteMode') {
        setStoredSiteMode(msg.host, msg.mode, sendResponse);
        return true; // async
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
      if (changes.siteModes) siteModes = changes.siteModes.newValue && typeof changes.siteModes.newValue === 'object' ? { ...changes.siteModes.newValue } : {};
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
