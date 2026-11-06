'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@libsql/client');

const PORT = Number(process.env.PORT) || 3000;
const TIME_ZONE = 'America/Sao_Paulo';
const SESSION_DAYS = 30;
const CLIENT_TYPES = ['obra', 'projeto', 'regularizacao', 'contabil_juridico'];

function localDatabaseUrl() {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return pathToFileURL(path.join(dir, 'escritorio.db')).href;
}

// Online os dados ficam no Turso; sem DATABASE_URL, em um arquivo local.
const db = createClient({
  url: process.env.DATABASE_URL || localDatabaseUrl(),
  authToken: process.env.DATABASE_TOKEN || undefined,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'membro'
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, phone TEXT DEFAULT '',
    email TEXT DEFAULT '', notes TEXT DEFAULT '', portal_token TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, details TEXT DEFAULT '', due_date TEXT,
    notify_days INTEGER NOT NULL DEFAULT 3, owner_id INTEGER,
    done INTEGER NOT NULL DEFAULT 0, done_at TEXT, visible_to_client INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS seen (
    user_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
    due_date TEXT NOT NULL, PRIMARY KEY (user_id, item_id, due_date)
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL UNIQUE, summary TEXT DEFAULT '',
    next_date TEXT, closed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS client_notes (
    id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, meeting_id INTEGER,
    author TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings (key, value) VALUES ('review_weekday', '1');
`;

async function execute(sql, args) {
  const result = await db.execute({ sql, args });
  const rows = result.rows.map((row) => Object.fromEntries(result.columns.map((column) => [column, row[column]])));
  return { rows, lastId: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid) };
}
const q = (sql) => ({
  get: async (...args) => (await execute(sql, args)).rows[0],
  all: async (...args) => (await execute(sql, args)).rows,
  run: async (...args) => ({ lastId: (await execute(sql, args)).lastId }),
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}
function daysUntil(date) {
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function text(value, field, { required = false, max = 2000 } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new HttpError(400, `Preencha: ${field}.`);
  if (result.length > max) throw new HttpError(400, `Texto muito longo: ${field}.`);
  return result;
}
function dateOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, 'Data inválida.');
  }
  return value;
}
function validPassword(value) {
  const password = String(value ?? '');
  if (password.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
  return password;
}
async function find(table, id) {
  const row = await q(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
  if (!row) throw new HttpError(404, 'Registro não encontrado.');
  return row;
}

// ---------- sessão ----------
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
}
async function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  return (await q(`SELECT u.id, u.name, u.login, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token = ? AND s.expires_at > ?`).get(sha256(token), Date.now())) || null;
}
async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 86400;
  await q('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  await q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + maxAge * 1000);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

const loginAttempts = new Map();
function assertLoginAllowed(login) {
  const entry = loginAttempts.get(login);
  if (entry && entry.count >= 8 && entry.until > Date.now()) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde 10 minutos.');
  }
}
function recordLoginFailure(login) {
  const entry = loginAttempts.get(login);
  const count = entry && entry.until > Date.now() ? entry.count + 1 : 1;
  loginAttempts.set(login, { count, until: Date.now() + 600000 });
}

// ---------- regras de aviso ----------
function alertLevel(item) {
  if (item.done || !item.due_date) return null;
  const days = daysUntil(item.due_date);
  if (days < 0) return 'atrasado';
  if (days === 0) return 'hoje';
  return days <= item.notify_days ? 'proximo' : null;
}

async function bootstrap(me) {
  const [clients, seenRows, itemRows, users, notes, meetings, weekday] = await Promise.all([
    q('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all(),
    q('SELECT item_id, due_date FROM seen WHERE user_id = ?').all(me.id),
    q('SELECT * FROM items ORDER BY done, due_date IS NULL, due_date').all(),
    q('SELECT id, name, login, role FROM users ORDER BY name COLLATE NOCASE').all(),
    q('SELECT * FROM client_notes ORDER BY date DESC, id DESC').all(),
    q('SELECT * FROM meetings ORDER BY date DESC').all(),
    q("SELECT value FROM settings WHERE key = 'review_weekday'").get(),
  ]);
  const seen = new Set(seenRows.map((row) => `${row.item_id}|${row.due_date}`));
  const items = itemRows.map((item) => ({
    ...item,
    level: alertLevel(item),
    days_left: item.due_date ? daysUntil(item.due_date) : null,
    seen: seen.has(`${item.id}|${item.due_date}`),
  }));
  return {
    me, today: today(), users, clients, items, notes, meetings,
    settings: { review_weekday: Number(weekday.value) },
  };
}

async function itemFields(body, current = {}) {
  const merged = { ...current, ...body };
  const kind = merged.kind === 'documento' ? 'documento' : 'atividade';
  const notifyDays = Number(merged.notify_days ?? 3);
  if (!Number.isInteger(notifyDays) || notifyDays < 0 || notifyDays > 90) {
    throw new HttpError(400, 'Antecedência do aviso inválida.');
  }
  const clientId = (await find('clients', merged.client_id)).id;
  const ownerId = merged.owner_id ? (await find('users', merged.owner_id)).id : null;
  const done = merged.done ? 1 : 0;
  return {
    client_id: clientId, kind, title: text(merged.title, 'título', { required: true, max: 200 }),
    details: text(merged.details, 'detalhes'), due_date: dateOrNull(merged.due_date),
    notify_days: notifyDays, owner_id: ownerId, done,
    done_at: done ? (current.done ? current.done_at : today()) : null,
    visible_to_client: merged.visible_to_client ? 1 : 0,
  };
}
function clientFields(body) {
  if (!CLIENT_TYPES.includes(body.type)) throw new HttpError(400, 'Tipo de cliente inválido.');
  return {
    name: text(body.name, 'nome', { required: true, max: 200 }), type: body.type,
    phone: text(body.phone, 'telefone', { max: 40 }), email: text(body.email, 'e-mail', { max: 200 }),
    notes: text(body.notes, 'observações'), active: body.active === false ? 0 : 1,
  };
}

// ---------- rotas ----------
const routes = [];
function route(method, pattern, handler, { auth = 'user' } = {}) {
  const regex = new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`);
  routes.push({ method, regex, handler, auth });
}
const hasUsers = async () => !!(await q('SELECT 1 AS ok FROM users LIMIT 1').get());

route('GET', '/api/status', async ({ req }) => ({
  needsSetup: !(await hasUsers()),
  me: await currentUser(req),
}), { auth: 'public' });

route('POST', '/api/setup', async ({ req, res, body }) => {
  if (await hasUsers()) throw new HttpError(403, 'O sistema já foi configurado.');
  const result = await q("INSERT INTO users (name, login, password, role) VALUES (?, ?, ?, 'admin')").run(
    text(body.name, 'nome', { required: true, max: 100 }),
    text(body.login, 'login', { required: true, max: 100 }),
    hashPassword(validPassword(body.password)),
  );
  await startSession(req, res, result.lastId);
  return { ok: true };
}, { auth: 'public' });

route('POST', '/api/login', async ({ req, res, body }) => {
  const login = String(body.login ?? '').trim().toLowerCase();
  assertLoginAllowed(login);
  const user = await q('SELECT * FROM users WHERE login = ?').get(login);
  if (!user || !checkPassword(String(body.password ?? ''), user.password)) {
    recordLoginFailure(login);
    throw new HttpError(401, 'Login ou senha incorretos.');
  }
  loginAttempts.delete(login);
  await startSession(req, res, user.id);
  return { ok: true };
}, { auth: 'public' });

route('POST', '/api/logout', async ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) await q('DELETE FROM sessions WHERE token = ?').run(sha256(token));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/bootstrap', ({ me }) => bootstrap(me));

route('POST', '/api/clients', async ({ body }) => {
  const c = clientFields(body);
  const result = await q(`INSERT INTO clients (name, type, phone, email, notes, active, portal_token)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(c.name, c.type, c.phone, c.email, c.notes, c.active, crypto.randomBytes(24).toString('hex'));
  return { id: result.lastId };
});
route('PUT', '/api/clients/:id', async ({ params, body }) => {
  const current = await find('clients', params[0]);
  const c = clientFields({ ...current, ...body, active: (body.active ?? !!current.active) });
  await q('UPDATE clients SET name=?, type=?, phone=?, email=?, notes=?, active=? WHERE id=?')
    .run(c.name, c.type, c.phone, c.email, c.notes, c.active, current.id);
  return { ok: true };
});
route('DELETE', '/api/clients/:id', async ({ params }) => {
  const { id } = await find('clients', params[0]);
  await db.batch([
    { sql: 'DELETE FROM seen WHERE item_id IN (SELECT id FROM items WHERE client_id = ?)', args: [id] },
    { sql: 'DELETE FROM items WHERE client_id = ?', args: [id] },
    { sql: 'DELETE FROM client_notes WHERE client_id = ?', args: [id] },
    { sql: 'DELETE FROM clients WHERE id = ?', args: [id] },
  ], 'write');
  return { ok: true };
});
route('POST', '/api/clients/:id/new-link', async ({ params }) => {
  const { id } = await find('clients', params[0]);
  await q('UPDATE clients SET portal_token = ? WHERE id = ?').run(crypto.randomBytes(24).toString('hex'), id);
  return { ok: true };
});

route('POST', '/api/items', async ({ body }) => {
  const i = await itemFields(body);
  const result = await q(`INSERT INTO items (client_id, kind, title, details, due_date, notify_days,
                          owner_id, done, done_at, visible_to_client) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(i.client_id, i.kind, i.title, i.details, i.due_date, i.notify_days,
      i.owner_id, i.done, i.done_at, i.visible_to_client);
  return { id: result.lastId };
});
route('PUT', '/api/items/:id', async ({ params, body }) => {
  const current = await find('items', params[0]);
  const i = await itemFields(body, current);
  await q(`UPDATE items SET client_id=?, kind=?, title=?, details=?, due_date=?, notify_days=?,
           owner_id=?, done=?, done_at=?, visible_to_client=? WHERE id=?`)
    .run(i.client_id, i.kind, i.title, i.details, i.due_date, i.notify_days,
      i.owner_id, i.done, i.done_at, i.visible_to_client, current.id);
  return { ok: true };
});
route('DELETE', '/api/items/:id', async ({ params }) => {
  const { id } = await find('items', params[0]);
  await db.batch([
    { sql: 'DELETE FROM seen WHERE item_id = ?', args: [id] },
    { sql: 'DELETE FROM items WHERE id = ?', args: [id] },
  ], 'write');
  return { ok: true };
});
route('POST', '/api/items/:id/seen', async ({ me, params }) => {
  const item = await find('items', params[0]);
  if (item.due_date) {
    await q('INSERT OR IGNORE INTO seen (user_id, item_id, due_date) VALUES (?, ?, ?)').run(me.id, item.id, item.due_date);
  }
  return { ok: true };
});

route('POST', '/api/meetings', async ({ body }) => {
  const date = dateOrNull(body.date) || today();
  await q('INSERT OR IGNORE INTO meetings (date) VALUES (?)').run(date);
  await q('UPDATE meetings SET closed = 0 WHERE date = ?').run(date);
  return q('SELECT * FROM meetings WHERE date = ?').get(date);
});
route('PUT', '/api/meetings/:id', async ({ params, body }) => {
  const current = await find('meetings', params[0]);
  await q('UPDATE meetings SET summary=?, next_date=?, closed=? WHERE id=?').run(
    text(body.summary ?? current.summary, 'resumo', { max: 10000 }),
    dateOrNull(body.next_date !== undefined ? body.next_date : current.next_date),
    (body.closed ?? current.closed) ? 1 : 0,
    current.id,
  );
  return { ok: true };
});
route('POST', '/api/notes', async ({ me, body }) => {
  const clientId = (await find('clients', body.client_id)).id;
  const meetingId = body.meeting_id ? (await find('meetings', body.meeting_id)).id : null;
  await q('INSERT INTO client_notes (client_id, meeting_id, author, text, date) VALUES (?,?,?,?,?)')
    .run(clientId, meetingId, me.name, text(body.text, 'anotação', { required: true, max: 5000 }), today());
  return { ok: true };
});

route('POST', '/api/users', async ({ body }) => {
  const login = text(body.login, 'login', { required: true, max: 100 });
  if (await q('SELECT 1 AS ok FROM users WHERE login = ?').get(login)) throw new HttpError(409, 'Esse login já existe.');
  const result = await q('INSERT INTO users (name, login, password, role) VALUES (?, ?, ?, ?)').run(
    text(body.name, 'nome', { required: true, max: 100 }), login,
    hashPassword(validPassword(body.password)), body.role === 'admin' ? 'admin' : 'membro',
  );
  return { id: result.lastId };
}, { auth: 'admin' });
route('PUT', '/api/users/:id/password', async ({ params, body }) => {
  const user = await find('users', params[0]);
  await q('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(validPassword(body.password)), user.id);
  await q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return { ok: true };
}, { auth: 'admin' });
route('DELETE', '/api/users/:id', async ({ me, params }) => {
  const user = await find('users', params[0]);
  if (user.id === me.id) throw new HttpError(400, 'Você não pode remover o próprio usuário.');
  await db.batch([
    { sql: 'UPDATE items SET owner_id = NULL WHERE owner_id = ?', args: [user.id] },
    { sql: 'DELETE FROM seen WHERE user_id = ?', args: [user.id] },
    { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [user.id] },
    { sql: 'DELETE FROM users WHERE id = ?', args: [user.id] },
  ], 'write');
  return { ok: true };
}, { auth: 'admin' });
route('PUT', '/api/settings', async ({ body }) => {
  const weekday = Number(body.review_weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new HttpError(400, 'Dia inválido.');
  await q("UPDATE settings SET value = ? WHERE key = 'review_weekday'").run(String(weekday));
  return { ok: true };
}, { auth: 'admin' });

route('GET', '/api/portal/:token', async ({ params }) => {
  const client = await q('SELECT id, name, type FROM clients WHERE portal_token = ? AND active = 1').get(params[0]);
  if (!client) throw new HttpError(404, 'Link inválido ou desativado.');
  const visible = await q(`SELECT kind, title, details, due_date, notify_days, done, done_at FROM items
                           WHERE client_id = ? AND visible_to_client = 1
                           ORDER BY done, due_date IS NULL, due_date`).all(client.id);
  const pending = visible.filter((item) => !item.done).map(({ done, done_at, notify_days, ...item }) => ({
    ...item, level: alertLevel({ due_date: item.due_date, done: 0, notify_days }),
  }));
  const completed = visible.filter((item) => item.done).slice(-10)
    .map(({ kind, title, done_at }) => ({ kind, title, done_at }));
  return { client: { name: client.name, type: client.type }, pending, completed };
}, { auth: 'public' });

// ---------- HTTP ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/portal.js': ['portal.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function sendFile(res, file, type) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) { reject(new HttpError(413, 'Conteúdo muito grande.')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'Conteúdo inválido.')); }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

  if (req.method === 'GET' && STATIC[pathname]) return sendFile(res, ...STATIC[pathname]);
  if (req.method === 'GET' && /^\/c\/[a-f0-9]+$/.test(pathname)) {
    res.setHeader('X-Robots-Tag', 'noindex');
    return sendFile(res, 'portal.html', 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/health') return sendJson(res, 200, { ok: true });
  if (!pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Página não encontrada.' });

  for (const r of routes) {
    const match = r.method === req.method && pathname.match(r.regex);
    if (!match) continue;
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Formato não aceito.');
    }
    const me = await currentUser(req);
    if (r.auth !== 'public' && !me) throw new HttpError(401, 'Entre novamente.');
    if (r.auth === 'admin' && me.role !== 'admin') throw new HttpError(403, 'Apenas administradores.');
    const body = req.method === 'GET' ? {} : await readBody(req);
    return sendJson(res, 200, await r.handler({ req, res, me, body, params: match.slice(1) }));
  }
  throw new HttpError(404, 'Rota não encontrada.');
}

async function main() {
  await db.executeMultiple(SCHEMA);
  http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!(error instanceof HttpError)) console.error(error);
      if (!res.headersSent) {
        sendJson(res, error.status || 500, { error: error instanceof HttpError ? error.message : 'Erro interno.' });
      } else res.end();
    });
  }).listen(PORT, () => console.log(`Aplicativo em http://localhost:${PORT}`));
}

main().catch((error) => {
  console.error('Não foi possível iniciar:', error);
  process.exit(1);
});
