// Launch Chrome (new headless) with the extension loaded, then drive it via
// CDP: navigate, wait for the extension's content script to inject its
// <style> tag (or for the page to be classified as already dark), and
// finally capture a viewport screenshot. Plain Node — uses globalThis.fetch
// and globalThis.WebSocket from Node 22+.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = '/Users/dongthach/dark-mode-extension';
const OUT_DIR = '/Users/dongthach/dark-mode-extension/store-assets/demo';
const PORT = 9222;

const SITES = [
  ['01_wikipedia',  'https://en.wikipedia.org/wiki/Dark_mode'],
  ['02_hackernews', 'https://news.ycombinator.com/'],
  ['03_example',    'https://example.com/'],
  ['04_iana',       'https://www.iana.org/'],
  ['05_gnu',        'https://www.gnu.org/philosophy/free-sw.html'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCDP() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return r.json();
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('CDP did not come up');
}

function newClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const eventHandlers = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method && eventHandlers.has(msg.method)) {
      for (const fn of eventHandlers.get(msg.method)) fn(msg.params);
    }
  });

  return new Promise((resolve) => {
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, fn) {
          if (!eventHandlers.has(method)) eventHandlers.set(method, []);
          eventHandlers.get(method).push(fn);
        },
        once(method) {
          return new Promise((res) => {
            const fn = (params) => {
              const arr = eventHandlers.get(method) || [];
              const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
              res(params);
            };
            this.on(method, fn);
          });
        },
        close() { ws.close(); },
      });
    });
  });
}

async function captureSite(client, name, url) {
  await client.send('Page.enable');
  const loadFired = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url });
  await Promise.race([loadFired, sleep(20000)]);
  // Settle for any deferred network/JS.
  await sleep(1500);

  // Run the SAME detection + apply logic as content.js, against this page.
  // Headless Chrome doesn't reliably run extension content scripts, so we
  // invoke the extension's behavior via CDP instead. Visually identical.
  const r = await client.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      function parseColor(s) { const m = s && s.match(/[\\d.]+/g); if (!m || m.length < 3) return null; const [r,g,b] = m.slice(0,3).map(Number); return { r, g, b, a: m.length >= 4 ? +m[3] : 1 }; }
      function lum({r,g,b}) { return (0.299*r + 0.587*g + 0.114*b) / 255; }
      function effBg(el) { while (el) { const c = parseColor(getComputedStyle(el).backgroundColor); if (c && c.a > 0.5) return lum(c); el = el.parentElement; } return null; }
      const samples = [];
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        const c = parseColor(getComputedStyle(el).backgroundColor);
        if (c && c.a > 0.5) samples.push(lum(c));
      }
      for (const sel of ['main','article','[role="main"]','#content','.content','#root','#app']) {
        const el = document.querySelector(sel);
        if (el) { const v = effBg(el); if (v !== null) samples.push(v); }
      }
      const bgAvg = samples.length ? samples.reduce((a,b)=>a+b,0)/samples.length : null;
      const tc = document.body ? parseColor(getComputedStyle(document.body).color) : null;
      const textLum = tc ? lum(tc) : null;
      const isDark = bgAvg !== null && bgAvg < 0.32 && (textLum === null || textLum > 0.55);
      let applied = false;
      if (!isDark) {
        const STYLE_ID = '__auto_dark_mode_styles__';
        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          // darkness=100 → invert(1.0) — pure dark, matches extension default
          style.textContent = 'html { filter: invert(1) hue-rotate(180deg) !important; background-color: #fff !important; } img, video, picture, iframe, canvas, svg, embed, object, [style*="background-image"], [style*="background:url"], [style*="background: url"] { filter: invert(1) hue-rotate(180deg) !important; }';
          document.head.appendChild(style);
          applied = true;
        }
      }
      return JSON.stringify({ bgAvg, textLum, isDark, applied });
    })()`,
  });
  const detection = JSON.parse(r.result.value);
  // Allow paint after CSS injection.
  await sleep(500);

  // Hide horizontal scrollbars some sites still draw.
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 2, mobile: false,
  });

  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const out = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`✓ ${name}  (bgLum=${(detection.bgAvg||0).toFixed(2)}, textLum=${detection.textLum===null?'-':detection.textLum.toFixed(2)}, isDark=${detection.isDark}, applied=${detection.applied})  → ${out}`);
  await client.send('Emulation.clearDeviceMetricsOverride');
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-prof-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stderr.on('data', (d) => process.stderr.write(d.toString().split('\n').slice(-3).join('\n')));

  try {
    await waitForCDP();
    console.log('CDP ready on port', PORT);

    // Get the about:blank target's WS URL.
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const tgt = list.find((t) => t.type === 'page');
    const client = await newClient(tgt.webSocketDebuggerUrl);

    for (const [name, url] of SITES) {
      try {
        await captureSite(client, name, url);
      } catch (e) {
        console.error(`✗ ${name} failed:`, e.message);
      }
    }
    client.close();
  } finally {
    child.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
