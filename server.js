'use strict';
/**
 * 客户数据信息统计驾驶舱 —— REST 服务（含登录与权限，存储可插拔）
 *
 * 数据持久化由 storage.js 适配器决定，业务代码不关心后端：
 *   - local 模式（默认，零外部依赖）：public/data/customers.json、public/config/fields.json、data/users.json
 *   - cloud 模式（可选）：WorkBuddy Cloud Database 的 cid_state 表（customers / fields / users 三个键）
 * 切换方式：data/storage.json 的 driver，或环境变量 STORAGE_DRIVER=local|cloud。
 * 会话密钥：data/.session-secret（首次启动自动生成，仅用于本应用自有会话签名）
 *
 * 权限在服务端生效：
 *   1) 数据范围：员工可限制为「仅本人跟单」
 *   2) 字段级：接口返回的数据先剔除无权限字段，统计/导出/筛选同样受限
 *   3) 功能级：导出、增删改、字段管理、用户管理分别授权
 * 字段元数据驱动：新增字段只需改 fields.json，业务接口自动支持。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./storage');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(PUBLIC_DIR, 'data', 'customers.json');
const FIELDS_FILE = path.join(PUBLIC_DIR, 'config', 'fields.json');
const PRIVATE_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(PRIVATE_DIR, 'users.json');
const SECRET_FILE = path.join(PRIVATE_DIR, '.session-secret');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 小时
const COOKIE_NAME = 'cid_session';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8'
};

const SYSTEM_KEYS = ['id', 'createdAt', 'updatedAt'];
const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'date', 'datetime', 'tags'];
const PERM_KEYS = ['canExport', 'canCreate', 'canEdit', 'canDelete', 'canManageFields', 'canManageUsers'];
const BUCKETS = [
  [0, 50000, '0-5万'],
  [50000, 100000, '5-10万'],
  [100000, 300000, '10-30万'],
  [300000, 500000, '30-50万'],
  [500000, Infinity, '50万+']
];
const loginFails = new Map(); // 简易登录失败限流（内存级）

/* ============================== 基础工具 ============================== */

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[read]', file, err.message);
    return fallback;
  }
}

/** 临时文件 + rename，避免写一半时把数据文件损坏 */
function writeJSON(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: mode || 0o666 });
  fs.renameSync(tmp, file);
}

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
    ...extraHeaders
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  const limit = maxBytes || MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.status = status;
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(413, `请求体超过 ${Math.round(limit / 1024 / 1024)}MB 限制`);
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', () => fail(400, '请求读取失败'));
  });
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/* ============================== 认证与安全 ============================== */

function getSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s) return s;
  } catch (e) { /* 首次启动，下面生成 */ }
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(pw, stored) {
  try {
    const [alg, salt, hex] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !salt || !hex) return false;
    const a = Buffer.from(hex, 'hex');
    const b = crypto.scryptSync(String(pw), salt, a.length);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/**
 * 判断是否处于 HTTPS（兼容云端反向代理）。
 * 云端部署时浏览器到反代是 HTTPS、反代到 Node 是 HTTP，
 * 需读取 x-forwarded-proto 才能正确给 Cookie 加 Secure，否则登录态会被浏览器丢弃。
 */
function isSecureRequest(req) {
  if (process.env.COOKIE_SECURE) return true;
  const fwd = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (fwd.split(',')[0].trim() === 'https') return true;
  if (req.socket && req.socket.encrypted) return true;
  return false;
}

/**
 * 是否来自公网域名。本地 localhost / 局域网 IP 视为非公网，便于开发调试；
 * 云端发布域名（含反代 x-forwarded-host）视为公网，启用更严格的安全闸门。
 */
function isPublicRequest(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const host = raw.split(':')[0].toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

function cookieFlags(req) {
  return '; Path=/; HttpOnly; SameSite=Lax' + (isSecureRequest(req) ? '; Secure' : '');
}

function setSessionCookie(req, res, user, weak) {
  const token = signToken({ uid: user.id, ver: user.tokenVersion || 1, exp: Date.now() + SESSION_TTL, weak: !!weak });
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}${cookieFlags(req)}; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=;${cookieFlags(req)}; Max-Age=0`);
}

function authenticate(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const payload = verifyToken(token);
  if (!payload) return null;
  const data = getUsers();
  if (!data) return null;
  const user = data.users.find((u) => u.id === payload.uid);
  if (!user || !user.enabled) return null;
  if ((user.tokenVersion || 1) !== (payload.ver || 1)) return null;
  return user;
}

/** 当前会话是否仍在使用公网下必须更换的初始弱密码 */
function isWeakSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const payload = verifyToken(token);
  return !!(payload && payload.weak && isPublicRequest(req));
}

function tooManyFails(key) {
  const r = loginFails.get(key);
  return !!(r && r.count >= 5 && Date.now() - r.at < 60000);
}
function recordFail(key) {
  const r = loginFails.get(key) || { count: 0, at: 0 };
  r.count++; r.at = Date.now();
  loginFails.set(key, r);
}
function clearFails(key) { loginFails.delete(key); }

/* ============================== 权限模型 ============================== */

function defaultPermissions(role) {
  if (role === 'admin') {
    return {
      fields: ['*'], scope: 'all', canExport: true, canCreate: true, canEdit: true,
      canDelete: true, canManageFields: true, canManageUsers: true
    };
  }
  return {
    fields: [], scope: 'own', canExport: false, canCreate: false, canEdit: true,
    canDelete: false, canManageFields: false, canManageUsers: false
  };
}

function normalizePermissions(p) {
  p = p || {};
  const out = { fields: Array.isArray(p.fields) ? p.fields.map(String) : [], scope: p.scope === 'own' ? 'own' : 'all' };
  PERM_KEYS.forEach((k) => { out[k] = !!p[k]; });
  return out;
}

/** 管理员永远拥有全部权限，不依赖文件里的 permissions 字段 */
function effectivePermissions(user) {
  return user.role === 'admin' ? defaultPermissions('admin') : normalizePermissions(user.permissions);
}

function can(user, key) {
  if (user.role === 'admin') return true;
  return !!effectivePermissions(user)[key];
}

function requirePerm(user, key) {
  if (!can(user, key)) throw httpError(403, '当前账号没有此操作权限');
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, displayName: u.displayName || u.username,
    role: u.role, ownerName: u.ownerName || '', enabled: !!u.enabled,
    lastLogin: u.lastLogin || '', createdAt: u.createdAt || '',
    permissions: effectivePermissions(u)
  };
}

function visibleFieldKeys(user, cfg) {
  const keys = cfg.fields.map((f) => f.key);
  if (user.role === 'admin') return keys;
  const p = effectivePermissions(user);
  return p.fields.includes('*') ? keys : keys.filter((k) => p.fields.includes(k));
}

function visibleFields(user, cfg) {
  const keys = visibleFieldKeys(user, cfg);
  return cfg.fields.filter((f) => keys.includes(f.key));
}

/** 数据范围：员工可限定为「仅本人跟单」；未配置跟单人时默认看不到任何数据 */
function scopedRows(user, rows) {
  if (user.role === 'admin') return rows;
  const p = effectivePermissions(user);
  if (p.scope === 'own') {
    const owner = String(user.ownerName || '').trim();
    return owner ? rows.filter((r) => String(r.owner || '') === owner) : [];
  }
  return rows;
}

/** 字段级脱敏：只保留被授权的字段（系统 id 保留用于定位记录） */
function maskRow(row, keys) {
  const out = {};
  SYSTEM_KEYS.forEach((k) => { out[k] = row[k]; });
  keys.forEach((k) => { out[k] = row[k]; });
  return out;
}

function inScope(user, row) {
  return scopedRows(user, [row]).length > 0;
}

/** 防止被授权「用户管理」的员工给自己提权：权限只能是自身权限的子集 */
function sanitizePermissions(requested, grantor, cfg) {
  const p = normalizePermissions(requested);
  const mine = effectivePermissions(grantor);
  const validKeys = cfg.fields.map((f) => f.key);
  if (grantor.role !== 'admin') {
    p.fields = p.fields.includes('*')
      ? (mine.fields.includes('*') ? validKeys.slice() : mine.fields.filter((k) => validKeys.includes(k)))
      : p.fields.filter((k) => validKeys.includes(k) && (mine.fields.includes('*') || mine.fields.includes(k)));
    if (p.scope === 'all' && mine.scope !== 'all') p.scope = 'own';
    PERM_KEYS.forEach((k) => { p[k] = p[k] && !!mine[k]; });
  } else {
    p.fields = p.fields.includes('*') ? ['*'] : p.fields.filter((k) => validKeys.includes(k));
  }
  return p;
}

/* ============================== 数据访问层 ============================== */

/* 所有业务数据统一来自存储适配器；写操作实时回写当前后端（本地文件 / 云数据库）。 */
function getConfig() { return store.getConfig(); }
function getCustomers() { return store.getCustomers(); }
function getUsers() { return store.getUsers(); }

async function saveCustomers(list) { await store.saveCustomers(list); }
async function saveConfig(cfg) { await store.saveConfig(cfg); }
async function saveUsers(data) { await store.saveUsers(data); }

async function initUsers() {
  if (getUsers() && getUsers().users.length) return;
  // 首次管理员密码：优先用环境变量（≥8 位视为强密码，不触发强制改密闸门），
  // 否则用 admin/admin123（公网访问会强制改密）。线上已有账号时本函数直接返回，行为不变。
  const envPw = String(process.env.ADMIN_INITIAL_PASSWORD || '');
  const custom = envPw.length >= 8;
  const admin = {
    id: 'U0001',
    username: 'admin',
    displayName: '系统管理员',
    role: 'admin',
    ownerName: '',
    passwordHash: hashPassword(custom ? envPw : 'admin123'),
    enabled: true,
    tokenVersion: 1,
    createdAt: nowStamp(),
    lastLogin: '',
    permissions: defaultPermissions('admin')
  };
  await saveUsers({ version: 1, users: [admin] });
  if (custom) {
    console.log('  首次初始化，已创建管理员账号 admin（密码取自 ADMIN_INITIAL_PASSWORD）');
  } else {
    console.log('  首次初始化，已创建管理员账号 admin / admin123（公网访问会强制要求改密）');
  }
}

function nextId(list, prefix) {
  let max = 0;
  for (const row of list) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(row.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

function normalize(raw, fields) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (SYSTEM_KEYS.includes(k)) continue;
    out[k] = typeof v === 'number' ? v : v == null ? '' : String(v).slice(0, 4000);
  }
  for (const f of fields) {
    if (!(f.key in out)) out[f.key] = f.type === 'number' ? null : '';
    if (f.type === 'number' && out[f.key] !== '' && out[f.key] !== null) {
      const n = Number(out[f.key]);
      out[f.key] = Number.isFinite(n) ? n : null;
    }
  }
  return out;
}

function validate(raw, fields) {
  const missing = fields.filter((f) => f.required).filter((f) => {
    const v = raw[f.key];
    return v === undefined || v === null || String(v).trim() === '';
  }).map((f) => f.label);
  if (missing.length) throw httpError(400, `必填字段未填写：${missing.join('、')}`);
}

/* ============================== 筛选 / 排序 / 聚合 ============================== */

function applyFilters(items, q) {
  let out = items.slice();
  const from = q.get('from');
  const to = q.get('to');
  const keyword = (q.get('keyword') || '').trim().toLowerCase();

  if (from) out = out.filter((r) => String(r.sourceTime || '').slice(0, 10) >= from);
  if (to) out = out.filter((r) => String(r.sourceTime || '').slice(0, 10) <= to);
  if (keyword) {
    out = out.filter((r) => Object.entries(r).some(([k, v]) =>
      !SYSTEM_KEYS.includes(k) && String(v == null ? '' : v).toLowerCase().includes(keyword)
    ));
  }
  for (const [k, v] of q.entries()) {
    if (!k.startsWith('f_') || !v) continue;
    const key = k.slice(2);
    const values = v.split(',').filter(Boolean);
    out = out.filter((r) => values.includes(String(r[key] == null ? '' : r[key])));
  }

  const sort = q.get('sort');
  if (sort) {
    const dir = q.get('order') === 'asc' ? 1 : -1;
    const numeric = items.some((r) => typeof r[sort] === 'number');
    out.sort((a, b) => {
      if (numeric) return ((Number(a[sort]) || 0) - (Number(b[sort]) || 0)) * dir;
      return String(a[sort] == null ? '' : a[sort]).localeCompare(String(b[sort] == null ? '' : b[sort]), 'zh-CN') * dir;
    });
  }
  return out;
}

function timeKey(value, grain) {
  const s = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return '未知';
  if (grain === 'day') return s.slice(0, 10);
  if (grain === 'month') return s.slice(0, 7);
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function aggregate(items, groupBy, q, cfg) {
  const field = cfg.fields.find((f) => f.key === groupBy);
  const grain = q.get('grain') || 'month';
  const limit = Math.min(50, Math.max(1, Number(q.get('limit') || 10)));
  if (!field) return { groupBy, grain, total: items.length, items: [] };

  const counts = new Map();
  const add = (key, n = 1) => counts.set(key, (counts.get(key) || 0) + n);
  const isTime = field.type === 'datetime' || field.type === 'date';
  const isNumber = field.type === 'number';
  const isText = field.type === 'textarea' || field.chart === 'keywords';

  if (isTime) {
    for (const row of items) add(timeKey(row[groupBy], grain));
  } else if (isNumber) {
    for (const row of items) {
      const n = Number(row[groupBy]) || 0;
      const bucket = BUCKETS.find(([lo, hi]) => n >= lo && n < hi);
      add(bucket ? bucket[2] : BUCKETS[BUCKETS.length - 1][2]);
    }
  } else if (isText) {
    for (const row of items) {
      const s = String(row[groupBy] || '');
      for (const word of cfg.keywords) if (s.includes(word)) add(word);
    }
  } else {
    for (const row of items) {
      const raw = row[groupBy];
      const values = Array.isArray(raw) ? raw : [raw];
      for (const v of values) add(String(v == null || v === '' ? '未填写' : v).trim());
    }
  }

  let result = [...counts].map(([label, value]) => ({ label, value }));
  if (isTime) result.sort((a, b) => a.label.localeCompare(b.label));
  else result.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'zh-CN'));
  if (!isTime && result.length > limit) result = result.slice(0, limit);
  return { groupBy, grain, total: items.length, items: result };
}

function toCSV(items, fields) {
  const rows = [
    fields.map((f) => f.label),
    ...items.map((r) => fields.map((f) => (r[f.key] == null ? '' : r[f.key])))
  ];
  const body = rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  return '\ufeff' + body;
}

/** 统一检查：筛选/排序/统计的字段必须在本账号可见范围内 */
function assertQueryFields(q, keys) {
  for (const name of q.keys()) {
    if (name.startsWith('f_') && !keys.includes(name.slice(2))) {
      throw httpError(403, `无权按字段 ${name.slice(2)} 筛选`);
    }
  }
  const sort = q.get('sort');
  if (sort && !keys.includes(sort)) throw httpError(403, `无权按字段 ${sort} 排序`);
}

/* ============================== 接口清单 ============================== */

const DOC_ENDPOINTS = [
  { method: 'GET', path: '/api/auth/status', desc: '公开探测当前是否已登录（不返回 401）' },
  { method: 'POST', path: '/api/auth/login', desc: '登录（设置 HttpOnly Cookie）' },
  { method: 'POST', path: '/api/auth/logout', desc: '退出登录' },
  { method: 'GET', path: '/api/auth/me', desc: '当前账号与权限' },
  { method: 'POST', path: '/api/auth/password', desc: '修改自己的密码' },
  { method: 'GET', path: '/api/health', desc: '健康检查（公开，不含业务数据）' },
  { method: 'GET', path: '/api/bootstrap', desc: '按权限返回字段配置 + 客户数据' },
  { method: 'GET', path: '/api/fields', desc: '获取当前账号可见的字段元数据' },
  { method: 'POST', path: '/api/fields', desc: '新增字段（需字段管理权限）' },
  { method: 'DELETE', path: '/api/fields/:key', desc: '删除非内置字段（需字段管理权限）' },
  { method: 'GET', path: '/api/customers', desc: '客户列表（按权限过滤字段与数据范围）' },
  { method: 'POST', path: '/api/customers', desc: '新增客户（需新增权限）' },
  { method: 'GET', path: '/api/customers/:id', desc: '单条详情' },
  { method: 'PUT', path: '/api/customers/:id', desc: '更新（只能改可见字段，需编辑权限）' },
  { method: 'DELETE', path: '/api/customers/:id', desc: '删除（需删除权限）' },
  { method: 'GET', path: '/api/stats', desc: '任意可见字段聚合：groupBy=<key>&grain=day|week|month' },
  { method: 'GET', path: '/api/export', desc: '导出 CSV（仅可见字段，需导出权限）' },
  { method: 'POST', path: '/api/import', desc: '批量导入（需新增权限，replace 仅管理员）' },
  { method: 'GET', path: '/api/users', desc: '用户列表（需用户管理权限）' },
  { method: 'POST', path: '/api/users', desc: '新建员工并授权（需用户管理权限）' },
  { method: 'PUT', path: '/api/users/:id', desc: '修改员工权限 / 启停' },
  { method: 'DELETE', path: '/api/users/:id', desc: '删除员工（不可删除管理员或自己）' },
  { method: 'POST', path: '/api/users/:id/reset-password', desc: '重置员工密码' },
  { method: 'GET', path: '/api/backup', desc: '导出全量快照：客户+字段+账号（仅管理员）' },
  { method: 'POST', path: '/api/restore', desc: '从快照恢复（仅管理员）' },
  { method: 'GET', path: '/api/docs', desc: '本接口清单' }
];

const DOC_RESPONSE = {
  base: '/api',
  auth: '除 /api/health、/api/auth/status 与 /api/auth/login 外，所有接口都需要 cid_session Cookie；权限在服务端强制生效。',
  storage: '存储可插拔：默认本地 JSON 文件（data/ 与 public/data、public/config），可选 WorkBuddy 云数据库 cid_state 表；以 /api/health 的 driver 字段为准。会话密钥 data/.session-secret 仅用于本应用自有会话签名',
  endpoints: DOC_ENDPOINTS,
  permissionModel: {
    role: 'admin 全部权限 / staff 按 permissions 授权',
    fields: '可见字段 key 数组，["*"] 表示全部；不可见字段不会出现在接口返回、统计、导出中',
    scope: 'all 全部客户 / own 仅本人跟单（按 ownerName 匹配）',
    functionFlags: PERM_KEYS
  },
  fieldTemplate: {
    key: 'newField', label: '新字段', type: 'select', options: ['A', 'B'],
    listable: true, filterable: true, aggregatable: true, searchable: true, chart: 'bar', builtin: false
  },
  // examples 由 docsFor(req) 按当前访问域名动态生成，避免写死 localhost 与默认密码
  examples: [],
  extendSteps: [
    '1. 在页面「字段管理」/ POST /api/fields 中加字段定义（写入当前存储后端）。',
    '2. 客户记录带上该 key，刷新后表格列、录入表单、筛选项、统计维度自动出现。',
    '3. 管理员在「用户管理」中勾选该字段，员工才可以看到；未勾选的字段不会下发到浏览器。',
    '4. 外部系统先登录拿 Cookie，再调用 /api/stats?groupBy=<字段 key>，服务端按同一套权限过滤。'
  ],
  backup: '管理员可在「数据管理」下载全量快照（客户+字段+账号），或用它恢复到当前存储后端。cloud 模式数据存于云数据库、重新部署不丢失；local 模式请定期备份 data/ 与 public/data 目录。'
};

/** 按当前请求的来源域名生成调用示例，密码一律用占位符，不泄露任何凭据 */
function docsFor(req) {
  let proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (isSecureRequest(req) ? 'https' : 'http');
  let host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  // 公网沙箱的反代会把内部域名写进 x-forwarded-host；浏览器带来的 Origin / Referer 才是用户真实访问域名
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  const publicSource = /^https?:\/\//i.test(origin) ? origin : (/^https?:\/\//i.test(referer) ? referer : '');
  if (publicSource) {
    try {
      const u = new URL(publicSource);
      proto = u.protocol.replace(':', '');
      host = u.host;
    } catch (e) { /* 保留反代推断值 */ }
  }
  const base = `${proto}://${host}`;
  return {
    ...DOC_RESPONSE,
    base: `${base}/api`,
    examples: [
      `curl -c cookies.txt -X POST ${base}/api/auth/login -H "Content-Type: application/json" -d '{"username":"<你的用户名>","password":"<你的密码>"}'`,
      `curl -b cookies.txt "${base}/api/stats?groupBy=channel&limit=10"`,
      `curl -b cookies.txt "${base}/api/bootstrap"`
    ]
  };
}

/* ============================== 路由 ============================== */

async function handleLogin(req, res) {
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const key = username.toLowerCase();
  if (!username || !body.password) return json(res, 400, { error: '请输入用户名和密码' });
  if (tooManyFails(key)) return json(res, 429, { error: '尝试次数过多，请 1 分钟后再试' });

  const data = getUsers();
  const user = data && data.users.find((u) => u.username.toLowerCase() === key);
  if (!user || !user.enabled || !checkPassword(body.password, user.passwordHash)) {
    recordFail(key);
    return json(res, 401, { error: '用户名或密码错误' });
  }
  clearFails(key);
  user.lastLogin = nowStamp();
  await saveUsers(data);
  // 公网下若仍是初始弱密码，标记会话为待改密；改密前一律不放行业务数据
  const weak = isPublicRequest(req) && checkPassword('admin123', user.passwordHash);
  setSessionCookie(req, res, user, weak);
  return json(res, 200, { ok: true, user: publicUser(user), mustChangePassword: !!weak });
}

async function handleAPI(req, res, u) {
  const p = u.pathname;
  const m = req.method.toUpperCase();
  const q = u.searchParams;

  /* ---- 公开接口 ---- */
  if (p === '/api/health' && m === 'GET') {
    return json(res, 200, {
      ok: true,
      mode: 'server',
      driver: store.driver,
      storage: store.isReady() ? store.driverName : 'initializing',
      time: new Date().toISOString()
    });
  }
  // 公开的会话状态探测：不返回 401，避免前端初始化时产生误报
  if (p === '/api/auth/status' && m === 'GET') {
    const current = authenticate(req);
    return json(res, 200, current
      ? { ok: true, authenticated: true, user: publicUser(current), mustChangePassword: isWeakSession(req) }
      : { ok: true, authenticated: false });
  }
  if (p === '/api/auth/login' && m === 'POST') return handleLogin(req, res);

  /* ---- 以下全部要求登录 ---- */
  const user = authenticate(req);
  if (!user) return json(res, 401, { error: '请先登录' });

  // 公网部署安全闸门：仍使用初始弱密码的会话，改密前不允许访问任何业务数据
  const weakAllowed = ['/api/auth/logout', '/api/auth/password', '/api/auth/me', '/api/auth/status'];
  if (isWeakSession(req) && !weakAllowed.includes(p)) {
    return json(res, 403, { error: '出于安全考虑，首次登录请先修改初始密码', mustChangePassword: true });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    clearSessionCookie(req, res);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth/me' && m === 'GET') {
    return json(res, 200, { user: publicUser(user) });
  }
  if (p === '/api/auth/password' && m === 'POST') {
    const body = await readBody(req);
    if (!checkPassword(body.oldPassword, user.passwordHash)) throw httpError(400, '原密码不正确');
    const next = String(body.newPassword || '');
    if (next.length < 8) throw httpError(400, '新密码至少 8 位');
    const data = getUsers();
    const target = data.users.find((x) => x.id === user.id);
    target.passwordHash = hashPassword(next);
    target.tokenVersion = (target.tokenVersion || 1) + 1; // 让其他设备的旧会话失效
    await saveUsers(data);
    setSessionCookie(req, res, target);
    return json(res, 200, { ok: true });
  }

  const cfg = getConfig();
  const keys = visibleFieldKeys(user, cfg);
  const fields = visibleFields(user, cfg);
  // 先按数据范围过滤，再脱敏；之后的筛选/排序/统计只能作用于可见字段
  const rowsFor = () => scopedRows(user, getCustomers()).map((r) => maskRow(r, keys));
  assertQueryFields(q, keys);

  /* ---- 字段元数据 ---- */
  if (p === '/api/fields' && m === 'GET') {
    return json(res, 200, { version: cfg.version, keywords: cfg.keywords, fields });
  }
  if (p === '/api/fields' && m === 'POST') {
    requirePerm(user, 'canManageFields');
    const body = await readBody(req);
    const key = String(body.key || '').trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(key)) {
      throw httpError(400, '字段 key 必须是英文字母开头、仅含字母数字下划线（≤31 位）');
    }
    if (SYSTEM_KEYS.includes(key) || cfg.fields.some((f) => f.key === key)) {
      throw httpError(409, `字段 ${key} 已存在或为系统保留字段`);
    }
    const type = FIELD_TYPES.includes(body.type) ? body.type : 'text';
    const field = {
      key,
      label: String(body.label || key).trim(),
      type,
      group: String(body.group || '自定义').trim(),
      required: !!body.required,
      listable: body.listable !== false,
      filterable: !!body.filterable,
      aggregatable: body.aggregatable !== false,
      searchable: body.searchable !== false,
      chart: body.chart || (type === 'number' ? 'bucket' : type === 'textarea' ? 'keywords' : type === 'datetime' ? 'line' : 'bar'),
      width: Number(body.width) || 130,
      builtin: false,
      description: String(body.description || '运行时新增字段').trim()
    };
    if (type === 'select' || type === 'tags') {
      field.options = Array.isArray(body.options) ? body.options.map(String) : String(body.options || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    if (type === 'number') field.unit = String(body.unit || '¥');
    await saveConfig({ ...cfg, fields: [...cfg.fields, field] });
    return json(res, 201, { ok: true, field, fields: [...cfg.fields, field] });
  }
  if (p.startsWith('/api/fields/') && m === 'DELETE') {
    requirePerm(user, 'canManageFields');
    const key = decodeURIComponent(p.slice('/api/fields/'.length));
    const target = cfg.fields.find((f) => f.key === key);
    if (!target) throw httpError(404, '字段不存在');
    if (target.builtin) throw httpError(403, '内置字段不允许删除');
    const nextFields = cfg.fields.filter((f) => f.key !== key);
    await saveConfig({ ...cfg, fields: nextFields });
    return json(res, 200, { ok: true, fields: nextFields });
  }

  /* ---- 用户管理 ---- */
  if (p === '/api/users' && m === 'GET') {
    requirePerm(user, 'canManageUsers');
    const data = getUsers();
    return json(res, 200, { users: data.users.map(publicUser) });
  }
  if (p === '/api/users' && m === 'POST') {
    requirePerm(user, 'canManageUsers');
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const data = getUsers();
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$/.test(username)) throw httpError(400, '用户名需 3-32 位，字母开头，仅字母数字 _ . -');
    if (data.users.some((x) => x.username.toLowerCase() === username.toLowerCase())) throw httpError(409, '用户名已存在');
    if (password.length < 6) throw httpError(400, '初始密码至少 6 位');
    const newUser = {
      id: nextId(data.users, 'U'),
      username,
      displayName: String(body.displayName || username).trim(),
      role: 'staff', // 接口只能创建员工，管理员只能由初始化或手工配置产生
      ownerName: String(body.ownerName || '').trim(),
      passwordHash: hashPassword(password),
      enabled: true,
      tokenVersion: 1,
      createdAt: nowStamp(),
      lastLogin: '',
      permissions: sanitizePermissions(body.permissions, user, cfg)
    };
    data.users.push(newUser);
    await saveUsers(data);
    return json(res, 201, { ok: true, user: publicUser(newUser) });
  }
  if (p.startsWith('/api/users/')) {
    requirePerm(user, 'canManageUsers');
    const rest = p.slice('/api/users/'.length);
    const resetMatch = /^(.+)\/reset-password$/.exec(rest);
    const id = decodeURIComponent(resetMatch ? resetMatch[1] : rest);
    const data = getUsers();
    const idx = data.users.findIndex((x) => x.id === id);
    if (idx < 0) throw httpError(404, '用户不存在');
    const target = data.users[idx];

    if (resetMatch && m === 'POST') {
      const body = await readBody(req);
      const pw = String(body.password || '');
      if (pw.length < 6) throw httpError(400, '新密码至少 6 位');
      target.passwordHash = hashPassword(pw);
      target.tokenVersion = (target.tokenVersion || 1) + 1; // 强制重新登录
      await saveUsers(data);
      return json(res, 200, { ok: true, message: '密码已重置，该用户需要重新登录' });
    }
    if (!resetMatch && m === 'PUT') {
      const body = await readBody(req);
      if (target.role === 'admin') {
        // 防止管理员被禁用/降权导致系统无人可管
        if (body.enabled === false) throw httpError(403, '不能禁用管理员账号');
      } else {
        if (body.enabled !== undefined) target.enabled = !!body.enabled;
        if (body.permissions !== undefined) target.permissions = sanitizePermissions(body.permissions, user, cfg);
      }
      if (body.displayName !== undefined) target.displayName = String(body.displayName).trim();
      if (body.ownerName !== undefined) target.ownerName = String(body.ownerName).trim();
      await saveUsers(data);
      return json(res, 200, { ok: true, user: publicUser(target) });
    }
    if (!resetMatch && m === 'DELETE') {
      if (target.role === 'admin') throw httpError(403, '管理员账号不可删除');
      if (target.id === user.id) throw httpError(403, '不能删除当前登录账号');
      data.users.splice(idx, 1);
      await saveUsers(data);
      return json(res, 200, { ok: true, user: publicUser(target) });
    }
  }

  /* ---- 客户数据 ---- */
  if (p === '/api/bootstrap' && m === 'GET') {
    return json(res, 200, {
      fields,
      keywords: cfg.keywords,
      customers: rowsFor(),
      user: publicUser(user),
      meta: { mode: 'server', version: cfg.version, serverTime: new Date().toISOString(), scope: effectivePermissions(user).scope }
    });
  }

  if (p === '/api/customers' && m === 'GET') {
    const filtered = applyFilters(rowsFor(), q);
    const page = Math.max(1, Number(q.get('page') || 1));
    const pageSize = Math.min(500, Math.max(1, Number(q.get('pageSize') || 20)));
    const start = (page - 1) * pageSize;
    return json(res, 200, { total: filtered.length, page, pageSize, items: filtered.slice(start, start + pageSize) });
  }
  if (p === '/api/customers' && m === 'POST') {
    requirePerm(user, 'canCreate');
    const raw = await readBody(req);
    const perm = effectivePermissions(user);
    const payload = {};
    keys.forEach((k) => { if (k in raw) payload[k] = raw[k]; });
    if (perm.scope === 'own') payload.owner = user.ownerName || ''; // 员工不能把记录归到别人名下
    validate(payload, fields);
    const list = getCustomers();
    const row = { id: nextId(list, 'C'), ...normalize(payload, cfg.fields), createdAt: nowStamp(), updatedAt: nowStamp() };
    list.push(row);
    await saveCustomers(list);
    return json(res, 201, { ok: true, item: maskRow(row, keys) });
  }
  if (p.startsWith('/api/customers/')) {
    const id = decodeURIComponent(p.slice('/api/customers/'.length));
    const list = getCustomers();
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0 || !inScope(user, list[idx])) throw httpError(404, `记录 ${id} 不存在`);

    if (m === 'GET') return json(res, 200, { item: maskRow(list[idx], keys) });
    if (m === 'PUT') {
      requirePerm(user, 'canEdit');
      const raw = await readBody(req);
      const merged = { ...list[idx] };
      for (const [k, v] of Object.entries(raw)) {
        if (!keys.includes(k) || SYSTEM_KEYS.includes(k)) continue; // 不能越权改不可见字段
        const f = cfg.fields.find((x) => x.key === k);
        let value = v == null ? '' : String(v).slice(0, 4000);
        if (f && f.type === 'number' && value !== '') value = Number(value) || 0;
        merged[k] = value;
      }
      if (effectivePermissions(user).scope === 'own') merged.owner = user.ownerName || '';
      validate(merged, fields);
      list[idx] = { ...merged, id: list[idx].id, createdAt: list[idx].createdAt, updatedAt: nowStamp() };
      await saveCustomers(list);
      return json(res, 200, { ok: true, item: maskRow(list[idx], keys) });
    }
    if (m === 'DELETE') {
      requirePerm(user, 'canDelete');
      const removed = list.splice(idx, 1)[0];
      await saveCustomers(list);
      return json(res, 200, { ok: true, item: maskRow(removed, keys) });
    }
  }

  /* ---- 统计 / 导入导出 ---- */
  if (p === '/api/stats' && m === 'GET') {
    const groupBy = q.get('groupBy');
    if (!groupBy) throw httpError(400, '缺少 groupBy 参数');
    if (!keys.includes(groupBy)) throw httpError(403, `无权统计字段 ${groupBy}`);
    return json(res, 200, aggregate(rowsFor(), groupBy, q, cfg));
  }
  if (p === '/api/export' && m === 'GET') {
    requirePerm(user, 'canExport');
    const csv = toCSV(applyFilters(rowsFor(), q), fields.filter((f) => f.listable));
    return text(res, 200, csv, 'text/csv; charset=utf-8', {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('客户数据')}.csv`
    });
  }
  if (p === '/api/import' && m === 'POST') {
    requirePerm(user, 'canCreate');
    const body = await readBody(req);
    if (!Array.isArray(body.items)) throw httpError(400, 'items 必须是数组');
    if (body.mode === 'replace' && user.role !== 'admin') throw httpError(403, '覆盖导入仅管理员可用');
    const perm = effectivePermissions(user);
    const incoming = body.items.map((r) => {
      const allowed = {};
      keys.forEach((k) => { if (k in r) allowed[k] = r[k]; });
      if (perm.scope === 'own') allowed.owner = user.ownerName || '';
      return { id: String(r.id || '').trim() || '', ...normalize(allowed, cfg.fields), createdAt: r.createdAt || nowStamp(), updatedAt: nowStamp() };
    });
    const list = body.mode === 'replace' ? [] : getCustomers();
    if (body.mode !== 'replace') {
      for (const row of incoming) {
        if (!row.id) continue;
        const i = list.findIndex((x) => x.id === row.id && inScope(user, x));
        if (i >= 0) list[i] = { ...list[i], ...row };
      }
    }
    const existing = new Set(list.map((r) => r.id));
    let seq = 0;
    for (const row of incoming) {
      if (row.id && existing.has(row.id)) continue;
      row.id = row.id || nextId([...list, ...incoming.slice(0, seq)], 'C');
      existing.add(row.id);
      list.push(row);
      seq++;
    }
    await saveCustomers(list);
    return json(res, 200, { ok: true, total: list.length, imported: incoming.length });
  }

  /* ---- 备份 / 恢复（仅管理员，抵御云端重新部署覆盖运行时数据） ---- */
  if (p === '/api/backup' && m === 'GET') {
    if (user.role !== 'admin') throw httpError(403, '仅管理员可导出完整备份');
    const snapshot = {
      format: 'cid-dashboard-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      fieldConfig: getConfig(),
      customers: getCustomers(),
      users: getUsers().users
    };
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('驾驶舱完整备份')}_${nowStamp().replace(/[: ]/g, '-')}.json`);
    return json(res, 200, snapshot, { 'X-Content-Type-Options': 'nosniff' });
  }
  if (p === '/api/restore' && m === 'POST') {
    if (user.role !== 'admin') throw httpError(403, '仅管理员可从备份恢复');
    const body = await readBody(req, 20 * 1024 * 1024);
    if (body.format !== 'cid-dashboard-backup' || body.version !== 1) {
      throw httpError(400, '备份文件格式或版本不正确');
    }
    const fc = body.fieldConfig;
    if (!fc || !Array.isArray(fc.fields) || !Array.isArray(fc.keywords) || !Array.isArray(body.customers) || !Array.isArray(body.users)) {
      throw httpError(400, '备份内容结构不完整');
    }
    const keys = fc.fields.map((f) => f && f.key).filter(Boolean);
    if (new Set(keys).size !== keys.length) throw httpError(400, '备份中的字段 key 存在重复');
    if (!body.users.some((u) => u && u.role === 'admin')) throw httpError(400, '备份中必须包含至少一个管理员账号');
    if (!body.users.some((u) => u && u.id === user.id)) throw httpError(403, '当前登录账号不在备份中，拒绝恢复以免失去管理入口');

    // 逐项回写当前存储后端；任一步失败会抛错，前面已写入的键不会被回滚，故先校验完整对象再写
    await saveCustomers(body.customers);
    await saveConfig({ version: fc.version || 1, note: fc.note || '', keywords: fc.keywords, fields: fc.fields });
    await saveUsers({ version: 1, users: body.users });
    return json(res, 200, {
      ok: true,
      counts: { customers: body.customers.length, fields: fc.fields.length, users: body.users.length },
      note: '恢复完成。当前会话可能因账号令牌版本变化而失效，如被登出请重新登录。'
    });
  }

  if (p === '/api/docs' && m === 'GET') return json(res, 200, docsFor(req));
  throw httpError(404, '接口不存在');
}

/* ============================== 静态服务 ============================== */

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (err) {
    return json(res, 400, { error: '非法路径' });
  }
  // 原始数据与字段种子文件不能绕过登录直接下载（线上权威数据在云数据库）
  if (/^\/data\//i.test(rel) || /^\/config\/fields\.json$/i.test(rel)) {
    return json(res, 403, { error: '请通过鉴权接口访问数据' });
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 403, { error: '禁止访问' });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return text(res, 404, '404 Not Found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ============================== 启动 ============================== */

/** 统一安全响应头：对公网部署降低点击劫持 / MIME 嗅探 / 信息泄露风险 */
function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // 兼容页面内联 SVG / data: 图标 / 内联样式；仅收紧脚本来源与嵌入面
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

const server = http.createServer((req, res) => {
  setSecurityHeaders(req, res);
  // 默认只允许同源调用；需要跨域时通过 ALLOWED_ORIGIN 显式配置
  if (process.env.ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    return json(res, 400, { error: '非法请求' });
  }
  if (u.pathname.startsWith('/api/')) {
    handleAPI(req, res, u).catch((err) => {
      console.error('[api]', err);
      json(res, err.status || 500, { error: err.message || '服务器内部错误' });
    });
  } else {
    serveStatic(req, res, u.pathname);
  }
});

getSecret();
(async function bootstrap() {
  try {
    const result = await store.init();
    const label = store.driver === 'cloud' ? '云数据库已连接' : '本地数据已加载';
    console.log(`  ${label}：客户 ${result.counts.customers} 条 / 字段 ${result.counts.fields} 个 / 账号 ${result.counts.users} 个` + (result.migrated ? '（已从本地种子迁移）' : ''));
    await initUsers();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  客户数据统计驾驶舱已启动`);
      console.log(`  ➜  http://0.0.0.0:${PORT}`);
      console.log(`  ➜  存储驱动：${store.driverName}`);
      console.log(`  ➜  接口清单：/api/docs（需登录）`);
      console.log(`  ➜  HTTPS 反代：自动识别 x-forwarded-proto 并为 Cookie 加 Secure\n`);
    });
  } catch (err) {
    console.error('  存储初始化失败，服务未启动：', err && err.message ? err.message : err);
    process.exitCode = 1;
  }
})();
