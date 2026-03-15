import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const LEGACY_BASELINE_FILE = path.join(REPORTS_DIR, 'latest.json');
const baselineFileFor = (device) => path.join(
  REPORTS_DIR,
  `latest-${(device || 'desktop').toLowerCase()}.json`
);

const cfgPath = path.join(ROOT, 'sites.config.json');
const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
const device = (process.env.LIGHTHOUSE_DEVICE || cfg.device || 'desktop').toLowerCase();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('⚠️  TELEGRAM_* не заданы — отчёт в Telegram отправлен не будет.');
}

const now = new Date();
const runStamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pickMetrics(lhr) {
  const get = (id) => lhr.audits[id]?.numericValue ?? null;
  return {
    FCP: get('first-contentful-paint'), // ms
    LCP: get('largest-contentful-paint'), // ms
    CLS: lhr.audits['cumulative-layout-shift']?.numericValue ?? null, // unitless
    TBT: get('total-blocking-time'), // ms
    Perf: Math.round((lhr.categories?.performance?.score ?? 0) * 100)
  };
}

function median(values) {
  const arr = values.filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((a,b)=>a-b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function fmtMs(v) {
  if (v == null) return '—';
  return v >= 1000 ? (v/1000).toFixed(2) + 's' : Math.round(v) + 'ms';
}
function fmtDelta(curr, prev, unit='ms') {
  if (curr == null || prev == null) return '';
  const d = curr - prev;
  const s = unit === 'ms' ? fmtMs(Math.abs(d)) : Math.abs(d).toFixed(3);
  return d === 0 ? ' (Δ 0)' : (d > 0 ? ` (Δ +${s})` : ` (Δ -${s})`);
}
function passFail(metric, value) {
  if (value == null) return 'unknown';
  const lim = cfg.budgets[metric];
  if (lim == null) return 'unknown';
  return value <= lim ? 'pass' : 'fail';
}

if (!['desktop', 'mobile'].includes(device)) {
  throw new Error(`Unsupported device "${device}". Expected "desktop" or "mobile".`);
}

cfg.device = device;

function urlKey(u) {
  const { hostname, pathname } = new URL(u);
  const raw = `${hostname}${pathname}`;
  const slug = raw.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 7);
  return `${slug}_${hash}`;
}

async function runOne(url, device) {
    const chrome = await launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  try {
    const flags = { port: chrome.port, output: 'json', logLevel: 'error' };
    const config = {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance'],
        formFactor: device === 'mobile' ? 'mobile' : 'desktop',
        screenEmulation: device === 'mobile'
          ? { mobile: true, width: 360, height: 640, deviceScaleFactor: 2.625, disabled: false }
          : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
        throttlingMethod: 'simulate',
        throttling: device === 'mobile'
          ? { rttMs: 150, throughputKbps: 1638, cpuSlowdownMultiplier: 4, requestLatencyMs: 150, downloadThroughputKbps: 1638, uploadThroughputKbps: 750 }
          : { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 40, downloadThroughputKbps: 10240, uploadThroughputKbps: 10240 },
        disableStorageReset: false,
        skipAudits: ['bf-cache'] // шумная метрика
      }
    };
    const { lhr } = await lighthouse(url, flags, config);
    return { lhr, metrics: pickMetrics(lhr) };
  } finally {
    await chrome.kill();
  }
}

async function runMedian(url) {
  const attempts = [];
  for (let i = 0; i < cfg.runs; i++) {
    const r = await runOne(url, device);
    attempts.push(r.metrics);
    await sleep(500);
  }
  return {
    FCP: median(attempts.map(a => a.FCP)),
    LCP: median(attempts.map(a => a.LCP)),
    CLS: median(attempts.map(a => a.CLS)),
    TBT: median(attempts.map(a => a.TBT)),
    Perf: median(attempts.map(a => a.Perf))
  };
}

async function readBaseline() {
  const candidates = [baselineFileFor(device), LEGACY_BASELINE_FILE];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch {
      // keep trying fallbacks
    }
  }
  return { stamp: null, device, results: {} };
}

async function writeCurrent(current) {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const currPath = path.join(REPORTS_DIR, `run-${runStamp}.json`);
  await fs.writeFile(currPath, JSON.stringify(current, null, 2));
  const baselinePath = baselineFileFor(current.device);
  await fs.writeFile(baselinePath, JSON.stringify(current, null, 2)); // обновляем baseline
  return currPath;
}

async function postToTelegram(text, { parseMode = null } = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  // Telegram ограничивает сообщение 4096 символами — чанкуем с запасом
  const parts = text.match(/[\s\S]{1,3800}/g) || [''];
  for (const p of parts) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text: p, disable_web_page_preview: true };
    if (parseMode) payload.parse_mode = parseMode;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error('Telegram error:', res.status, await res.text());
    }
    await sleep(250);
  }
}

function renderTelegram(current, baseline) {
  const lines = [];
  const header = `🚦 Lighthouse Watch — ${new Date().toISOString().replace('T',' ').slice(0,16)} (device: ${cfg.device})`;
  lines.push(header, '');

  for (const url of cfg.urls) {
    const key = urlKey(url);
    const cur = current.results[key];
    const prev = baseline.results[key] || {};
    const m = cur.metrics;

    const fcpPF = passFail('FCP', m.FCP);
    const lcpPF = passFail('LCP', m.LCP);
    const clsPF = passFail('CLS', m.CLS);
    const tbtPF = passFail('TBT', m.TBT);
    const icon = (pf) => pf === 'pass' ? '✅' : (pf === 'fail' ? '❌' : '➖');

    // В Telegram достаточно голого URL — он кликабелен
    lines.push(`${url}  (Perf: ${m.Perf ?? '—'})`);
    lines.push(
      `${icon(fcpPF)} FCP: ${fmtMs(m.FCP)}${fmtDelta(m.FCP, prev.metrics?.FCP, 'ms')}  (<= ${fmtMs(cfg.budgets.FCP)})`,
      `${icon(lcpPF)} LCP: ${fmtMs(m.LCP)}${fmtDelta(m.LCP, prev.metrics?.LCP, 'ms')}  (≤ ${fmtMs(cfg.budgets.LCP)})`,
      `${icon(clsPF)} CLS: ${(m.CLS ?? 0).toFixed(3)}${fmtDelta(m.CLS, prev.metrics?.CLS, 'unit') || ''}  (≤ ${(cfg.budgets.CLS ?? 0).toFixed(2)})`,
      `${icon(tbtPF)} TBT: ${fmtMs(m.TBT)}${fmtDelta(m.TBT, prev.metrics?.TBT, 'ms')}  (≤ ${fmtMs(cfg.budgets.TBT)})`,
      ''
    );
  }
  return lines.join('\n');
}

async function main() {
  const baseline = await readBaseline();

  const results = {};
  for (const url of cfg.urls) {
    console.log('▶︎', url);
    const key = urlKey(url);
    const metrics = await runMedian(url);
    results[key] = { url, metrics };
  }

  const current = { stamp: runStamp, device: cfg.device, results };
  const saved = await writeCurrent(current);

  const msg = renderTelegram(current, baseline);
  console.log('\n' + msg + '\n');
  await postToTelegram(msg /* , { parseMode: 'HTML' } */);

  console.log('Отчёт сохранён в', saved);
}

await main();
