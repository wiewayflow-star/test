// Музыкальный сервис: русская музыка — hitmos → YouTube, зарубежная — YouTube Music → YouTube.
// Запуск: node server.js   (нужны Node 18+ и yt-dlp в PATH)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const HITMOS = process.env.HITMOS_BASE || 'https://rus.hitmotop.com';
const HM_ROOT = new URL(HITMOS).hostname.split('.').slice(-2).join('.');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Цензурные версии уходят вниз выдачи
const CENSORED = /\b(clean|censored|cenzored|radio edit|sanitized)\b|без мата|цензур/i;

const ytdlp = (args) => new Promise((resolve, reject) =>
  execFile('yt-dlp', args, { maxBuffer: 32e6, timeout: 40000 }, (err, out) => (err ? reject(err) : resolve(out))));

const decode = (s = '') => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const strip = (s = '') => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const toSec = (v) => {
  if (typeof v === 'number') return v;
  const p = String(v || '').split(':').map(Number);
  return p.some(isNaN) ? 0 : p.reduce((a, n) => a * 60 + n, 0);
};

// ---------- Поиск ----------
async function hitmosSearch(q) {
  const r = await fetch(`${HITMOS}/search?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA, Referer: HITMOS + '/' } });
  if (!r.ok) throw new Error('hitmos ' + r.status);
  const html = await r.text();
  const out = [];
  for (const item of html.split(/<li[^>]+class="[^"]*tracks__item/).slice(1)) {
    let d = {};
    const m = item.match(/data-musicdata=(["'])([\s\S]*?)\1/);
    if (m) { try { d = JSON.parse(decode(m[2])); } catch {} }
    const mp3 = d.url || (item.match(/href="([^"]+\.mp3[^"]*)"/) || [])[1];
    if (!mp3) continue;
    out.push({
      src: 'hm',
      url: new URL(mp3, HITMOS).href,
      title: d.title || strip((item.match(/track__title[^>]*>([\s\S]*?)<\/div>/) || [])[1]),
      artist: d.artist || strip((item.match(/track__desc[^>]*>([\s\S]*?)<\/div>/) || [])[1]),
      duration: toSec(d.duration || strip((item.match(/track__fulltime[^>]*>([\s\S]*?)<\/div>/) || [])[1])),
      cover: d.img ? new URL(d.img, HITMOS).href : null,
    });
  }
  return out.slice(0, 25);
}

async function ytSearch(q, music) {
  const target = music
    ? `https://music.youtube.com/search?q=${encodeURIComponent(q)}&sp=EgWKAQIIAWoMEA4QChADEAQQCRAF`
    : `ytsearch15:${q}`;
  const data = JSON.parse(await ytdlp(['--flat-playlist', '-J', '--no-warnings', target]));
  const all = (data.entries || [])
    .filter((e) => e && /^[\w-]{11}$/.test(e.id || ''))
    .map((e) => ({
      src: music ? 'ytm' : 'yt',
      id: e.id,
      title: e.title || '',
      artist: (e.uploader || e.channel || '').replace(/ - Topic$/, ''),
      duration: e.duration || 0,
      cover: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    }));
  const clean = all.filter((t) => !CENSORED.test(t.title));
  return (clean.length ? clean.concat(all.filter((t) => !clean.includes(t))) : all).slice(0, 25);
}

async function search(q, only) {
  const russian = /[а-яё]/i.test(q);
  const chain = only === 'yt' ? [() => ytSearch(q, false)]
    : russian ? [() => hitmosSearch(q), () => ytSearch(q, false)]
    : [() => ytSearch(q, true), () => ytSearch(q, false)];
  for (const step of chain) {
    try {
      const res = await step();
      if (res.length) return res;
    } catch (e) { console.error('search:', e.message); }
  }
  return [];
}

// ---------- Аудио ----------
const urlCache = new Map();
async function ytAudioUrl(id) {
  const hit = urlCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.url;
  const out = await ytdlp(['-f', 'bestaudio[ext=m4a]/bestaudio', '-g', '--no-playlist', '--no-warnings', `https://www.youtube.com/watch?v=${id}`]);
  const url = out.trim().split('\n')[0];
  urlCache.set(id, { url, exp: Date.now() + 3600e3 });
  return url;
}

async function pipe(req, res, url, extra = {}) {
  const headers = { 'User-Agent': UA, ...extra };
  if (req.headers.range) headers.Range = req.headers.range;
  const up = await fetch(url, { headers, redirect: 'follow' });
  const h = { 'Accept-Ranges': 'bytes', 'Content-Type': up.headers.get('content-type') || 'audio/mpeg' };
  for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) h[k] = up.headers.get(k);
  res.writeHead(up.status, h);
  if (!up.body) return res.end();
  const stream = Readable.fromWeb(up.body);
  req.on('close', () => stream.destroy());
  stream.on('error', () => res.end());
  stream.pipe(res);
}

// ---------- HTTP ----------
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim();
      const results = q ? await search(q, u.searchParams.get('only')) : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(results));
    }
    if (u.pathname === '/api/stream') {
      const id = u.searchParams.get('yt');
      if (id) {
        if (!/^[\w-]{11}$/.test(id)) throw new Error('bad id');
        return await pipe(req, res, await ytAudioUrl(id));
      }
      const target = new URL(u.searchParams.get('hm') || '');
      if (!target.hostname.endsWith(HM_ROOT)) throw new Error('forbidden host');
      return await pipe(req, res, target.href, { Referer: HITMOS + '/' });
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error(u.pathname, e.message);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
