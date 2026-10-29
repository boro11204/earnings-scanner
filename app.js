/* Earnings IV-Crush Scanner dashboard.
   Reads the scanner's Google Sheet live (view-only link, public CSV export).
   No keys, no tracking. Paper trading results. Analysis only, not advice. */
(function () {
  'use strict';

  var SHEET_ID = '1vR2L7P3qNfFPkLSt25euHVW2RNE-U1KOAPh3xTA4Pb8';
  var TABS = { scan: { name: 'Sheet1', gid: '0' }, tracked: { name: 'Tracked', gid: '12103754' } };
  var TZ = 'America/New_York';
  var COMMISSION = 0.50;      // $ per contract, per leg, per side (stock/ETF options)
  var COMMISSION_SPX = 1.07;  // SPX / SPXW
  var REFRESH_MS = 10 * 60 * 1000;

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) {
    if (v == null) return null;
    var s = String(v).replace(/[$,\s]/g, '').replace(/x$/i, '');
    if (s === '' || s === '-') return null;
    var n = Number(s.replace(/%$/, ''));
    return isFinite(n) ? n : null;
  }
  function money(n, signed) {
    if (n == null || !isFinite(n)) return '–';
    var a = Math.abs(n);
    var s = a.toLocaleString('en-US', { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 });
    var sign = n < 0 ? '−' : (signed && n > 0 ? '+' : '');
    return sign + '$' + s;
  }
  function cls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }
  function v(x) { return x == null || String(x).trim() === '' ? '–' : String(x).trim(); }

  // "2026-10-29 15:03" in the sheet is UTC (the scan runs at 11 AM ET = 15:00 UTC).
  function utcStamp(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(s || '').trim());
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  }
  function etParts(d) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    var o = {}; f.forEach(function (p) { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }
  function fmtET(d, withDay) {
    return d.toLocaleString('en-US', withDay === false ?
      { timeZone: TZ, hour: 'numeric', minute: '2-digit' } :
      { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  }
  // Plain date "2026-10-28" -> "Wed, Oct 28"
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
    if (!m) return v(s);
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  }
  function todayET() { return etParts(new Date()); }

  // ---------- CSV ----------
  function parseCSV(text) {
    var rows = [], row = [], f = '', q = false, i = 0, c;
    text = String(text).replace(/^\uFEFF/, '');
    for (; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function toObjects(rows) {
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); })
      .map(function (r) { var o = {}; head.forEach(function (h, j) { o[h] = r[j] == null ? '' : r[j]; }); return o; });
  }
  function fetchText(url) {
    return fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (t) {
      if (/^\s*<(!doctype|html)/i.test(t)) throw new Error('not CSV');
      return t;
    });
  }
  function loadTab(tab) {
    var base = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID;
    var exportUrl = base + '/export?format=csv&gid=' + tab.gid;
    var gvizUrl = base + '/gviz/tq?tqx=out:csv&headers=1&sheet=' + encodeURIComponent(tab.name);
    return fetchText(exportUrl).catch(function () { return fetchText(gvizUrl); })
      .then(function (t) { return toObjects(parseCSV(t)); });
  }

  // ---------- model ----------
  function feeFor(t) {
    var m = /commissions open \+ close \$([\d,.]+)/i.exec(t['Exit note'] || '');
    if (m) return num(m[1]);
    var c = num(t['Contracts']);
    if (c == null) return null;
    var rate = /^SPXW?$/i.test(String(t['Symbol']).trim()) ? COMMISSION_SPX : COMMISSION;
    return Math.round(rate * 2 * c * 2 * 100) / 100; // 2 legs x contracts, open + close
  }
  function buildTrade(t) {
    var gross = num(t['P&L at 9:35 exit ($)']), basis = '9:35 AM exit';
    if (gross == null && /SETTLED/i.test(t['Status']) && num(t['P&L at mid ($)']) != null) {
      gross = num(t['P&L at mid ($)']); basis = 'held to expiry (no 9:35 exit logged)';
    }
    var fee = feeFor(t);
    var net = gross == null ? null : Math.round((gross - (fee || 0)) * 100) / 100;
    var closeDay = String(t['Exit time'] || t['Close day'] || t['Earnings date'] || '').slice(0, 10);
    return { row: t, sym: String(t['Symbol']).trim(), gross: gross, fee: fee, net: net, basis: basis,
      closed: gross != null, closeDay: closeDay, logged: String(t['Logged']).trim() };
  }
  function spreadName(side, structure) {
    var s = String(structure || '').trim();
    if (s) return s.charAt(0).toUpperCase() + s.slice(1);
    return side ? side.charAt(0).toUpperCase() + side.slice(1) + ' credit spread' : 'Credit spread';
  }
  function legs(side, sh, lo) {
    if (!sh && !lo) return '–';
    var s = String(side || '').trim();
    return 'Sell ' + v(sh) + ' ' + s + ' / buy ' + v(lo) + ' ' + s;
  }
  function reasonLabel(r) {
    r = String(r || '');
    if (/^low volume/i.test(r)) return 'Options volume too low';
    if (/price floor/i.test(r)) return 'Stock under $20';
    if (/normal days/i.test(r)) return 'Earnings move under 3 normal days';
    if (/no expirations/i.test(r)) return 'No option expiry after the report';
    if (/^gapper/i.test(r)) return 'Gapper (worst move too big)';
    if (/last year/i.test(r)) return "Implied move below last year's";
    if (/avg past move/i.test(r)) return 'Implied move below the average';
    if (/term structure/i.test(r)) return 'Term structure flat';
    if (/usable past reports|historical earnings/i.test(r)) return 'Not enough earnings history';
    if (/bump|distance-rule/i.test(r)) return 'No strike far enough';
    if (/credit/i.test(r)) return 'Credit too small';
    if (/stock volume|shares/i.test(r)) return 'Stock volume too low';
    if (/chain|greeks/i.test(r)) return 'No option data';
    var s = r.split(':')[0].replace(/[-+]?\$?\d[\d,.]*%?x?/g, '').replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, 48) : 'Other';
  }

  // ---------- render ----------
  function fact(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }
  function pickCard(p, tr, tag) {
    var side = p['Side'];
    var html = '<article class="trade"><div class="head"><div><span class="sym">' + esc(p['Symbol']) + '</span> ' +
      '<span class="what">' + esc(spreadName(side, p['Structure'])) + '</span></div>' + (tag || '') + '</div>';
    html += '<p class="note" style="margin-top:4px">' + esc(legs(side, p['Short'], p['Long'])) +
      (p['Expiration'] ? ' · expires ' + esc(fmtDate(p['Expiration'])) : '') + '</p>';
    html += '<dl class="facts">' +
      fact('Earnings', tr ? fmtDate(tr.row['Earnings date']) + (tr.row['Report timing'] ? ' (' + tr.row['Report timing'] + ')' : '') : '–') +
      fact('Credit (mid)', p['Credit (mid)'] ? '$' + v(p['Credit (mid)']) : '–') +
      fact('Credit / width', v(p['Credit/width'])) +
      fact('Contracts', v(p['Contracts ($1k max loss)'])) +
      fact('Max loss', p['Max loss $'] ? money(num(p['Max loss $'])) : '–') +
      fact('Implied move', v(p['Implied earn move'])) +
      fact('Avg past move', v(p['Avg past move'])) +
      fact('Implied ÷ avg', v(p['Implied/hist'])) +
      fact('IV ÷ HV', v(p['IV/HV'])) +
      fact('Implied ÷ last yr', v(p['Implied / last yr'])) +
      fact('Natural credit', p['Natural credit'] ? '$' + v(p['Natural credit']) : '–') +
      fact('Strike from', v(p['Strike source'])) +
      '</dl>';
    var when = utcStamp(p['Time']);
    html += '<p class="note">Picked ' + esc(when ? fmtET(when) : v(p['Time'])) + (p['Rank'] ? ' · rank #' + esc(p['Rank']) : '') + '</p>';
    return html + '</article>';
  }
  function tradeCard(t, open, pick) {
    var r = t.row, pill;
    if (open) pill = '<span class="pill open">' + esc(v(r['Status']).toLowerCase() === 'open' ? 'Open' : v(r['Status'])) + '</span>';
    else pill = '<span class="pill ' + (t.net > 0 ? 'win' : t.net < 0 ? 'loss' : '') + '">' + (t.net > 0 ? 'Win' : t.net < 0 ? 'Loss' : 'Flat') + '</span>';
    var html = '<article class="trade"><div class="head"><div><span class="sym">' + esc(t.sym) + '</span> <span class="what">' +
      esc(spreadName(r['Side'], '')) + '</span></div>' + pill + '</div>';
    html += '<p class="note" style="margin-top:4px">' + esc(legs(r['Side'], r['Short strike'], r['Long strike'])) +
      ' · ' + esc(v(r['Contracts'])) + ' contract' + (num(r['Contracts']) === 1 ? '' : 's') + ' · credit $' + esc(v(r['Credit (mid)'])) + '</p>';
    if (!open) {
      html += '<p class="big ' + cls(t.net) + '" style="margin:8px 0 0">' + money(t.net, true) + '</p>' +
        '<p class="note" style="margin-top:0">after ' + money(t.fee) + ' commission · ' + money(t.gross, true) + ' before</p>';
    }
    html += '<dl class="facts">' +
      fact('Earnings', fmtDate(r['Earnings date']) + (r['Report timing'] ? ' (' + r['Report timing'] + ')' : '')) +
      fact('Entry price', r['Entry spot'] ? '$' + v(r['Entry spot']) : '–') +
      fact('Implied move', v(r['Implied move'])) +
      fact('Move after', v(r['Move after earnings']));
    if (!open) {
      html += fact('Exit (9:35)', r['Exit time'] ? fmtDate(r['Exit time']) : '–') +
        fact('Price at exit', r['Exit spot (9:35)'] ? '$' + v(r['Exit spot (9:35)']) : '–') +
        fact('Short strike hit', v(r['Short breached at 9:35'])) +
        fact('If held to expiry', r['P&L at mid ($)'] ? money(num(r['P&L at mid ($)']), true) + ' before fees' : '–');
    } else {
      html += fact('Closes', r['Close day'] ? fmtDate(r['Close day']) : 'morning after report') +
        fact('Expires', fmtDate(r['Expiration']));
    }
    html += '</dl>';
    if (!open && t.basis !== '9:35 AM exit') html += '<p class="note">P&amp;L basis: ' + esc(t.basis) + '.</p>';
    var stc = pick ? String(pick['Structure'] || '').trim() : '';
    if (stc && !/^(put|call) credit spread$/i.test(stc)) html += '<p class="note">The scan listed this pick as: ' + esc(stc) + '. The Tracked tab follows the ' + esc(v(r['Side'])) + ' spread shown here.</p>';
    return html + '</article>';
  }
  function equityChart(closed) {
    var pts = closed.slice().sort(function (a, b) { return (a.closeDay + a.logged).localeCompare(b.closeDay + b.logged); });
    var cum = 0, ys = [0], labels = ['Start'];
    pts.forEach(function (t) { cum += t.net; ys.push(Math.round(cum * 100) / 100); labels.push(t.sym); });
    var W = 420, H = 210, L = 66, R = 28, T = 14, B = 30;
    var lo = Math.min.apply(null, ys.concat(0)), hi = Math.max.apply(null, ys.concat(0));
    var min = lo, max = hi;
    if (max === min) { max += 1; min -= 1; }
    var pad = (max - min) * 0.1; max += pad; min -= pad;
    var grid = [hi, 0, lo].filter(function (g, i, arr) { return arr.indexOf(g) === i; });
    function X(i) { return L + (ys.length === 1 ? 0 : i * (W - L - R) / (ys.length - 1)); }
    function Y(y) { return T + (max - y) * (H - T - B) / (max - min); }
    var d = ys.map(function (y, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(y).toFixed(1); }).join(' ');
    var last = ys[ys.length - 1], color = last >= 0 ? '#047857' : '#b91c1c';
    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Running total of closed paper-trade P&L after commission, ending at ' + esc(money(last, true)) + '">';
    grid.forEach(function (g) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '" stroke="' + (g === 0 ? '#94a3b8' : '#e2e8f0') + '" stroke-dasharray="' + (g === 0 ? '0' : '4 4') + '"/>' +
        '<text x="' + (L - 12) + '" y="' + (Y(g) + 4).toFixed(1) + '" text-anchor="end">' + esc(money(Math.round(g))) + '</text>';
    });
    svg += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';
    ys.forEach(function (y, i) {
      svg += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(y).toFixed(1) + '" r="4.5" fill="#fff" stroke="' + color + '" stroke-width="2.5"/>';
      svg += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 && ys.length > 1 ? 'start' : i === ys.length - 1 && ys.length > 1 ? 'end' : 'middle') + '"' + (i === ys.length - 1 && ys.length > 1 ? ' dx="12"' : i === 0 ? ' dx="-8"' : '') + '>' + esc(labels[i]) + '</text>';
    });
    return svg + '</svg>';
  }

  function render(scan, tracked) {
    var today = todayET();
    // Tracked trades
    var trades = tracked.filter(function (t) { return /^TRADE$/i.test(String(t['Signal']).trim()); }).map(buildTrade);
    var nearMiss = tracked.filter(function (t) { return !/^TRADE$/i.test(String(t['Signal']).trim()) && String(t['Symbol']).trim(); });
    var closed = trades.filter(function (t) { return t.closed; });
    var open = trades.filter(function (t) { return !t.closed; });
    function pickFor(t) {
      return scan.filter(function (p) { return String(p['Symbol']).trim() === t.sym && String(p['Time']).trim() === t.logged && /^TRADE$/i.test(String(p['Status']).trim()); })[0] || null;
    }
    function trFor(p) {
      var sym = String(p['Symbol']).trim(), tm = String(p['Time']).trim();
      var m = trades.filter(function (t) { return t.sym === sym && t.logged === tm; })[0];
      return m || trades.filter(function (t) { return t.sym === sym && t.logged.slice(0, 10) === tm.slice(0, 10); })[0] || null;
    }

    // ----- latest scan -----
    var stamped = scan.map(function (r) { var d = utcStamp(r['Time']); return d ? { r: r, d: d, day: etParts(d) } : null; }).filter(Boolean);
    var lastDay = stamped.reduce(function (m, x) { return x.day > m ? x.day : m; }, '');
    var latest = stamped.filter(function (x) { return x.day === lastDay; });
    var lastTime = latest.reduce(function (m, x) { return !m || x.d > m ? x.d : m; }, null);
    var sb = '';
    if (!latest.length) {
      sb = '<p class="empty">No scans in the sheet yet.</p>';
    } else {
      var cnt = { TRADE: 0, CANDIDATE: 0, SKIP: 0 };
      latest.forEach(function (x) { var s = String(x.r['Status']).trim().toUpperCase(); cnt[s] = (cnt[s] || 0) + 1; });
      sb += '<p><strong>' + esc(fmtET(lastTime)) + '</strong>' + (lastDay === today ? ' · today' : '') + '</p>';
      sb += '<div class="kpis"><div class="kpi"><div class="v">' + latest.length + '</div><div class="l">Stocks checked</div></div>' +
        '<div class="kpi"><div class="v">' + cnt.TRADE + '</div><div class="l">Trades</div></div>' +
        '<div class="kpi"><div class="v">' + (cnt.CANDIDATE || 0) + '</div><div class="l">Candidates</div></div>' +
        '<div class="kpi"><div class="v">' + cnt.SKIP + '</div><div class="l">Skipped</div></div></div>';
      var reasons = {};
      latest.forEach(function (x) { if (/^SKIP$/i.test(String(x.r['Status']).trim())) { var l = reasonLabel(x.r['Reason / rank']); reasons[l] = (reasons[l] || 0) + 1; } });
      var rl = Object.keys(reasons).sort(function (a, b) { return reasons[b] - reasons[a]; });
      if (rl.length) {
        var top = reasons[rl[0]];
        sb += '<p class="small muted" style="margin-bottom:6px">Why stocks were skipped</p><ul class="bars">' + rl.slice(0, 6).map(function (k) {
          return '<li><span>' + esc(k) + '</span><b>' + reasons[k] + '</b><span class="bar"><span style="width:' + Math.max(4, Math.round(reasons[k] / top * 100)) + '%"></span></span></li>';
        }).join('') + '</ul>';
      }
      var order = { TRADE: 0, CANDIDATE: 1 };
      var list = latest.slice().sort(function (a, b) {
        var sa = order[String(a.r['Status']).trim().toUpperCase()], sbb = order[String(b.r['Status']).trim().toUpperCase()];
        return (sa == null ? 2 : sa) - (sbb == null ? 2 : sbb) || String(a.r['Symbol']).localeCompare(String(b.r['Symbol']));
      });
      sb += '<details><summary>See all ' + latest.length + ' stocks</summary><ul class="tick-list">' + list.map(function (x) {
        return '<li><b>' + esc(x.r['Symbol']) + '</b> <span class="pill' + (/TRADE/i.test(x.r['Status']) ? ' win' : '') + '">' + esc(v(x.r['Status'])) + '</span> <span class="muted">' + esc(v(x.r['Reason / rank'])) + '</span></li>';
      }).join('') + '</ul></details>';
    }
    $('scan-body').innerHTML = sb;

    // ----- picks -----
    var allPicks = scan.filter(function (r) { return /^(TRADE|CANDIDATE)$/i.test(String(r['Status']).trim()); })
      .sort(function (a, b) { return String(b['Time']).localeCompare(String(a['Time'])); });
    var current = allPicks.filter(function (p) {
      var d = utcStamp(p['Time']), tr = trFor(p);
      if (tr) return !tr.closed;
      return d && etParts(d) === lastDay;
    });
    $('picks-body').innerHTML = current.length ? current.map(function (p) {
      var tr = trFor(p), st = String(p['Status']).trim().toUpperCase();
      return pickCard(p, tr, '<span class="pill' + (st === 'TRADE' ? ' open' : '') + '">' + (st === 'TRADE' ? 'Trade' : 'Candidate') + '</span>');
    }).join('') : '<p class="empty">No open picks right now.' + (latest.length ? ' The last scan (' + esc(fmtDate(lastDay)) + ') found no trade.' : '') + ' New picks show up here after the 11 AM ET scan.</p>';

    // ----- stats -----
    var st = '';
    if (!closed.length) {
      st = '<p class="empty">No closed paper trades yet. Results appear after the first trade closes.</p>';
    } else {
      var wins = closed.filter(function (t) { return t.net > 0; }).length;
      var total = closed.reduce(function (s, t) { return s + t.net; }, 0);
      var fees = closed.reduce(function (s, t) { return s + (t.fee || 0); }, 0);
      var worst = closed.reduce(function (m, t) { return t.net < m.net ? t : m; }, closed[0]);
      var best = closed.reduce(function (m, t) { return t.net > m.net ? t : m; }, closed[0]);
      st += '<div class="kpis k6">' +
        '<div class="kpi"><div class="v">' + closed.length + '</div><div class="l">Closed trades</div></div>' +
        '<div class="kpi"><div class="v">' + Math.round(wins / closed.length * 100) + '%</div><div class="l">Win rate (' + wins + ' of ' + closed.length + ')</div></div>' +
        '<div class="kpi"><div class="v ' + cls(total) + '">' + money(total, true) + '</div><div class="l">Total P&amp;L</div></div>' +
        '<div class="kpi"><div class="v ' + cls(total) + '">' + money(Math.round(total / closed.length * 100) / 100, true) + '</div><div class="l">Avg per trade</div></div>' +
        '<div class="kpi"><div class="v ' + cls(best.net) + '">' + money(best.net, true) + '</div><div class="l">Best trade (' + esc(best.sym) + ')</div></div>' +
        '<div class="kpi"><div class="v ' + cls(worst.net) + '">' + money(worst.net, true) + '</div><div class="l">' + (worst.net < 0 ? 'Biggest loss' : 'Smallest win') + ' (' + esc(worst.sym) + ')</div></div>' +
        '</div>';
      st += equityChart(closed);
      st += '<p class="note">Running total after commission. Commissions so far: ' + money(fees) + '.' +
        (open.length ? ' ' + open.length + ' trade' + (open.length === 1 ? ' is' : 's are') + ' still open and not counted.' : '') + '</p>';
    }
    $('stats-body').innerHTML = st;

    // ----- open / closed -----
    $('open-body').innerHTML = open.length ? open.map(function (t) { return tradeCard(t, true, pickFor(t)); }).join('') :
      '<p class="empty">No open paper trades. Every trade so far has been closed.</p>';
    var cl = closed.slice().sort(function (a, b) { return (b.closeDay + b.logged).localeCompare(a.closeDay + a.logged); });
    var ch = cl.length ? cl.map(function (t) { return tradeCard(t, false, pickFor(t)); }).join('') : '<p class="empty">No closed trades yet.</p>';
    if (nearMiss.length) {
      ch += '<details><summary>Near-misses also tracked (' + nearMiss.length + ', not traded)</summary>' +
        '<p class="note">Stocks that just missed a rule, followed for comparison only. Not in the results above.</p><ul class="tick-list">' +
        nearMiss.map(function (t) {
          var pl = num(t['P&L at mid ($)']);
          return '<li><b>' + esc(t['Symbol']) + '</b> ' + esc(v(t['Side'])) + ' ' + esc(v(t['Short strike'])) + '/' + esc(v(t['Long strike'])) +
            ', earnings ' + esc(fmtDate(t['Earnings date'])) + ' · ' + esc(v(t['Outcome'] || t['Status'])) +
            (pl != null ? ' (' + money(pl, true) + ' held to expiry, before fees)' : '') +
            (t['Filter note'] ? '<br><span class="muted small">Missed: ' + esc(t['Filter note']) + '</span>' : '') + '</li>';
        }).join('') + '</ul></details>';
    }
    $('closed-body').innerHTML = ch;

    // ----- history -----
    $('history-body').innerHTML = allPicks.length ? '<ul class="tick-list">' + allPicks.map(function (p) {
      var tr = trFor(p), d = utcStamp(p['Time']);
      var res = tr && tr.closed ? '<span class="' + cls(tr.net) + '"><b style="min-width:0">' + money(tr.net, true) + '</b></span>' : '<span class="pill open">open</span>';
      return '<li><b>' + esc(p['Symbol']) + '</b> ' + esc(d ? fmtDate(etParts(d)) : v(p['Time'])) + ' · ' + esc(legs(p['Side'], p['Short'], p['Long'])) + ' · ' + res + '</li>';
    }).join('') + '</ul><p class="note">' + allPicks.length + ' pick' + (allPicks.length === 1 ? '' : 's') + ' from ' + scan.length.toLocaleString('en-US') + ' stock checks since ' + esc(stamped.length ? fmtDate(etParts(stamped.reduce(function (m, x) { return x.d < m ? x.d : m; }, stamped[0].d))) : '–') + '.</p>'
      : '<p class="empty">No picks yet.</p>';

    var u = $('updated'); u.className = 'updated';
    u.textContent = 'Updated ' + fmtET(new Date(), false) + ' · last scan ' + (lastTime ? fmtET(lastTime) : 'none yet');
  }

  function showError() {
    var u = $('updated'); u.className = 'updated err';
    u.textContent = "Couldn't reach the sheet just now. Pull to refresh in a minute.";
    ['scan-body', 'picks-body', 'stats-body', 'open-body', 'closed-body', 'history-body'].forEach(function (id) {
      var el = $(id); if (/Loading/.test(el.textContent)) el.innerHTML = '<p class="empty">Data unavailable right now.</p>';
    });
  }

  function load() {
    return Promise.all([loadTab(TABS.scan), loadTab(TABS.tracked)])
      .then(function (r) { render(r[0], r[1]); })
      .catch(function (e) { if (window.console) console.warn(e); showError(); });
  }

  // Exposed for tests only.
  window.__scanner = { parseCSV: parseCSV, toObjects: toObjects, buildTrade: buildTrade, reasonLabel: reasonLabel, render: render, num: num };

  if (!window.__SCANNER_NO_AUTOLOAD) {
    load();
    setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }
})();
