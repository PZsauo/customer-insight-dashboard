/* =============================================================
 * charts.js —— 零依赖 SVG 图表
 * 不引入 ECharts / CDN，离线可用；主题颜色通过 CSS class 适配。
 * 所有函数返回 HTML 字符串，由 app.js 插入容器。
 * ============================================================= */
(function (global) {
  'use strict';

  var PALETTE = ['#4c63e6', '#17b8a6', '#f2a03d', '#ec6f9b', '#8b5cf6', '#3b9ae1', '#ef6b5a', '#5ac47c', '#d4a12c', '#7a8ba8'];
  var uid = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clip(s, n) {
    var t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function num(v) { return Number(v || 0).toLocaleString('zh-CN'); }
  function empty(msg) {
    return '<div class="empty-state">暂无数据<small>' + esc(msg || '尝试调整筛选条件或新增客户记录') + '</small></div>';
  }

  /* ---------------- 横向条形图 ---------------- */
  function bar(items, opts) {
    opts = opts || {};
    if (!items || !items.length) return empty();
    var n = items.length;
    var rowH = 27, labelW = 100, valueW = 54, W = 480;
    var barW = W - labelW - valueW - 10;
    var H = n * rowH + 8;
    var max = Math.max.apply(null, items.map(function (i) { return Number(i.value) || 0; })) || 1;
    var rows = items.map(function (it, i) {
      var v = Number(it.value) || 0;
      var y = 4 + i * rowH;
      var w = Math.max(3, (v / max) * barW);
      var color = opts.monochrome ? PALETTE[0] : PALETTE[i % PALETTE.length];
      var tip = esc(it.label) + '：' + num(v);
      return '<g data-tip="' + tip + '"><title>' + tip + '</title>' +
        '<text x="' + (labelW - 9) + '" y="' + (y + 14) + '" text-anchor="end" class="axis-text">' + esc(clip(it.label, 9)) + '</text>' +
        '<rect x="' + labelW + '" y="' + (y + 3) + '" width="' + barW + '" height="14" rx="7" class="bar-track"/>' +
        '<rect x="' + labelW + '" y="' + (y + 3) + '" width="' + w.toFixed(1) + '" height="14" rx="7" class="bar-fill" fill="' + color + '"/>' +
        '<text x="' + (labelW + barW + 8) + '" y="' + (y + 15) + '" class="value-text">' + num(v) + '</text></g>';
    });
    return '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="条形图">' + rows.join('') + '</svg>';
  }

  /* ---------------- 折线 / 面积趋势图 ---------------- */
  function line(items, opts) {
    opts = opts || {};
    if (!items || !items.length) return empty();
    // 通栏卡片用更宽的 viewBox，避免 SVG 按宽度等比放大后过高
    var W = opts.width || 520, H = 216, padL = 40, padR = 14, padT = 16, padB = 30;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var values = items.map(function (i) { return Number(i.value) || 0; });
    var max = Math.max.apply(null, values) || 1;
    var step = items.length > 1 ? plotW / (items.length - 1) : 0;
    var x = function (i) { return padL + i * step; };
    var y = function (v) { return padT + plotH * (1 - v / max); };
    var pts = items.map(function (it, i) { return x(i).toFixed(1) + ',' + y(Number(it.value) || 0).toFixed(1); });
    var gid = 'area-' + (++uid);

    var grid = '', labels = '';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (plotH / 4) * g;
      var gv = Math.round(max * (1 - g / 4));
      grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '" class="grid-line"/>' +
        '<text x="' + (padL - 7) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end" class="axis-text">' + num(gv) + '</text>';
    }
    var every = Math.max(1, Math.ceil(items.length / (W > 800 ? 9 : 6)));
    items.forEach(function (it, i) {
      if (i % every !== 0 && i !== items.length - 1) return;
      var anchor = i === 0 ? 'start' : (i === items.length - 1 ? 'end' : 'middle');
      labels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '" class="axis-text">' + esc(clip(String(it.label).replace(/^\d{4}-/, ''), 10)) + '</text>';
    });
    var dots = items.map(function (it, i) {
      var tip = esc(it.label) + '：' + num(it.value);
      return '<g data-tip="' + tip + '"><title>' + tip + '</title><circle cx="' + x(i).toFixed(1) + '" cy="' + y(Number(it.value) || 0).toFixed(1) + '" r="3" class="line-dot"/></g>';
    });
    var area = '<path d="M ' + x(0).toFixed(1) + ' ' + (padT + plotH) + ' L ' + pts.join(' L ') + ' L ' + x(items.length - 1).toFixed(1) + ' ' + (padT + plotH) + ' Z" fill="url(#' + gid + ')"/>';

    return '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="趋势图">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4c63e6" stop-opacity=".28"/><stop offset="100%" stop-color="#4c63e6" stop-opacity="0"/>' +
      '</linearGradient></defs>' + grid + area +
      '<path class="line-path" d="M ' + pts.join(' L ') + '"/>' + dots.join('') + labels + '</svg>';
  }

  /* ---------------- 环形图 + 图例 ---------------- */
  function donut(items, opts) {
    opts = opts || {};
    if (!items || !items.length) return empty();
    // 只展示 Top N，其余合并为「其他」；中心数字始终是全部数据之和
    var total = items.reduce(function (s, i) { return s + (Number(i.value) || 0); }, 0) || 1;
    var topN = Math.max(2, Math.min(8, Number(opts.limit) || 8));
    var keep = topN - 1;
    var data = items.slice(0, keep);
    if (items.length > keep) {
      var rest = items.slice(keep).reduce(function (s, i) { return s + (Number(i.value) || 0); }, 0);
      if (rest > 0) data.push({ label: '其他', value: rest });
    }
    var cx = 85, cy = 85, r = 60, C = 2 * Math.PI * r;
    var acc = 0;
    var arcs = data.map(function (it, i) {
      var v = Number(it.value) || 0;
      var len = (v / total) * C;
      var seg = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] + '" stroke-width="24" ' +
        'stroke-dasharray="' + Math.max(0, len - 1.5).toFixed(2) + ' ' + (C - Math.max(0, len - 1.5)).toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"><title>' + esc(it.label) + '：' + num(v) + '</title></circle>';
      acc += len;
      return seg;
    });
    var svg = '<svg class="chart-svg donut-svg" viewBox="0 0 170 170" width="170" height="170" role="img" aria-label="环形图">' +
      '<circle cx="85" cy="85" r="60" fill="none" stroke="var(--border)" stroke-width="24"/>' + arcs.join('') +
      '<text x="85" y="82" class="donut-center">' + num(total) + '</text>' +
      '<text x="85" y="100" class="donut-sub">条记录</text></svg>';
    var legend = data.map(function (it, i) {
      var v = Number(it.value) || 0;
      var pct = (v / total * 100).toFixed(1) + '%';
      return '<div class="legend-row"><span class="swatch" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
        '<span class="legend-name" title="' + esc(it.label) + '">' + esc(clip(it.label, 12)) + '</span>' +
        '<span class="legend-val">' + num(v) + '</span><span class="pct">' + pct + '</span></div>';
    }).join('');
    return '<div class="donut-layout">' + svg + '<div class="donut-legend">' + legend + '</div></div>';
  }

  /* ---------------- 关键词标签云 ---------------- */
  function keywords(items, opts) {
    opts = opts || {};
    if (!items || !items.length) return empty('该文本字段暂无可提取的关键词');
    var max = Math.max.apply(null, items.map(function (i) { return Number(i.value) || 0; })) || 1;
    return '<div class="keyword-cloud">' + items.slice(0, 26).map(function (it) {
      var size = 12 + Math.round((Number(it.value) / max) * 9);
      return '<span class="kw" style="font-size:' + size + 'px" title="' + esc(it.label) + '：' + num(it.value) + ' 次">' +
        esc(it.label) + '<em>' + num(it.value) + '</em></span>';
    }).join('') + '</div>';
  }

  function render(type, items, opts) {
    switch (type) {
      case 'line': return line(items, opts);
      case 'donut': return donut(items, opts);
      case 'keywords': return keywords(items, opts);
      case 'bucket': return bar(items, opts);
      default: return bar(items, opts);
    }
  }

  global.Charts = { palette: PALETTE, esc: esc, render: render, bar: bar, line: line, donut: donut, keywords: keywords, empty: empty };
})(window);
