/**
 * Sproutlands — single Railway service that serves BOTH the game (static files in
 * /public) and the save API. Zero npm dependencies: `node server.js`.
 *
 * IMPORTANT (Railway): the default filesystem is EPHEMERAL — data.json is wiped
 * on every redeploy/restart, so saves would vanish. Two fixes:
 *   (a) Quick: add a Railway Volume, mount it at /data, and set env DATA_FILE=/data/data.json
 *   (b) Robust: switch to Railway Postgres (ask me and I'll swap the storage layer).
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || './data.json';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- storage (in-memory + debounced write-through) ----
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* fresh */ }
let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(db), () => {}), 400);
}

const sha = (pass, salt) => crypto.createHash('sha256').update(salt + pass).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const userByToken = (t) => Object.entries(db.users).find(([, u]) => u.token === t)?.[0];
const clean = (s) => String(s || '').slice(0, 24).replace(/[^a-zA-Z0-9_]/g, '');

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

// ---- static file serving (the game) ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'no' }); // traversal guard
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fall back to the game shell for unknown routes
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) =>
        e2 ? (res.writeHead(404), res.end('Not found')) : (res.writeHead(200, { 'Content-Type': 'text/html' }), res.end(idx)));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- server ----
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return sendJSON(res, 204, {});

  // Non-API requests -> serve the game
  if (!p.startsWith('/api/')) return serveStatic(req, res);

  try {
    if (p === '/api/register' && req.method === 'POST') {
      const { user, pass } = await readBody(req);
      const name = clean(user);
      if (!name || !pass) return sendJSON(res, 400, { error: 'username + password required' });
      if (db.users[name]) return sendJSON(res, 409, { error: 'that name is taken' });
      const salt = crypto.randomBytes(8).toString('hex');
      const token = newToken();
      db.users[name] = { salt, hash: sha(pass, salt), token, state: null, level: 1, gold: 105, updated: Date.now() };
      persist();
      return sendJSON(res, 200, { token, user: name });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const { user, pass } = await readBody(req);
      const name = clean(user); const u = db.users[name];
      if (!u || u.hash !== sha(pass, u.salt)) return sendJSON(res, 401, { error: 'wrong name or password' });
      u.token = newToken(); persist();
      return sendJSON(res, 200, { token: u.token, user: name });
    }
    if (p === '/api/save' && req.method === 'POST') {
      const { token, state } = await readBody(req);
      const name = userByToken(token);
      if (!name) return sendJSON(res, 401, { error: 'auth' });
      db.users[name].state = state;
      db.users[name].level = (state && state.level) || 1;
      db.users[name].gold = (state && state.inv && state.inv.gold) || 0;
      db.users[name].updated = Date.now();
      persist();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/load' && req.method === 'GET') {
      const name = userByToken(url.searchParams.get('token'));
      if (!name) return sendJSON(res, 401, { error: 'auth' });
      return sendJSON(res, 200, { state: db.users[name].state, user: name });
    }
    if (p === '/api/neighbors' && req.method === 'GET') {
      const list = Object.entries(db.users).filter(([, u]) => u.state)
        .sort((a, b) => b[1].updated - a[1].updated).slice(0, 30)
        .map(([user, u]) => ({ user, level: u.level, gold: u.gold }));
      return sendJSON(res, 200, list);
    }
    if (p === '/api/farm' && req.method === 'GET') {
      const u = db.users[clean(url.searchParams.get('user'))];
      if (!u || !u.state) return sendJSON(res, 404, { error: 'no farm' });
      return sendJSON(res, 200, { state: u.state });
    }
    if (p === '/api/leaderboard' && req.method === 'GET') {
      const list = Object.entries(db.users).map(([user, u]) => ({ user, level: u.level, gold: u.gold }))
        .sort((a, b) => b.level - a.level || b.gold - a.gold).slice(0, 20);
      return sendJSON(res, 200, list);
    }
    sendJSON(res, 404, { error: 'not found' });
  } catch { sendJSON(res, 500, { error: 'server error' }); }
}).listen(PORT, () => console.log('Sproutlands live on :' + PORT));
