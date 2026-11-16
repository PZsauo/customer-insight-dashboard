/**
 * 云服务数据层：客户 / 字段配置 / 账号统一持久化到 WorkBuddy 云数据库。
 *
 * 严格使用官方 SDK 初始化（endpoint + publishableKey 来自 publicConfig），
 * 通过自定义 fetch 注入公网 Origin；publishableKey 仅存于服务端私有文件，不下发前端。
 * 数据在内存中缓存，写操作实时回写云数据库；首次启动时自动把本地 JSON 迁移到云端。
 */
const fs = require('fs');
const path = require('path');
// 内置于安装包 vendor/，无需从内部 npm registry 安装；仅在 cloud 模式下由 storage.js 条件加载。
const { createWorkBuddyCloud, createMemoryStorage } = require('./vendor/workbuddy-cloud-sdk');

const ROOT = __dirname;
const CFG_FILE = path.join(ROOT, 'data', 'cloud-config.json');
const LOCAL_CUSTOMERS = path.join(ROOT, 'public', 'data', 'customers.json');
const LOCAL_FIELDS = path.join(ROOT, 'public', 'config', 'fields.json');
const LOCAL_USERS = path.join(ROOT, 'data', 'users.json');

const publicConfig = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const ORIGIN = new URL(publicConfig.endpoint).origin;

/**
 * 非浏览器运行时显式注入 fetch：补 Origin（云端按域名精确校验）。
 * 发布密钥只放在服务端私有配置中，绝不下发到前端；数据面网关会校验 x-wb-webapp-access-key，
 * 因此外部访客即使知道公网域名也无法直接读写云数据库。
 */
function cloudFetch(input, init) {
  const headers = new Headers(init && init.headers);
  if (!headers.has('Origin')) headers.set('Origin', ORIGIN);
  return fetch(input, Object.assign({}, init, { headers }));
}

const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
  fetch: cloudFetch,
  storage: createMemoryStorage()
});

const state = { customers: [], fields: { version: 1, fields: [], keywords: [] }, users: { version: 1, users: [] } };
let ready = false;

function readLocal(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
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
  const { error } = await cloud.database
    .from('cid_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error('云数据库写入失败（' + key + '）：' + error.message);
}

async function init() {
  const { data, error } = await cloud.database.from('cid_state').select('key,value');
  if (error) throw new Error('云数据库读取失败：' + error.message);
  const map = {};
  (data || []).forEach((row) => { if (row && row.key) map[row.key] = row.value; });

  let migrated = false;
  if (!map.customers) {
    map.customers = normalizeCustomers(readLocal(LOCAL_CUSTOMERS, []));
    await setKey('customers', map.customers);
    migrated = true;
  }
  if (!map.fields) {
    map.fields = normalizeFields(readLocal(LOCAL_FIELDS, { version: 1, fields: [], keywords: [] }));
    await setKey('fields', map.fields);
    migrated = true;
  }
  if (!map.users) {
    map.users = normalizeUsers(readLocal(LOCAL_USERS, { version: 1, users: [] }));
    await setKey('users', map.users);
    migrated = true;
  }

  state.customers = normalizeCustomers(map.customers);
  state.fields = normalizeFields(map.fields);
  state.users = normalizeUsers(map.users);
  ready = true;
  return { migrated, counts: { customers: state.customers.length, fields: state.fields.fields.length, users: state.users.users.length } };
}

function assertReady() {
  if (!ready) throw new Error('云数据库尚未初始化');
}

module.exports = {
  cloud,
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
