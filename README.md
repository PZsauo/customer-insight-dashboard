# 客户数据信息统计驾驶舱 · 部署安装包

一套可移植的客户数据可视化驾驶舱：字段元数据驱动、登录与三层权限、SVG 自绘图表、CSV 导入导出、完整备份恢复。**解压即用，零外部依赖，可部署到任意装有 Node.js 18+ 的服务器。**

---

## 1. 目录结构

```
customer-insight-dashboard/
├── server.js              # REST 服务（鉴权 / 权限 / 统计 / 导入导出 / 备份恢复）
├── storage.js             # 存储适配器：按配置选择 local 或 cloud
├── local-store.js         # 本地 JSON 存储驱动（默认，零依赖）
├── cloud-store.js         # WorkBuddy 云数据库驱动（可选）
├── package.json           # 无外部运行时依赖
├── public/                # 前端静态资源
│   ├── index.html
│   ├── css/  js/
│   ├── config/fields.json # 字段元数据（新增统计维度改这里，前端零改动）
│   └── data/customers.json# 演示客户数据（168 条，可清空后导入真实数据）
├── data/
│   ├── storage.json       # 存储驱动配置（默认 local）
│   ├── storage.json.example
│   ├── cloud-config.json.example  # 仅 cloud 模式需要
│   └── .session-secret    # 会话签名密钥（首次启动自动生成，权限 600）
├── vendor/                # 内置 WorkBuddy SDK（仅 cloud 模式加载，无需 npm install）
├── deploy/
│   ├── start.sh / start.bat / stop.sh
│   └── customer-insight-dashboard.service  # systemd 服务模板
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md              # 本文档
```

---

## 2. 快速开始（3 种部署方式，任选其一）

### 方式 A：直接运行（最快，适合本地或已有 Node 环境）

```bash
cd customer-insight-dashboard
cp .env.example .env          # 可选，按需修改端口/密码等
bash deploy/start.sh          # 前台运行；加 -d 后台运行
# Windows 用户：双击 deploy/start.bat
```

浏览器打开 `http://服务器IP:3000`。首次使用默认管理员：

- 用户名 `admin`，密码 `admin123`
- **从公网/非本机访问时，系统会强制你先修改初始密码**，改完才能查看数据。
- 如需自定义首次密码，在 `.env` 里设置 `ADMIN_INITIAL_PASSWORD=一个至少8位的强密码`。

### 方式 B：systemd 服务（推荐用于 Linux 生产服务器，开机自启 + 崩溃自愈）

```bash
# 1. 放到统一目录
sudo mkdir -p /opt/customer-insight-dashboard
sudo cp -r customer-insight-dashboard/* /opt/customer-insight-dashboard/

# 2. 创建运行用户并授权数据目录
sudo useradd -r -s /usr/sbin/nologin www-data 2>/dev/null || true
sudo chown -R www-data:www-data /opt/customer-insight-dashboard

# 3. 安装服务
sudo cp /opt/customer-insight-dashboard/deploy/customer-insight-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now customer-insight-dashboard

# 4. 查看状态 / 日志
sudo systemctl status customer-insight-dashboard
sudo journalctl -u customer-insight-dashboard -f
```

修改端口、密码、反代等配置：编辑 service 文件里的 `Environment=` 行，或应用根目录的 `.env`，然后 `sudo systemctl daemon-reload && sudo systemctl restart customer-insight-dashboard`。

### 方式 C：Docker / Docker Compose（跨平台，环境隔离）

```bash
cd customer-insight-dashboard
docker compose up -d          # 构建并后台启动
docker compose logs -f        # 查看日志
docker compose down           # 停止（数据在命名卷中，不会丢）
```

自定义外部端口：修改 `docker-compose.yml` 里 `ports` 的冒号左侧（如 `"8080:3000"`）。数据持久化在 `cid_data` / `cid_public_data` / `cid_logs` 三个命名卷中。

---

## 3. 存储模式：本地文件 vs 云数据库

应用通过 `data/storage.json` 的 `driver` 选择后端，也可用环境变量 `STORAGE_DRIVER` 覆盖（后者优先级更高）。

| 模式 | 配置 | 数据位置 | 适用场景 |
|---|---|---|---|
| **local**（默认） | `"driver": "local"` | `public/data/customers.json`、`public/config/fields.json`、`data/users.json` | 任意自有服务器、内网部署、离线环境。零外部依赖、开箱即用。 |
| **cloud**（可选） | `"driver": "cloud"` | WorkBuddy 云数据库 `cid_state` 表 | 已启用 WorkBuddy 云服务的平台内应用，多实例共享、免本地磁盘维护。 |

**切换方法：**

- local（默认）：确保 `data/storage.json` 为 `{"driver":"local"}`，无需其他配置。
- cloud：
  1. 从 WorkBuddy 云服务面板获取该应用的 `publicConfig`；
  2. `cp data/cloud-config.json.example data/cloud-config.json`，填入 `resourceId`、`endpoint`、`oauthRelayBaseUrl`、`publishableKey`；
  3. 把 `data/storage.json` 改为 `{"driver":"cloud"}`（或启动时用 `STORAGE_DRIVER=cloud`）；
  4. 重启服务。首次启动会把本地 JSON 种子迁移到云数据库。

> 健康检查接口 `GET /api/health` 的 `driver` 与 `storage` 字段会实时显示当前后端，便于确认。
> 切换模式前请先用「数据管理 → 导出备份」保存快照，切到另一模式后再「从备份恢复」，以迁移历史数据。

---

## 4. 配置项（`.env` / 环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `STORAGE_DRIVER` | `local` | 存储驱动 `local` / `cloud`，优先级高于 storage.json |
| `ADMIN_INITIAL_PASSWORD` | 空 | 首次管理员密码（≥8 位）。留空用 `admin/admin123` 且公网强制改密 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `COOKIE_SECURE` | 空 | 站在 HTTPS 反代之后设为 `1`，给 Cookie 加 Secure |
| `ALLOWED_ORIGIN` | 空 | 跨域时设为前端完整来源，如 `https://dash.example.com` |

---

## 5. 安全说明

- **默认仅本机/内网可完全访问**：从公网域名或公网 IP 访问时，若仍在使用 `admin123`，会被强制改密后才能查看数据。
- **静态数据不可下载**：`/data/*` 与 `/config/fields.json` 一律返回 403，客户/账号只能经鉴权接口获取。
- **服务端强制权限**：数据范围（全部 / 仅本人跟单）、字段级脱敏、功能开关（导出/增删改/字段管理/用户管理）都在服务端执行，前端裁剪只是体验优化。
- **会话密钥**：`data/.session-secret` 首次启动随机生成（Linux 下权限 600；Windows 文件系统不支持 POSIX 权限位，会显示为 644，属正常）。**不要删除它**，否则所有用户会被登出；迁移服务器时请一并复制。`data/users.json`、`data/cloud-config.json` 同样在 `start.sh` 中被收紧为 600。
- **公网部署务必加 HTTPS**：可用 Nginx/Caddy 反代，并把 `COOKIE_SECURE=1`。应用会自动识别 `x-forwarded-proto` 给 Cookie 加 Secure。
- **不要把真实的 `data/cloud-config.json` 或 `.session-secret` 提交到公开代码库。**

Nginx 反代示例：

```nginx
server {
    listen 443 ssl;
    server_name dash.example.com;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;   # 关键：应用据此加 Cookie Secure
    }
}
```

---

## 6. 日常运维

- **备份**：登录后进「数据管理 → 下载备份快照」，得到含客户/字段/账号的 JSON。local 模式也可直接打包目录：`tar czf backup.tgz data/ public/data/ public/config/`（含会话密钥与账号哈希，妥善保管）。
- **恢复**：「数据管理 → 选择快照并恢复」，会覆盖全部数据，恢复后重新登录。
- **日志**：前台运行直接看控制台；`start.sh -d` 在 `logs/app.log`；systemd 用 `journalctl -u customer-insight-dashboard -f`；Docker 用 `docker compose logs -f`。
- **健康检查**：`curl http://127.0.0.1:3000/api/health`，返回 `{"ok":true,"driver":"local","storage":"local-json",...}`。

---

## 7. 扩展统计维度（无需改前端代码）

字段元数据驱动：表格列、筛选、录入表单、统计卡片、CSV 表头、后端聚合全部由 `public/config/fields.json` 生成。

新增一个统计维度只需在 `fields` 数组里加一个对象：

```json
{
  "key": "industry",
  "label": "所属行业",
  "type": "select",
  "options": ["制造", "教育", "医疗", "金融"],
  "listable": true,
  "filterable": true,
  "aggregatable": true,
  "searchable": true,
  "chart": "bar",
  "builtin": false
}
```

刷新页面后，该字段会自动出现在表格列、录入表单、筛选项和「添加统计卡片」中。也可在页面「字段管理」里在线新增/删除。新增后，管理员需在「用户管理」里给员工勾选该字段，员工才可见（未授权字段不会下发到浏览器）。

字段类型：`text` / `textarea` / `select` / `number` / `date` / `datetime` / `tags`；推荐图表 `bar` / `donut` / `line` / `keywords` / `bucket`。

---

## 8. 常见问题

- **启动报“需要 Node.js >= 18”**：请升级 Node（https://nodejs.org/）。
- **端口被占用**：`PORT=8080 bash deploy/start.sh`，或改 `.env` / docker-compose。
- **登录后数据为空**：发行包内置 168 条演示数据；如被清空，可在「数据管理」导入 CSV，或运行 `node scripts/generate-demo-data.js` 重新生成演示数据。
- **忘记管理员密码**：删除 `data/users.json` 后重启，会重新创建初始管理员（**会丢失账号配置，客户数据不受影响**）。cloud 模式请在云数据库 `cid_state` 的 `users` 键中处理。
- **换服务器迁移**：local 模式复制整个目录（含 `data/` 与 `public/data/`）；cloud 模式只需在新实例配置同一个 `cloud-config.json`，数据自动从云端读取。最稳妥的是用「导出备份 → 从备份恢复」。

---

## 9. 技术栈

Node.js 18+（仅内置模块，无运行时 npm 依赖）· 原生 HTML/CSS/JS · SVG 自绘图表 · HMAC 签名会话 · scrypt 密码哈希 · 字段元数据驱动 · 可选 WorkBuddy 云数据库。
