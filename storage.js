'use strict';
/**
 * 存储适配器：一套业务代码，两种持久化后端。
 *
 * 选择优先级：
 *   1. 环境变量 STORAGE_DRIVER=local|cloud
 *   2. data/storage.json 中的 driver 字段
 *   3. 自动探测：存在 data/cloud-config.json 时用 cloud，否则 local
 *
 * 设计目的（可移植部署包）：
 *   - 安装包默认不带 cloud-config.json，因此解压到任意服务器即以「本地 JSON 文件」模式运行，
 *     不依赖内部 SDK、不依赖 WorkBuddy 平台反代、无需联网，零外部依赖。
 *   - WorkBuddy 平台发布环境带 cloud-config.json，自动使用「云数据库」模式，行为与之前完全一致。
 *   - 需要切换时，改 data/storage.json 或设置环境变量 STORAGE_DRIVER 即可，业务代码零改动。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STORAGE_CFG = path.join(ROOT, 'data', 'storage.json');
const CLOUD_CFG = path.join(ROOT, 'data', 'cloud-config.json');

function readDriverFile() {
  try {
    const cfg = JSON.parse(fs.readFileSync(STORAGE_CFG, 'utf8'));
    return cfg && (cfg.driver === 'local' || cfg.driver === 'cloud') ? cfg.driver : '';
  } catch (e) {
    return '';
  }
}

function resolveDriver() {
  const env = String(process.env.STORAGE_DRIVER || '').toLowerCase();
  if (env === 'local' || env === 'cloud') return env;
  const fromFile = readDriverFile();
  if (fromFile) return fromFile;
  return fs.existsSync(CLOUD_CFG) ? 'cloud' : 'local';
}

const driver = resolveDriver();
// 条件加载：local 模式完全不会触碰 SDK，因此任意服务器无需安装内部依赖即可启动。
const impl = driver === 'cloud' ? require('./cloud-store') : require('./local-store');

module.exports = {
  driver,
  driverName: driver === 'cloud' ? 'workbuddy-cloud-database' : 'local-json',
  init: (...args) => impl.init(...args),
  isReady: () => impl.isReady(),
  getCustomers: () => impl.getCustomers(),
  getConfig: () => impl.getConfig(),
  getUsers: () => impl.getUsers(),
  saveCustomers: (list) => impl.saveCustomers(list),
  saveConfig: (cfg) => impl.saveConfig(cfg),
  saveUsers: (data) => impl.saveUsers(data)
};
