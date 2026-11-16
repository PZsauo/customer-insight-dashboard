/* =============================================================
 * app.js —— 客户数据统计驾驶舱主逻辑（登录 / 权限 / 可视化）
 *
 * 两条核心设计：
 * 1. 字段元数据驱动：表格列、筛选器、录入表单、统计卡片全由字段配置生成。
 * 2. 权限由服务端强制下发：前端只拿到「可见字段 + 范围内数据」，
 *    界面据此裁剪；隐藏按钮只是体验，安全边界在 server.js。
 * ============================================================= */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var esc = window.Charts.esc;
  var LS = {
    get: function (k, fallback) {
      try { var v = JSON.parse(localStorage.getItem('cid.' + k)); return v == null ? fallback : v; }
      catch (e) { return fallback; }
    },
    set: function (k, v) { try { localStorage.setItem('cid.' + k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } }
  };

  var DEFAULT_CARDS = [
    { id: 'c1', field: 'sourceTime', title: '客户来源时间趋势', type: 'line', grain: 'week', limit: 0, span: true },
    { id: 'c2', field: 'region', title: '地区分布', type: 'bar', limit: 10 },
    { id: 'c3', field: 'channel', title: '来源渠道占比', type: 'donut', limit: 10 },
    { id: 'c4', field: 'channelDetail', title: '渠道详情 Top 10', type: 'bar', limit: 10 },
    { id: 'c5', field: 'intent', title: '搜索意图分布', type: 'bar', limit: 10 },
    { id: 'c6', field: 'owner', title: '跟单人员线索量', type: 'bar', limit: 10 },
    { id: 'c7', field: 'status', title: '跟进状态分布', type: 'donut', limit: 10 },
    { id: 'c8', field: 'feedback', title: '反馈信息 · 高频词', type: 'keywords', limit: 20 },
    { id: 'c9', field: 'inquiry', title: '咨询信息 · 高频词', type: 'keywords', limit: 20 }
  ];

  var BUCKETS = [
    [0, 50000, '0-5万'], [50000, 100000, '5-10万'],
    [100000, 300000, '10-30万'], [300000, 500000, '30-50万'], [500000, Infinity, '50万+']
  ];

  var PERM_LABELS = [
    ['canExport', '允许导出 CSV'],
    ['canCreate', '允许新增客户 / 导入数据'],
    ['canEdit', '允许编辑客户'],
    ['canDelete', '允许删除客户'],
    ['canManageFields', '允许管理字段'],
    ['canManageUsers', '允许管理用户与授权']
  ];

  var S = {
    me: null,
    fields: [],
    keywords: [],
    customers: [],
    filtered: [],
    filters: { from: '', to: '', keyword: '', selects: {} },
    quick: 0,
    cards: LS.get('cards', DEFAULT_CARDS),
    hiddenCols: LS.get('hiddenCols', []),
    page: 1,
    pageSize: 20,
    sort: { key: 'sourceTime', order: 'desc' },
    theme: LS.get('theme', 'light'),
    docs: null,
    health: null,
    forcePassword: false
  };
  // 存储后端由服务端决定（local 本地文件 / cloud 云数据库），文案随之变化；不硬编码。
  function storageLabel() {
    var h = S.health || {};
    if (h.driver === 'cloud') return 'WorkBuddy 云数据库';
    if (h.driver === 'local') return '服务器本地数据文件';
    return '服务端存储';
  }
  function storageTip() {
    return storageLabel() === '服务器本地数据文件'
      ? '数据保存在服务器的 data/ 与 public/data 目录，请定期用「数据管理 → 导出备份」留存快照；迁移服务器时连同这些目录一起复制。'
      : '数据保存在应用专属的 WorkBuddy 云数据库中，不对外静态暴露；请定期用「数据管理 → 导出备份」留存快照。';
  }
  if (!Array.isArray(S.cards) || !S.cards.length) S.cards = DEFAULT_CARDS.slice();
  if (!Array.isArray(S.hiddenCols)) S.hiddenCols = [];

  /* ------------------------ 工具 ------------------------ */
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysAgo(n) { var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return dateStr(d); }
  function num(v) { return Number(v || 0).toLocaleString('zh-CN'); }
  function money(v) {
    var n = Number(v) || 0;
    return n >= 10000 ? '¥' + (n / 10000).toFixed(1) + '万' : '¥' + num(n);
  }
  function field(key) { return S.fields.find(function (f) { return f.key === key; }); }
  function saveLayout() { LS.set('cards', S.cards); }
  function can(key) { return !!(S.me && (S.me.role === 'admin' || S.me.permissions[key])); }
  function guard(key) {
    if (can(key)) return true;
    toast('当前账号没有此操作权限', true);
    return false;
  }
  function isAdmin() { return !!(S.me && S.me.role === 'admin'); }

  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.className = 'toast'; }, 2800);
  }

  async function api(path, options) {
    var o = options || {};
    var res = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, o));
    if (res.status === 401 && !o.silent401 && path.indexOf('/auth/login') < 0) onUnauthorized();
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      if (data.mustChangePassword && S.me) {
        // 服务端判定仍在用初始密码：强制进入改密流程
        S.forcePassword = false;
        showPasswordForm(true);
      }
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    return data;
  }

  function onUnauthorized() {
    S.me = null;
    S.customers = [];
    S.filtered = [];
    S.forcePassword = false;
    document.querySelector('.app').style.visibility = '';
    $('#mask').classList.remove('locked');
    $('#drawerClose').style.visibility = '';
    document.body.classList.add('locked');
    $('#loginScreen').classList.remove('hidden');
    $('#loginError').textContent = '登录已失效，请重新登录';
    $('#kpis').innerHTML = '';
    $('#chartGrid').innerHTML = '';
    $('#tableBody').innerHTML = '';
    closeDrawer();
  }

  /* ------------------------ 登录 / 会话 ------------------------ */
  async function doLogin(username, password) {
    var box = $('#loginError');
    box.textContent = '';
    var btn = $('#loginForm button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      var d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: username, password: password }) });
      S.me = d.user;
      await enterApp(d.mustChangePassword);
    } catch (err) {
      box.textContent = err.message || '登录失败';
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  }

  async function enterApp(mustChangePassword) {
    document.body.classList.remove('locked');
    $('#loginScreen').classList.add('hidden');
    $('#loginPass').value = '';
    if (mustChangePassword) {
      // 公网下仍为初始弱密码：只展示改密抽屉，不加载任何业务数据
      applyPermissionsToUI();
      showPasswordForm(true);
      return;
    }
    await loadData();
    applyPermissionsToUI();
    renderAll();
  }

  async function checkSession() {
    try {
      var d = await api('/api/auth/status', { silent401: true });
      if (d.authenticated && d.user) {
        S.me = d.user;
        await enterApp(d.mustChangePassword);
      }
      // 未登录：保持登录层显示，不请求任何业务数据，也不清空可能的错误提示
    } catch (e) { /* 探测失败时保持登录界面 */ }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', silent401: true }).catch(function () { });
    S.me = null;
    S.customers = [];
    S.filtered = [];
    S.forcePassword = false;
    document.querySelector('.app').style.visibility = '';
    $('#mask').classList.remove('locked');
    $('#drawerClose').style.visibility = '';
    document.body.classList.add('locked');
    $('#loginScreen').classList.remove('hidden');
    $('#loginError').textContent = '';
    $('#loginUser').value = '';
    $('#loginPass').value = '';
    $('#kpis').innerHTML = '';
    $('#chartGrid').innerHTML = '';
    $('#tableBody').innerHTML = '';
    closeDrawer();
  }

  function applyPermissionsToUI() {
    var me = S.me;
    if (!me) return;
    var p = me.permissions || {};
    var scopeText = p.scope === 'own' ? ' · 仅本人跟单' : '';
    $('#userChip').textContent = me.displayName + ' · ' + (me.role === 'admin' ? '管理员' : '员工') + scopeText;
    $('#userChip').className = 'user-chip ' + (me.role === 'admin' ? 'admin' : 'staff');
    $('#modeBadge').textContent = '在线模式 · 权限已校验';
    $('#modeBadge').className = 'mode-badge online';
    $('#btnUsers').style.display = can('canManageUsers') ? '' : 'none';
    $('#btnFields').style.display = can('canManageFields') ? '' : 'none';
    $('#btnData').style.display = '';
    $('#btnImport').style.display = can('canCreate') ? '' : 'none';
    $('#btnExport').style.display = can('canExport') ? '' : 'none';
    $('#btnAdd').style.display = can('canCreate') ? '' : 'none';
  }

  /* ------------------------ 数据加载 ------------------------ */
  async function loadData() {
    var d = await api('/api/bootstrap');
    S.fields = d.fields || [];
    S.keywords = d.keywords || [];
    S.customers = d.customers || [];
    S.me = d.user || S.me;
    S.docs = await api('/api/docs').catch(function () { return null; });
    // 字段被删除或权限收回后，自动移除失效卡片；排序字段也要回到可见字段
    S.cards = S.cards.filter(function (c) { return !!field(c.field); });
    if (!S.cards.length) S.cards = DEFAULT_CARDS.filter(function (c) { return !!field(c.field); });
    if (!field(S.sort.key)) S.sort = { key: S.fields.length ? S.fields[0].key : 'sourceTime', order: 'desc' };
    S.hiddenCols = S.hiddenCols.filter(function (k) { return !!field(k); });
  }

  /* ------------------------ 筛选 ------------------------ */
  function applyFilters() {
    var f = S.filters;
    var rows = S.customers.slice();
    if (f.from) rows = rows.filter(function (r) { return String(r.sourceTime || '').slice(0, 10) >= f.from; });
    if (f.to) rows = rows.filter(function (r) { return String(r.sourceTime || '').slice(0, 10) <= f.to; });
    var kw = f.keyword.trim().toLowerCase();
    if (kw) {
      rows = rows.filter(function (r) {
        return Object.keys(r).some(function (k) {
          return !['id', 'createdAt', 'updatedAt'].includes(k) && String(r[k] == null ? '' : r[k]).toLowerCase().indexOf(kw) >= 0;
        });
      });
    }
    Object.keys(f.selects).forEach(function (k) {
      var v = f.selects[k];
      if (v) rows = rows.filter(function (r) { return String(r[k] == null ? '' : r[k]) === v; });
    });
    var sk = S.sort.key, dir = S.sort.order === 'asc' ? 1 : -1;
    var numeric = S.fields.some(function (fd) { return fd.key === sk && fd.type === 'number'; });
    rows.sort(function (a, b) {
      if (numeric) return ((Number(a[sk]) || 0) - (Number(b[sk]) || 0)) * dir;
      return String(a[sk] == null ? '' : a[sk]).localeCompare(String(b[sk] == null ? '' : b[sk]), 'zh-CN') * dir;
    });
    S.filtered = rows;
    var maxPage = Math.max(1, Math.ceil(rows.length / S.pageSize));
    if (S.page > maxPage) S.page = maxPage;
  }

  function renderFilterSelects() {
    var el = $('#dynamicFilters');
    var list = S.fields.filter(function (f) { return f.filterable; });
    el.innerHTML = list.map(function (f) {
      var opts = f.options && f.options.length ? f.options.slice() : [];
      S.customers.forEach(function (r) {
        var v = String(r[f.key] == null ? '' : r[f.key]).trim();
        if (v && opts.indexOf(v) < 0) opts.push(v);
      });
      opts.sort(function (a, b) { return String(a).localeCompare(String(b), 'zh-CN'); });
      var cur = S.filters.selects[f.key] || '';
      return '<select class="form-control" data-filter="' + esc(f.key) + '" title="筛选：' + esc(f.label) + '">' +
        '<option value="">全部' + esc(f.label) + '</option>' +
        opts.map(function (o) { return '<option value="' + esc(o) + '"' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') +
        '</select>';
    }).join('');
    el.querySelectorAll('select').forEach(function (sel) {
      sel.style.width = 'auto';
      sel.style.minWidth = '112px';
      sel.style.maxWidth = '160px';
    });
  }

  function renderFilterMeta() {
    var parts = ['当前展示 <b>' + S.filtered.length + '</b> / 共 ' + S.customers.length + ' 条'];
    if (S.filters.from || S.filters.to) parts.push('时间：' + (S.filters.from || '最早') + ' ~ ' + (S.filters.to || '最新'));
    else parts.push('时间：全部');
    Object.keys(S.filters.selects).forEach(function (k) {
      if (!S.filters.selects[k]) return;
      var f = field(k);
      parts.push((f ? f.label : k) + '：' + S.filters.selects[k]);
    });
    if (S.filters.keyword.trim()) parts.push('关键词：' + esc(S.filters.keyword.trim()));
    if (S.me && S.me.permissions.scope === 'own') {
      parts.push('<span class="scope-note">数据范围：仅 ' + esc(S.me.ownerName || '本人') + ' 跟单的客户</span>');
    }
    $('#filterMeta').innerHTML = parts.join(' <span style="opacity:.45">·</span> ');
  }

  /* ------------------------ KPI（按可见字段动态生成） ------------------------ */
  function renderKPIs() {
    var rows = S.filtered;
    var total = rows.length;
    var cards = [{ label: '客户总数', value: num(total), sub: '当前权限与筛选范围内的线索', color: '#4c63e6' }];

    if (field('sourceTime')) {
      var boundary = daysAgo(6);
      var recent = rows.filter(function (r) { return String(r.sourceTime || '').slice(0, 10) >= boundary; }).length;
      cards.push({ label: '近 7 天新增', value: num(recent), sub: '占当前结果 ' + (total ? (recent / total * 100).toFixed(1) : '0') + '%', color: '#17b8a6' });
    }
    if (field('status')) {
      var won = rows.filter(function (r) { return r.status === '已成交'; }).length;
      var active = rows.filter(function (r) { return ['新线索', '跟进中', '已报价'].indexOf(r.status) >= 0; }).length;
      cards.push({ label: '已成交', value: num(won), sub: '转化率 ' + (total ? (won / total * 100).toFixed(1) : '0.0') + '%', color: '#12a37a' });
      cards.push({ label: '跟进中', value: num(active), sub: '含新线索 / 已报价', color: '#f2a03d' });
    }
    if (field('amount')) {
      var amount = rows.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);
      var sub = '当前可见记录合计';
      if (field('feedback')) {
        var fb = rows.filter(function (r) { return String(r.feedback || '').trim(); }).length;
        sub = '反馈已填写 ' + (total ? (fb / total * 100).toFixed(0) : '0') + '%';
      }
      cards.push({ label: '预计金额', value: money(amount), sub: sub, color: '#8b5cf6' });
    }
    $('#kpis').innerHTML = cards.map(function (c) {
      return '<div class="kpi-card" style="--kpi-color:' + c.color + '">' +
        '<div class="kpi-label"><span class="kpi-dot"></span>' + esc(c.label) + '</div>' +
        '<div class="kpi-value">' + c.value + '</div><div class="kpi-sub">' + esc(c.sub) + '</div></div>';
    }).join('');
  }

  /* ------------------------ 任意字段聚合 ------------------------ */
  function timeKey(value, grain) {
    var s = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return '未知';
    if (grain === 'day') return s.slice(0, 10);
    if (grain === 'month') return s.slice(0, 7);
    var d = new Date(s + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return dateStr(d);
  }

  function aggregate(card) {
    var f = field(card.field);
    if (!f) return [];
    var rows = S.filtered;
    var counts = new Map();
    var add = function (k, n) { counts.set(k, (counts.get(k) || 0) + (n || 1)); };
    var isTime = f.type === 'datetime' || f.type === 'date';
    var isNumber = f.type === 'number';
    var isText = f.type === 'textarea' || f.chart === 'keywords';
    var cardType = card.type;

    if (isTime && cardType === 'line') {
      rows.forEach(function (r) { add(timeKey(r[f.key], card.grain || 'week')); });
    } else if (isNumber && cardType !== 'keywords') {
      rows.forEach(function (r) {
        var n = Number(r[f.key]) || 0;
        var b = BUCKETS.find(function (x) { return n >= x[0] && n < x[1]; });
        add(b ? b[2] : BUCKETS[BUCKETS.length - 1][2]);
      });
    } else if (isText && cardType === 'keywords') {
      rows.forEach(function (r) {
        var s = String(r[f.key] || '');
        S.keywords.forEach(function (w) { if (s.indexOf(w) >= 0) add(w); });
      });
    } else {
      rows.forEach(function (r) {
        var v = r[f.key];
        (Array.isArray(v) ? v : [v]).forEach(function (one) {
          add(String(one == null || one === '' ? '未填写' : one).trim());
        });
      });
    }
    var items = Array.from(counts).map(function (p) { return { label: p[0], value: p[1] }; });
    if (isTime && cardType === 'line') items.sort(function (a, b) { return a.label.localeCompare(b.label); });
    else items.sort(function (a, b) { return b.value - a.value || a.label.localeCompare(b.label, 'zh-CN'); });
    if (isTime && cardType === 'line') {
      if (items.length > 40) items = items.slice(-40);
    } else if (card.limit > 0 && cardType !== 'donut') {
      items = items.slice(0, card.limit);
    }
    return items;
  }

  /* ------------------------ 图表卡片 ------------------------ */
  function renderCards() {
    var types = [['bar', '条形'], ['donut', '环形'], ['line', '趋势'], ['keywords', '词云'], ['bucket', '分桶']];
    var html = S.cards.map(function (c) {
      var f = field(c.field) || { label: c.field };
      var isTime = f.type === 'datetime' || f.type === 'date';
      var items = aggregate(c);
      var typeSel = '<select data-act="type" data-id="' + esc(c.id) + '" title="图表类型">' + types.map(function (t) {
        return '<option value="' + t[0] + '"' + (c.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
      }).join('') + '</select>';
      var grainSel = (isTime && c.type === 'line') ? '<select data-act="grain" data-id="' + esc(c.id) + '" title="时间粒度">' +
        [['day', '按日'], ['week', '按周'], ['month', '按月']].map(function (g) {
          return '<option value="' + g[0] + '"' + ((c.grain || 'week') === g[0] ? ' selected' : '') + '>' + g[1] + '</option>';
        }).join('') + '</select>' : '';
      var curLimit = Number(c.limit || 0);
      var limitOptions = [[5, 'Top 5'], [10, 'Top 10'], [15, 'Top 15'], [20, 'Top 20'], [0, '全部']];
      if (curLimit > 0 && !limitOptions.some(function (l) { return l[0] === curLimit; })) {
        limitOptions.push([curLimit, 'Top ' + curLimit]);
        limitOptions.sort(function (a, b) { return (a[0] || 999) - (b[0] || 999); });
      }
      var limitSel = (c.type === 'line') ? '' : '<select data-act="limit" data-id="' + esc(c.id) + '" title="展示条数">' +
        limitOptions.map(function (l) {
          return '<option value="' + l[0] + '"' + (curLimit === l[0] ? ' selected' : '') + '>' + l[1] + '</option>';
        }).join('') + '</select>';
      return '<article class="chart-card' + (c.span ? ' span-2' : '') + '" data-card="' + esc(c.id) + '">' +
        '<div class="chart-card-head"><div class="chart-title">' + esc(c.title) +
        '<span class="chip">' + esc(f.label) + ' · ' + items.length + ' 项</span></div>' +
        '<div class="chart-actions">' + typeSel + grainSel + limitSel +
        '<button data-act="remove" data-id="' + esc(c.id) + '" title="移除此卡片">×</button></div></div>' +
        '<div class="chart-body' + (c.type === 'line' ? ' tall' : '') + '" data-card-body="' + esc(c.id) + '">' +
        window.Charts.render(c.type, items, { monochrome: c.field === 'owner', width: c.span ? 1100 : 520, limit: c.limit }) + '</div></article>';
    }).join('');
    $('#chartGrid').innerHTML = html || '<div class="card empty-state">当前权限下暂无统计卡片，可点击「添加统计卡片」新增</div>';
  }

  /* ------------------------ 明细表 ------------------------ */
  function cellHTML(r, f) {
    var v = r[f.key];
    if (v == null || v === '') return '<span style="opacity:.35">—</span>';
    if (f.key === 'status') return '<span class="tag s-' + esc(String(v)) + '">' + esc(v) + '</span>';
    if (f.type === 'number') return '<span>' + money(v) + '</span>';
    if (f.type === 'datetime' || f.type === 'date') return '<span class="cell-clip" title="' + esc(v) + '">' + esc(String(v).replace('T', ' ')) + '</span>';
    if (f.type === 'select') return '<span class="tag">' + esc(v) + '</span>';
    return '<span class="cell-clip" title="' + esc(v) + '">' + esc(v) + '</span>';
  }

  function renderTable() {
    var cols = S.fields.filter(function (f) { return f.listable && S.hiddenCols.indexOf(f.key) < 0; });
    $('#tableHead').innerHTML = '<tr><th style="width:78px">编号</th>' + cols.map(function (f) {
      var mark = S.sort.key === f.key ? '<span class="sort-mark">' + (S.sort.order === 'asc' ? '▲' : '▼') + '</span>' : '';
      return '<th data-sort="' + esc(f.key) + '" class="' + (S.sort.key === f.key ? 'sorted' : '') + '" style="min-width:' + (f.width || 120) + 'px">' + esc(f.label) + mark + '</th>';
    }).join('') + '</tr>';

    var start = (S.page - 1) * S.pageSize;
    var pageRows = S.filtered.slice(start, start + S.pageSize);
    $('#tableBody').innerHTML = pageRows.map(function (r) {
      return '<tr data-id="' + esc(r.id) + '"><td class="cell-id">' + esc(r.id) + '</td>' +
        cols.map(function (f) { return '<td>' + cellHTML(r, f) + '</td>'; }).join('') + '</tr>';
    }).join('') || '<tr><td colspan="' + (cols.length + 1) + '"><div class="empty-state">没有匹配的客户记录<small>试试重置筛选条件</small></div></td></tr>';

    $('#tableCount').textContent = S.filtered.length + ' 条';
    var pages = Math.max(1, Math.ceil(S.filtered.length / S.pageSize));
    var buttons = '<button data-page="' + (S.page - 1) + '"' + (S.page <= 1 ? ' disabled' : '') + '>上一页</button>';
    var from = Math.max(1, S.page - 2), to = Math.min(pages, from + 4);
    from = Math.max(1, to - 4);
    for (var i = from; i <= to; i++) buttons += '<button data-page="' + i + '" class="' + (i === S.page ? 'cur' : '') + '">' + i + '</button>';
    buttons += '<button data-page="' + (S.page + 1) + '"' + (S.page >= pages ? ' disabled' : '') + '>下一页</button>';
    $('#pager').innerHTML = '<div class="pager-info">第 ' + S.page + ' / ' + pages + ' 页 · 显示 ' + (pageRows.length ? start + 1 : 0) + '-' + (start + pageRows.length) + ' 条</div>' +
      '<div class="pager-buttons">' + buttons + '</div>';
  }

  /* ------------------------ 抽屉 ------------------------ */
  function openDrawer(title, html) {
    $('#drawerTitle').textContent = title;
    $('#drawerBody').innerHTML = html;
    $('#drawer').classList.add('open');
    $('#mask').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    if (S.forcePassword) return; // 强制改密未完成时不允许关闭
    $('#drawer').classList.remove('open');
    $('#mask').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
  }

  function groupFields() {
    var groups = {};
    S.fields.forEach(function (f) { (groups[f.group || '其他'] = groups[f.group || '其他'] || []).push(f); });
    return groups;
  }

  function inputHTML(f, value) {
    var v = value == null ? '' : String(value);
    var attrs = 'class="form-control" name="' + esc(f.key) + '" id="fld_' + esc(f.key) + '"';
    var body;
    if (f.type === 'textarea') {
      body = '<textarea ' + attrs + ' rows="3" placeholder="' + esc(f.placeholder || '') + '">' + esc(v) + '</textarea>';
    } else if (f.type === 'select' || f.type === 'tags') {
      var opts = (f.options || []).slice();
      if (v && opts.indexOf(v) < 0) opts.push(v);
      body = '<input ' + attrs + ' list="dl_' + esc(f.key) + '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '可选择或自行输入') + '">' +
        '<datalist id="dl_' + esc(f.key) + '">' + opts.map(function (o) { return '<option value="' + esc(o) + '"></option>'; }).join('') + '</datalist>';
    } else if (f.type === 'number') {
      body = '<input ' + attrs + ' type="number" step="any" value="' + esc(v) + '" placeholder="' + esc(f.unit || '') + '">';
    } else if (f.type === 'datetime') {
      body = '<input ' + attrs + ' type="datetime-local" value="' + esc(v.slice(0, 16)) + '">';
    } else if (f.type === 'date') {
      body = '<input ' + attrs + ' type="date" value="' + esc(v.slice(0, 10)) + '">';
    } else {
      body = '<input ' + attrs + ' type="text" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '">';
    }
    return '<div class="form-group' + (f.type === 'textarea' ? ' full' : '') + '">' +
      '<label for="fld_' + esc(f.key) + '">' + esc(f.label) + (f.required ? '<span class="required">*</span>' : '') + '</label>' + body + '</div>';
  }

  function formHTML(row) {
    var groups = groupFields();
    var body = '';
    Object.keys(groups).forEach(function (g) {
      body += '<div class="form-section-title">' + esc(g) + '</div>' +
        groups[g].map(function (f) { return inputHTML(f, row ? row[f.key] : (f.key === 'sourceTime' ? nowLocal() : '')); }).join('');
    });
    return '<form id="customerForm" class="form-grid">' + body +
      '<div class="form-tip">带 <span class="required">*</span> 为必填项。这里只显示你的账号有权查看的字段。</div>' +
      '<div class="form-actions"><button type="button" class="btn ghost" data-act="cancel">取消</button>' +
      '<button type="submit" class="btn primary">' + (row ? '保存修改' : '新增客户') + '</button></div></form>';
  }

  function nowLocal() {
    var d = new Date();
    return dateStr(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function showCustomerForm(id) {
    if (!guard(id ? 'canEdit' : 'canCreate')) return;
    var row = id ? S.customers.find(function (r) { return r.id === id; }) : null;
    openDrawer(row ? '编辑客户 · ' + row.id : '新增客户', formHTML(row));
    var form = $('#customerForm');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var payload = {};
      S.fields.forEach(function (f) {
        var el = form.elements[f.key];
        payload[f.key] = el ? el.value : '';
      });
      try {
        if (id) await api('/api/customers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/api/customers', { method: 'POST', body: JSON.stringify(payload) });
        closeDrawer();
        await loadData();
        renderAll();
        toast(id ? '客户信息已更新' : '客户已新增');
      } catch (err) { toast(err.message, true); }
    });
  }

  function showDetail(id) {
    var r = S.customers.find(function (x) { return x.id === id; });
    if (!r) return;
    var groups = groupFields();
    var html = Object.keys(groups).map(function (g) {
      return '<div class="detail-group"><h4>' + esc(g) + '</h4>' +
        groups[g].map(function (f) {
          var v = r[f.key];
          return '<div class="detail-row"><div class="k">' + esc(f.label) + '</div><div class="v">' +
            esc(v == null || v === '' ? '—' : String(v).replace('T', ' ')) + '</div></div>';
        }).join('') + '</div>';
    }).join('');
    html += '<div class="detail-group"><h4>系统信息</h4>' +
      ['id', 'createdAt', 'updatedAt'].map(function (k) {
        return '<div class="detail-row"><div class="k">' + esc(k) + '</div><div class="v">' + esc(String(r[k] || '—').replace('T', ' ')) + '</div></div>';
      }).join('') + '</div>';
    var actions = '';
    if (can('canDelete')) actions += '<button class="btn danger" data-act="del-customer" data-id="' + esc(id) + '">删除</button>';
    if (can('canEdit')) actions += '<button class="btn primary" data-act="edit-customer" data-id="' + esc(id) + '">编辑此客户</button>';
    if (actions) html += '<div style="display:flex;gap:8px;justify-content:flex-end">' + actions + '</div>';
    openDrawer('客户档案 · ' + id, html);
  }

  /* ------------------------ 字段管理 ------------------------ */
  function showFieldManager() {
    if (!guard('canManageFields')) return;
    var html = '<div class="docs-block"><h4>已配置字段（' + S.fields.length + '）</h4>' +
      S.fields.map(function (f) {
        return '<div class="field-row"><div class="fr-main"><strong>' + esc(f.label) + '</strong><span>' + esc(f.key) + '</span>' +
          '<span class="fr-meta">' + esc(f.type) + ' · ' + esc(f.group || '其他') + ' · ' +
          (f.aggregatable === false ? '不参与统计' : '可统计') + (f.builtin ? ' · 内置' : ' · 自定义') + '</span></div>' +
          (f.builtin ? '' : '<button class="btn sm danger" data-act="del-field" data-key="' + esc(f.key) + '">删除</button>') + '</div>';
      }).join('') + '</div>';

    html += '<div class="docs-block"><h4>新增统计字段</h4>' +
      '<form id="newFieldForm" class="form-grid">' +
      '<div class="form-group"><label>字段 key（英文，唯一）<span class="required">*</span></label><input class="form-control" name="key" required placeholder="例如：industry" pattern="[a-zA-Z][a-zA-Z0-9_]{0,30}"></div>' +
      '<div class="form-group"><label>显示名称<span class="required">*</span></label><input class="form-control" name="label" required placeholder="例如：所属行业"></div>' +
      '<div class="form-group"><label>字段类型</label><select class="form-control" name="type">' +
      [['text', '单行文本'], ['textarea', '多行文本'], ['select', '下拉选项'], ['number', '数值'], ['date', '日期'], ['datetime', '日期时间'], ['tags', '多标签']].map(function (t) {
        return '<option value="' + t[0] + '">' + t[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="form-group"><label>表单分组</label><input class="form-control" name="group" value="自定义"></div>' +
      '<div class="form-group full"><label>候选项（下拉/标签类型，英文逗号分隔）</label><input class="form-control" name="options" placeholder="制造,零售,金融,教育"></div>' +
      '<div class="form-group"><label>默认图表</label><select class="form-control" name="chart">' +
      [['bar', '条形图'], ['donut', '环形图'], ['line', '趋势图'], ['keywords', '关键词词云'], ['bucket', '数值分桶']].map(function (t) {
        return '<option value="' + t[0] + '">' + t[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="form-group"><label>其他属性</label><div class="checkbox-list" style="grid-template-columns:1fr">' +
      '<label><input type="checkbox" name="listable" checked> 显示在明细表</label>' +
      '<label><input type="checkbox" name="filterable" checked> 生成筛选项</label>' +
      '<label><input type="checkbox" name="aggregatable" checked> 可用于统计卡片</label></div></div>' +
      '<div class="form-tip">新增字段默认不对员工可见，需要管理员在「用户管理 → 授权」中勾选。</div>' +
      '<div class="form-actions"><button type="button" class="btn ghost" data-act="cancel">取消</button><button type="submit" class="btn primary">新增字段</button></div></form></div>';
    openDrawer('字段管理 · 扩展统计维度', html);

    $('#newFieldForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var el = e.target.elements;
      var payload = {
        key: el.key.value.trim(),
        label: el.label.value.trim(),
        type: el.type.value,
        group: el.group.value.trim() || '自定义',
        options: el.options.value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
        chart: el.chart.value,
        listable: el.listable.checked,
        filterable: el.filterable.checked,
        aggregatable: el.aggregatable.checked
      };
      try {
        await api('/api/fields', { method: 'POST', body: JSON.stringify(payload) });
        await loadData();
        renderAll();
        showFieldManager();
        toast('字段「' + payload.label + '」已添加，可在用户授权中分配给员工');
      } catch (err) { toast(err.message, true); }
    });
  }

  /* ------------------------ 用户管理 / 授权 ------------------------ */
  function userFormHTML(u) {
    var isAdmin = u && u.role === 'admin';
    var p = u ? u.permissions : { fields: [], scope: 'own', canExport: false, canCreate: false, canEdit: true, canDelete: false, canManageFields: false, canManageUsers: false };
    var id = u ? u.id : '';
    var html = '<form id="userForm" class="form-grid" data-id="' + esc(id) + '">';
    html += '<div class="form-section-title">基本信息</div>';
    html += '<div class="form-group"><label>用户名' + (u ? '' : ' <span class="required">*</span>') + '</label>' +
      (u ? '<input class="form-control" value="' + esc(u.username) + '" disabled>' : '<input class="form-control" name="username" required placeholder="例如：staff01">') + '</div>';
    html += '<div class="form-group"><label>显示名称</label><input class="form-control" name="displayName" value="' + esc(u ? u.displayName : '') + '" placeholder="例如：张敏"></div>';
    html += '<div class="form-group"><label>' + (u ? '重置密码（留空表示不变）' : '初始密码 <span class="required">*</span>') + '</label>' +
      '<input class="form-control" name="password" type="password" ' + (u ? '' : 'required ') + 'placeholder="至少 6 位"></div>';
    html += '<div class="form-group"><label>跟单人员（用于「仅本人」数据范围）</label>' +
      '<input class="form-control" name="ownerName" value="' + esc(u ? u.ownerName : '') + '" placeholder="需与客户数据中的跟单人员一致"></div>';
    if (isAdmin) {
      html += '<div class="form-tip">管理员始终拥有全部权限，无需配置。为保证系统可控，管理员账号不可禁用或删除。</div>';
    } else {
      html += '<div class="form-section-title">数据范围</div>';
      html += '<div class="form-group full"><select class="form-control" name="scope">' +
        '<option value="own"' + (p.scope === 'own' ? ' selected' : '') + '>仅本人跟单的客户</option>' +
        '<option value="all"' + (p.scope === 'all' ? ' selected' : '') + '>全部客户</option></select></div>';
      html += '<div class="form-section-title">可查看信息（只勾选允许该员工看到的字段）</div>';
      html += '<div class="form-group full"><div style="display:flex;gap:8px;margin-bottom:9px">' +
        '<button type="button" class="btn sm ghost" data-act="select-all-fields">全选字段</button>' +
        '<button type="button" class="btn sm ghost" data-act="clear-fields">清空字段</button></div>' +
        '<div class="perm-grid">' + S.fields.map(function (f) {
          return '<label><input type="checkbox" data-role="perm-field" value="' + esc(f.key) + '"' + (p.fields.indexOf(f.key) >= 0 ? ' checked' : '') + '>' +
            esc(f.label) + ' <span>' + esc(f.key) + '</span></label>';
        }).join('') + '</div></div>';
      html += '<div class="form-section-title">操作权限</div>';
      html += '<div class="form-group full"><div class="perm-grid">' + PERM_LABELS.map(function (x) {
        return '<label><input type="checkbox" name="' + x[0] + '"' + (p[x[0]] ? ' checked' : '') + '>' + x[1] + '</label>';
      }).join('') + '</div></div>';
    }
    html += '<div class="form-tip">保存后无需员工重新登录，下一次请求即按新权限生效。</div>';
    html += '<div class="form-actions"><button type="button" class="btn ghost" data-act="cancel">取消</button>' +
      '<button type="submit" class="btn primary">' + (u ? '保存授权' : '创建员工') + '</button></div></form>';
    return html;
  }

  function bindUserForm() {
    var form = $('#userForm');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var el = form.elements;
      var id = form.dataset.id;
      var body = {
        displayName: el.displayName.value.trim(),
        ownerName: el.ownerName.value.trim()
      };
      if (el.scope) {
        var permissions = {
          fields: Array.prototype.slice.call(form.querySelectorAll('[data-role="perm-field"]:checked')).map(function (x) { return x.value; }),
          scope: el.scope.value
        };
        PERM_LABELS.forEach(function (x) { permissions[x[0]] = !!(el[x[0]] && el[x[0]].checked); });
        body.permissions = permissions;
      }
      try {
        if (id) {
          await api('/api/users/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
          toast('账号信息已保存');
        } else {
          body.username = el.username.value.trim();
          body.password = el.password.value;
          await api('/api/users', { method: 'POST', body: JSON.stringify(body) });
          toast('员工已创建并完成授权');
        }
        await showUserManager();
      } catch (err) { toast(err.message, true); }
    });
  }

  async function showUserManager() {
    if (!guard('canManageUsers')) return;
    var d;
    try { d = await api('/api/users'); } catch (err) { toast(err.message, true); return; }
    var rows = d.users.map(function (u) {
      var p = u.permissions || {};
      var desc = u.role === 'admin' ? '全部权限' :
        ((p.scope === 'own' ? '仅本人跟单' : '全部客户') + ' · ' + p.fields.length + ' 个字段' + (p.canExport ? ' · 可导出' : ''));
      return '<div class="user-row"><div class="user-main"><strong>' + esc(u.displayName) + '</strong>' +
        '<span class="tag">' + esc(u.username) + '</span><span class="tag ' + (u.role === 'admin' ? 's-已成交' : 's-新线索') + '">' +
        (u.role === 'admin' ? '管理员' : '员工') + '</span>' +
        '<span class="fr-meta">' + esc(desc) + (!u.enabled ? ' · 已禁用' : '') + '</span></div><div class="user-ops">' +
        '<button class="btn sm ghost" data-act="edit-user" data-id="' + esc(u.id) + '">授权</button>' +
        '<button class="btn sm ghost" data-act="reset-pwd" data-id="' + esc(u.id) + '">重置密码</button>' +
        (u.role === 'admin' ? '' :
          '<button class="btn sm ghost" data-act="toggle-user" data-id="' + esc(u.id) + '" data-enabled="' + (u.enabled ? '0' : '1') + '">' + (u.enabled ? '禁用' : '启用') + '</button>' +
          '<button class="btn sm danger" data-act="del-user" data-id="' + esc(u.id) + '">删除</button>') +
        '</div></div>';
    }).join('');
    var html = '<div class="docs-block"><h4>账号列表（' + d.users.length + '）</h4><div class="user-list">' + rows + '</div></div>' +
      '<div class="docs-block"><h4>新建员工并授权</h4>' + userFormHTML(null) + '</div>';
    openDrawer('用户管理 · 权限分配', html);
    bindUserForm();
  }

  async function showUserEdit(id) {
    try {
      var d = await api('/api/users');
      var u = d.users.find(function (x) { return x.id === id; });
      if (!u) return;
      openDrawer('编辑授权 · ' + u.username, userFormHTML(u));
      bindUserForm();
    } catch (err) { toast(err.message, true); }
  }

  function showResetPassword(id) {
    openDrawer('重置密码', '<form id="resetPwdForm" class="form-grid">' +
      '<div class="form-group full"><label>新密码（至少 6 位）</label><input class="form-control" name="password" type="password" minlength="6" required></div>' +
      '<div class="form-tip">重置后该员工的登录会话立即失效，需要用新密码重新登录。</div>' +
      '<div class="form-actions"><button type="button" class="btn ghost" data-act="cancel">取消</button><button type="submit" class="btn primary">重置</button></div></form>');
    $('#resetPwdForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        await api('/api/users/' + encodeURIComponent(id) + '/reset-password', {
          method: 'POST', body: JSON.stringify({ password: e.target.elements.password.value })
        });
        closeDrawer();
        toast('密码已重置，该员工需重新登录');
      } catch (err) { toast(err.message, true); }
    });
  }

  function showPasswordForm(force) {
    var tip = force
      ? '<div class="form-tip" style="color:var(--warning)">当前账号仍在使用初始密码，出于数据安全必须先修改后才能查看客户信息。</div>'
      : '<div class="form-tip">修改后其他设备上的登录会话会立即失效。</div>';
    var actions = force
      ? '<div class="form-actions"><button type="submit" class="btn primary">设置新密码并进入</button></div>'
      : '<div class="form-actions"><button type="button" class="btn ghost" data-act="cancel">取消</button><button type="submit" class="btn primary">保存</button></div>';
    openDrawer(force ? '首次登录 · 必须修改初始密码' : '修改密码',
      '<form id="passwordForm" class="form-grid">' +
      '<div class="form-group full"><label>当前密码</label><input class="form-control" name="oldPassword" type="password" required autocomplete="current-password"></div>' +
      '<div class="form-group full"><label>新密码（至少 8 位，建议含字母、数字与符号）</label><input class="form-control" name="newPassword" type="password" minlength="8" required autocomplete="new-password"></div>' +
      '<div class="form-group full"><label>确认新密码</label><input class="form-control" name="confirmPassword" type="password" minlength="8" required autocomplete="new-password"></div>' +
      tip + actions + '</form>');
    S.forcePassword = !!force;
    if (force) {
      // 彻底隔离：隐藏主界面（含退出等入口），遮罩不可点，抽屉不可关，杜绝绕过
      var app = document.querySelector('.app');
      if (app) app.style.visibility = 'hidden';
      $('#mask').classList.add('locked');
      $('#drawerClose').style.visibility = 'hidden';
    } else {
      var app2 = document.querySelector('.app');
      if (app2) app2.style.visibility = '';
      $('#mask').classList.remove('locked');
      $('#drawerClose').style.visibility = '';
    }
    $('#passwordForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var el = e.target.elements;
      var next = el.newPassword.value;
      if (next !== el.confirmPassword.value) return toast('两次输入的新密码不一致', true);
      if (next.length < 8) return toast('新密码至少 8 位', true);
      try {
        await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword: el.oldPassword.value, newPassword: next }) });
        S.forcePassword = false;
        document.querySelector('.app').style.visibility = '';
        $('#mask').classList.remove('locked');
        $('#drawerClose').style.visibility = '';
        closeDrawer();
        toast('密码已修改');
        await loadData();
        renderAll();
      } catch (err) { toast(err.message, true); }
    });
  }

  /* ------------------------ 添加统计卡片 ------------------------ */
  function showAddCard() {
    var html = '<div class="docs-block"><p>选择一个字段生成统计图表。这里只列出你的账号有权查看的字段。</p></div><div class="api-list">';
    S.fields.filter(function (f) { return f.aggregatable !== false; }).forEach(function (f) {
      html += '<div class="field-row"><div class="fr-main"><strong>' + esc(f.label) + '</strong>' +
        '<span class="fr-meta">' + esc(f.key) + ' · ' + esc(f.type) + ' · 推荐图表：' +
        ({ bar: '条形', donut: '环形', line: '趋势', keywords: '词云', bucket: '分桶' }[f.chart] || '条形') + '</span></div>' +
        '<button class="btn sm soft" data-act="add-card" data-key="' + esc(f.key) + '">＋ 添加</button></div>';
    });
    html += '</div>';
    openDrawer('添加统计卡片', html);
  }

  /* ------------------------ 接口说明 ------------------------ */
  var LOCAL_DOCS = {
    endpoints: [
      { method: 'POST', path: '/api/auth/login', desc: '登录' },
      { method: 'GET', path: '/api/bootstrap', desc: '按权限返回字段与数据' },
      { method: 'GET', path: '/api/stats', desc: '任意可见字段聚合' },
      { method: 'GET', path: '/api/export', desc: '导出 CSV（需授权）' },
      { method: 'GET', path: '/api/users', desc: '用户列表（管理员/授权者）' },
      { method: 'GET', path: '/api/backup', desc: '导出全量快照（仅管理员）' },
      { method: 'POST', path: '/api/restore', desc: '从快照恢复（仅管理员）' },
      { method: 'GET', path: '/api/docs', desc: '完整接口清单' }
    ],
    extendSteps: [
      '在 public/config/fields.json 中新增字段，或在页面「字段管理」里新增。',
      '管理员在「用户管理 → 授权」中勾选字段，员工才可以看到。',
      '未授权字段不会出现在接口返回、表格、统计、导出中，服务端强制过滤。',
      '外部系统先 POST /api/auth/login 拿 Cookie，再调用 /api/stats?groupBy=<字段 key>。'
    ],
    get examples() {
      var base = location.origin;
      return [
        'curl -c cookies.txt -X POST ' + base + '/api/auth/login -H "Content-Type: application/json" -d \'{"username":"<你的用户名>","password":"<你的密码>"}\'',
        'curl -b cookies.txt "' + base + '/api/stats?groupBy=channel"',
        'curl -b cookies.txt "' + base + '/api/bootstrap"'
      ];
    }
  };

  function showDocs() {
    var d = S.docs || LOCAL_DOCS;
    var html = '<div class="docs-block"><h4>扩展方式与权限</h4><ol>' +
      (d.extendSteps || []).map(function (s) { return '<li>' + esc(String(s).replace(/^\d+\.\s*/, '')) + '</li>'; }).join('') + '</ol></div>';
    if (d.permissionModel) {
      html += '<div class="docs-block"><h4>权限模型</h4><div class="code-block">' + esc(JSON.stringify(d.permissionModel, null, 2)) + '</div></div>';
    }
    html += '<div class="docs-block"><h4>REST 接口（均需登录）</h4><div class="api-list">' +
      (d.endpoints || []).map(function (e) {
        return '<div class="api-item"><span class="method">' + esc(e.method) + '</span><span class="path">' + esc(e.path) + '</span><span class="desc">' + esc(e.desc) + '</span></div>';
      }).join('') + '</div></div>';
    // 示例固定使用浏览器当前公网域名，避免云端沙箱反向代理把内部域名写进接口文档
    html += '<div class="docs-block"><h4>调用示例</h4><div class="code-block">' + LOCAL_DOCS.examples.map(esc).join('\n') + '</div></div>';
    html += '<div class="docs-block"><h4>字段定义模板</h4><div class="code-block">' +
      esc(JSON.stringify(d.fieldTemplate || { key: 'newField', label: '新字段', type: 'select', options: ['A', 'B'], listable: true, filterable: true, aggregatable: true, chart: 'bar' }, null, 2)) +
      '</div><p style="margin-top:8px">客户、字段与账号由服务端存储层持久化（当前：<strong>' + esc(storageLabel()) + '</strong>），不对外静态暴露；会话密钥为随机生成。' + esc(storageTip()) + '</p></div>';
    if (d.backup) html += '<div class="docs-block"><h4>数据持久化</h4><p>' + esc(d.backup) + '</p></div>';
    openDrawer('接口与扩展说明', html);
  }

  /* ------------------------ 列设置 ------------------------ */
  function showColumns() {
    var html = '<div class="docs-block"><p>勾选需要在明细表中展示的字段（保存在本机浏览器，且不会超出账号权限）。</p></div>' +
      '<div class="checkbox-list">' + S.fields.map(function (f) {
        return '<label><input type="checkbox" data-col="' + esc(f.key) + '"' + (S.hiddenCols.indexOf(f.key) < 0 ? ' checked' : '') + '>' + esc(f.label) + '</label>';
      }).join('') + '</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn primary" data-act="close">完成</button></div>';
    openDrawer('列设置', html);
  }

  /* ------------------------ 导入 / 导出 ------------------------ */
  function buildQuery() {
    var p = new URLSearchParams();
    if (S.filters.from) p.set('from', S.filters.from);
    if (S.filters.to) p.set('to', S.filters.to);
    if (S.filters.keyword.trim()) p.set('keyword', S.filters.keyword.trim());
    Object.keys(S.filters.selects).forEach(function (k) {
      if (S.filters.selects[k]) p.set('f_' + k, S.filters.selects[k]);
    });
    p.set('sort', S.sort.key);
    p.set('order', S.sort.order);
    return p.toString();
  }

  async function exportCSV() {
    if (!guard('canExport')) return;
    try {
      var res = await fetch('/api/export?' + buildQuery(), { credentials: 'same-origin' });
      if (!res.ok) {
        var d = await res.json().catch(function () { return {}; });
        throw new Error(d.error || '导出失败');
      }
      var blob = await res.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '客户数据_' + dateStr(new Date()) + '.csv';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('已导出 ' + S.filtered.length + ' 条记录（仅包含有权查看的字段）');
    } catch (err) { toast(err.message, true); }
  }

  function parseCSV(text) {
    var rows = [], row = [], cell = '', quoted = false;
    text = text.replace(/^\ufeff/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    if (rows.length < 2) return [];
    var head = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).filter(function (r) { return r.some(function (c) { return String(c).trim(); }); })
      .map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i] == null ? '' : r[i]; }); return o; });
  }

  async function importFile(file) {
    if (!guard('canCreate')) return;
    try {
      var text = await file.text();
      var items = /\.csv$/i.test(file.name) ? parseCSV(text) : JSON.parse(text);
      if (!Array.isArray(items)) items = items.items || [];
      if (!items.length) throw new Error('文件中没有可导入的记录');
      var labelMap = {};
      S.fields.forEach(function (f) { labelMap[f.label] = f.key; });
      items = items.map(function (r) {
        var o = {};
        Object.keys(r).forEach(function (k) { o[labelMap[k] || k] = r[k]; });
        return o;
      });
      var res = await api('/api/import', { method: 'POST', body: JSON.stringify({ items: items, mode: 'append' }) });
      await loadData();
      renderAll();
      toast('成功导入 ' + items.length + ' 条，当前共 ' + res.total + ' 条');
    } catch (err) { toast('导入失败：' + err.message, true); }
  }

  /* ------------------------ 数据管理：备份 / 恢复 ------------------------ */
  function showDataManager() {
    if (!S.me) { toast('请先登录', true); return; }
    var isAdminUser = isAdmin();
    var html = '<div class="docs-block"><p>客户、字段与账号当前持久化在 <strong>' + esc(storageLabel()) + '</strong>。' +
      'CSV 导出只含可见字段；这里的完整备份包含全部客户、字段配置与账号，可用于迁移或容灾恢复。' + esc(storageTip()) + '</p></div>';
    html += '<div class="data-manager-grid">' +
      '<div class="dm-card"><h4>① 导出完整备份</h4><p>下载含客户明细、字段配置、账号与权限的 JSON 快照（仅管理员）。请存放在安全位置。</p>' +
      '<button class="btn primary" data-act="dm-backup"' + (isAdminUser ? '' : ' disabled') + '>下载备份快照</button></div>' +
      '<div class="dm-card"><h4>② 从备份恢复</h4><p>选择此前导出的快照恢复。会覆盖当前全部数据，操作不可撤销。恢复后请重新登录。</p>' +
      '<button class="btn soft" data-act="dm-restore"' + (isAdminUser ? '' : ' disabled') + '>选择快照并恢复</button></div>' +
      '</div>';
    if (!isAdminUser) html += '<p class="dm-note">导出与恢复仅管理员可用；当前账号可继续使用页面上的「导出 CSV」。</p>';
    html += '<div class="docs-block" style="margin-top:16px"><h4>当前实例数据概况</h4><div class="code-block">' +
      esc(JSON.stringify({ 客户记录: S.customers.length, 可见字段: S.fields.length, 当前账号: S.me.displayName }, null, 2)) + '</div></div>';
    openDrawer('数据管理与持久化', html);
  }

  async function downloadBackup() {
    try {
      var res = await fetch('/api/backup', { credentials: 'same-origin' });
      if (!res.ok) {
        var d = await res.json().catch(function () { return {}; });
        throw new Error(d.error || '导出失败');
      }
      var blob = await res.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '驾驶舱完整备份_' + dateStr(new Date()) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('完整备份已下载，请妥善保管');
    } catch (err) { toast(err.message, true); }
  }

  async function restoreBackup(file) {
    try {
      var text = await file.text();
      var snapshot = JSON.parse(text);
      if (!snapshot || snapshot.format !== 'cid-dashboard-backup') {
        throw new Error('不是有效的驾驶舱备份文件');
      }
      if (!confirm('恢复会覆盖当前全部客户、字段与账号数据，且不可撤销。确定继续吗？')) return;
      var d = await api('/api/restore', { method: 'POST', body: text });
      toast('恢复完成，正在重新加载…');
      await loadData();
      renderAll();
      closeDrawer();
      // 令牌版本可能已变化，稍后探测会话；若失效会回到登录页
      setTimeout(function () { checkSession(); }, 400);
    } catch (err) { toast('恢复失败：' + err.message, true); }
  }

  /* ------------------------ 渲染总入口 ------------------------ */
  function renderAll() {
    applyFilters();
    renderFilterSelects();
    renderFilterMeta();
    renderKPIs();
    renderCards();
    renderTable();
    $('#footerTime').textContent = '数据更新：' + new Date().toLocaleString('zh-CN');
  }

  /* ------------------------ 事件绑定 ------------------------ */
  function bindEvents() {
    $('#loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      doLogin($('#loginUser').value.trim(), $('#loginPass').value);
    });
    $('#loginUser').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#loginPass').focus(); });
    $('#btnLogout').addEventListener('click', logout);
    $('#btnPassword').addEventListener('click', showPasswordForm);
    $('#btnUsers').addEventListener('click', showUserManager);

    $('#mask').addEventListener('click', closeDrawer);
    $('#drawerClose').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

    $('#btnAdd').addEventListener('click', function () { showCustomerForm(null); });
    $('#btnFields').addEventListener('click', showFieldManager);
    $('#btnData').addEventListener('click', showDataManager);
    $('#btnDocs').addEventListener('click', showDocs);
    $('#btnColumns').addEventListener('click', showColumns);
    $('#btnAddCard').addEventListener('click', showAddCard);
    $('#btnExport').addEventListener('click', exportCSV);
    $('#btnImport').addEventListener('click', function () { if (guard('canCreate')) $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', function (e) {
      if (e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#restoreInput').addEventListener('change', function (e) {
      if (e.target.files[0]) restoreBackup(e.target.files[0]);
      e.target.value = '';
    });
    $('#btnTheme').addEventListener('click', function () {
      S.theme = S.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = S.theme;
      LS.set('theme', S.theme);
    });
    $('#btnResetCards').addEventListener('click', function () {
      S.cards = DEFAULT_CARDS.filter(function (c) { return !!field(c.field); }).map(function (c) { return Object.assign({}, c); });
      saveLayout();
      renderCards();
      toast('已恢复默认卡片布局');
    });

    $('#quickRange').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-days]');
      if (!btn) return;
      var days = Number(btn.dataset.days);
      S.quick = days;
      this.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      S.filters.from = days ? daysAgo(days - 1) : '';
      S.filters.to = days ? dateStr(new Date()) : '';
      $('#dateFrom').value = S.filters.from;
      $('#dateTo').value = S.filters.to;
      S.page = 1;
      renderAll();
    });

    function onDateChange() {
      S.filters.from = $('#dateFrom').value;
      S.filters.to = $('#dateTo').value;
      $('#quickRange').querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      S.page = 1;
      renderAll();
    }
    $('#dateFrom').addEventListener('change', onDateChange);
    $('#dateTo').addEventListener('change', onDateChange);

    var searchTimer;
    $('#keyword').addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      var v = e.target.value;
      searchTimer = setTimeout(function () { S.filters.keyword = v; S.page = 1; renderAll(); }, 220);
    });
    $('#btnReset').addEventListener('click', function () {
      S.filters = { from: '', to: '', keyword: '', selects: {} };
      $('#dateFrom').value = ''; $('#dateTo').value = ''; $('#keyword').value = '';
      $('#quickRange').querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.dataset.days === '0'); });
      S.page = 1;
      renderAll();
    });
    $('#dynamicFilters').addEventListener('change', function (e) {
      var sel = e.target.closest('select[data-filter]');
      if (!sel) return;
      S.filters.selects[sel.dataset.filter] = sel.value;
      S.page = 1;
      renderAll();
    });
    $('#pageSize').addEventListener('change', function (e) {
      S.pageSize = Number(e.target.value);
      S.page = 1;
      renderTable();
    });

    $('#tableHead').addEventListener('click', function (e) {
      var th = e.target.closest('th[data-sort]');
      if (!th) return;
      var k = th.dataset.sort;
      if (S.sort.key === k) S.sort.order = S.sort.order === 'asc' ? 'desc' : 'asc';
      else S.sort = { key: k, order: 'desc' };
      applyFilters();
      renderTable();
      renderKPIs();
    });
    $('#tableBody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-id]');
      if (tr) showDetail(tr.dataset.id);
    });
    $('#pager').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-page]');
      if (!btn || btn.disabled) return;
      S.page = Number(btn.dataset.page);
      renderTable();
      window.scrollTo({ top: $('#chartGrid').offsetTop + $('#chartGrid').offsetHeight, behavior: 'smooth' });
    });

    $('#chartGrid').addEventListener('change', function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var card = S.cards.find(function (c) { return c.id === el.dataset.id; });
      if (!card) return;
      if (el.dataset.act === 'type') { card.type = el.value; if (card.type === 'line' && !card.grain) card.grain = 'week'; }
      if (el.dataset.act === 'grain') card.grain = el.value;
      if (el.dataset.act === 'limit') card.limit = Number(el.value);
      saveLayout();
      renderCards();
    });
    $('#chartGrid').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act="remove"]');
      if (!btn) return;
      S.cards = S.cards.filter(function (c) { return c.id !== btn.dataset.id; });
      saveLayout();
      renderCards();
    });

    // 抽屉内的所有交互统一委托
    $('#drawerBody').addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      var id = btn.dataset.id;
      if (act === 'dm-backup') return downloadBackup();
      if (act === 'dm-restore') return $('#restoreInput').click();
      if (act === 'cancel' || act === 'close') return closeDrawer();
      if (act === 'select-all-fields' || act === 'clear-fields') {
        var checked = act === 'select-all-fields';
        document.querySelectorAll('[data-role="perm-field"]').forEach(function (x) { x.checked = checked; });
        return;
      }
      if (act === 'edit-user') return showUserEdit(id);
      if (act === 'reset-pwd') return showResetPassword(id);
      if (act === 'toggle-user') {
        try {
          await api('/api/users/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ enabled: btn.dataset.enabled === '1' }) });
          await showUserManager();
          toast(btn.dataset.enabled === '1' ? '账号已启用' : '账号已禁用');
        } catch (err) { toast(err.message, true); }
        return;
      }
      if (act === 'del-user') {
        if (!confirm('确定删除该员工账号吗？此操作不可撤销。')) return;
        try {
          await api('/api/users/' + encodeURIComponent(id), { method: 'DELETE' });
          await showUserManager();
          toast('员工账号已删除');
        } catch (err) { toast(err.message, true); }
        return;
      }
      if (act === 'edit-customer') return showCustomerForm(id);
      if (act === 'del-customer') {
        if (!guard('canDelete')) return;
        if (!confirm('确定删除客户 ' + id + ' 吗？此操作不可撤销。')) return;
        try {
          await api('/api/customers/' + encodeURIComponent(id), { method: 'DELETE' });
          closeDrawer(); await loadData(); renderAll(); toast('记录已删除');
        } catch (err) { toast(err.message, true); }
        return;
      }
      if (act === 'del-field') {
        if (!guard('canManageFields')) return;
        if (!confirm('删除字段「' + btn.dataset.key + '」？已存在的客户数据不会被清除。')) return;
        try {
          await api('/api/fields/' + encodeURIComponent(btn.dataset.key), { method: 'DELETE' });
          await loadData(); renderAll(); showFieldManager(); toast('字段已删除');
        } catch (err) { toast(err.message, true); }
        return;
      }
      if (act === 'add-card') {
        var f = field(btn.dataset.key);
        if (!f) return;
        S.cards.push({
          id: 'u' + Date.now().toString(36),
          field: f.key,
          title: f.label + ' 分布',
          type: f.chart === 'keywords' ? 'keywords' : (f.type === 'datetime' || f.type === 'date') ? 'line' : f.chart || 'bar',
          grain: 'week',
          limit: (f.type === 'datetime' || f.type === 'date') ? 0 : 10
        });
        saveLayout();
        renderCards();
        closeDrawer();
        toast('已添加「' + f.label + '」统计卡片');
        return;
      }
    });
    $('#drawerBody').addEventListener('change', function (e) {
      var cb = e.target.closest('input[data-col]');
      if (!cb) return;
      var k = cb.dataset.col;
      S.hiddenCols = S.hiddenCols.filter(function (x) { return x !== k; });
      if (!cb.checked) S.hiddenCols.push(k);
      LS.set('hiddenCols', S.hiddenCols);
      renderTable();
    });
  }

  /* ------------------------ 启动 ------------------------ */
  async function init() {
    document.documentElement.dataset.theme = S.theme;
    bindEvents();
    try {
      var d = await api('/api/health', { silent401: true });
      if (!d.ok) throw new Error('服务未就绪');
      S.health = d;
    } catch (err) {
      $('#loginError').textContent = '无法连接服务，请在项目目录运行 npm start 后刷新页面';
      return;
    }
    await checkSession();
  }

  init();
})();
