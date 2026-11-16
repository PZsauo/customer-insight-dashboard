'use strict';
/**
 * 本地 JSON 存储驱动（部署安装包默认）
 *
 * 零外部依赖：客户 / 字段配置 / 账号直接持久化在项目内的三个 JSON 文件，
 * 写操作使用「临时文件 + rename」原子替换，避免写一半时损坏数据。
 * 对外接口与 cloud-store.js 完全一致，由 storage.js 按配置选择其一。
 *
 * 安全说明：这三个文件虽位于 public/ 或 data/ 下，但服务端已禁止
 * /data/* 与 /config/fields.json 的静态下载，外部无法绕过登录直接获取。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FILES = {
  customers: path.join(ROOT, 'public', 'data', 'customers.json'),
  fields: path.join(ROOT, 'public', 'config', 'fields.json'),
  users: path.join(ROOT, 'data', 'users.json')
};

const EMPTY_FIELDS = { version: 1, fields: [], keywords: [] };
const EMPTY_USERS = { version: 1, users: [] };

const state = { customers: [], fields: EMPTY_FIELDS, users: EMPTY_USERS };
let ready = false;

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[local-store] 读取失败', file, e.message);
    return fallback;
  }
}

function writeJSON(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: mode || 0o644 });
  fs.renameSync(tmp, file);
}

function normalizeCustomers(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.items)) return v.items;
  return [];
}

function normalizeFields(v) {
  const cfg = v && typeof v === 'object' ? v : {};
  if (!Array.isArray(cfg.fields)) cfg.fields = [];
  if (!Array.isArray(cfg.keywords)) cfg.keywords = [];
  if (!cfg.version) cfg.version = 1;
  return cfg;
}

function normalizeUsers(v) {
  const data = v && typeof v === 'object' ? v : {};
  if (!Array.isArray(data.users)) data.users = [];
  if (!data.version) data.version = 1;
  return data;
}

async function setKey(key, value) {
  // 账号文件含密码哈希，收紧到 600；tmp 每次新建，rename 后权限即为 tmp 权限。
  writeJSON(FILES[key], value, key === 'users' ? 0o600 : 0o644);
}

async function init() {
  state.customers = normalizeCustomers(readJSON(FILES.customers, []));
  state.fields = normalizeFields(readJSON(FILES.fields, EMPTY_FIELDS));
  state.users = normalizeUsers(readJSON(FILES.users, EMPTY_USERS));

  // 首次运行确保种子文件落盘，之后以这些文件为权威数据源。
  // users.json 故意不在此创建：交给 server.js 的 initUsers() 生成初始管理员账号。
  if (!fs.existsSync(FILES.customers)) await setKey('customers', state.customers);
  if (!fs.existsSync(FILES.fields)) await setKey('fields', state.fields);

  ready = true;
  return {
    migrated: false,
    counts: { customers: state.customers.length, fields: state.fields.fields.length, users: state.users.users.length }
  };
}

function assertReady() {
  if (!ready) throw new Error('本地存储尚未初始化');
}

module.exports = {
  init,
  isReady: () => ready,
  getCustomers: () => { assertReady(); return state.customers; },
  getConfig: () => { assertReady(); return state.fields; },
  getUsers: () => { assertReady(); return state.users; },
  async saveCustomers(list) {
    assertReady();
    const next = normalizeCustomers(list);
    await setKey('customers', next);
    state.customers = next;
  },
  async saveConfig(cfg) {
    assertReady();
    const next = normalizeFields(cfg);
    await setKey('fields', next);
    state.fields = next;
  },
  async saveUsers(data) {
    assertReady();
    const next = normalizeUsers(data);
    await setKey('users', next);
    state.users = next;
  }
};
