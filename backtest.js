/* Backtest section for the Earnings IV-Crush Scanner dashboard.
   (1) Live record: the scanner's own closed paper trades, read live from its sheet (same math as above).
   (2) Historical test: backtest/backtest.json, made by backtest/run_backtest.py from real
       end-of-day option quotes with the scanner's own rule code. Analysis only, not advice. */
(function () {
  'use strict';
  var SHEET_ID = '1vR2L7P3qNfFPkLSt25euHVW2RNE-U1KOAPh3xTA4Pb8';
  var COMMISSION = 0.50;
  var TZ = 'America/New_York';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) {
    if (v == null) return null;
    var s = String(v).replace(/[$,\s]/g, '');
    if (s === '' || s === '-') return null;
    var n = Number(s.replace(/%$/, ''));
    return isFinite(n) ? n : null;
  }
  function money(n, signed) {
    if (n == null || !isFinite(n)) return '–';
    var a = Math.abs(n);
    var s = a.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: a < 100 && a % 1 ? 2 : 0 });
    return (n < 0 ? '−' : (signed && n > 0 ? '+' : '')) + '$' + s;
  }
  function pct(x) { return x == null ? '–' : Math.round(x * 100) + '%'; }
  function cls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }
  function fmtDate(s, year) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return String(s || '–');
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    return d.toLocaleDateString('en-US', year === false ? { timeZone: 'UTC', month: 'short', day: 'numeric' } :
      { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtMonth(s) {
    var m = /^(\d{4})-(\d{2})/.exec(s);
    return new Date(Date.UTC(+m[1], +m[2] - 1, 15)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
  }
  function kpi(label, value, c) {
    return '<div class="kpi"><div class="v ' + (c || '') + '">' + esc(value) + '</div><div class="l">' + esc(label) + '</div></div>';
  }
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
    var head = rows.shift() || [];
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); }).map(function (r) {
      var o = {}; head.forEach(function (h, j) { o[String(h).trim()] = r[j] == null ? '' : r[j]; }); return o;
    });
  }

  function stats(pnls) {
    var n = pnls.length, cum = 0, peak = 0, dd = 0, wins = 0, best = -Infinity, worst = Infinity;
    pnls.forEach(function (x) { cum += x; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); if (x > 0) wins++; best = Math.max(best, x); worst = Math.min(worst, x); });
    return { n: n, wins: wins, win_rate: n ? wins / n : null, total: cum, avg: n ? cum / n : null, max_dd: dd, best: n ? best : null, worst: n ? worst : null };
  }
  function kpiBlock(s) {
    return '<div class="kpis">' +
      kpi('Trades', String(s.n)) +
      kpi('Win rate', pct(s.win_rate)) +
      kpi('Avg P&L / trade', money(s.avg, true), cls(s.avg)) +
      kpi('Total P&L', money(s.total, true), cls(s.total)) +
      kpi('Max drawdown', money(s.max_dd), s.max_dd < 0 ? 'neg' : '') +
      kpi('Best trade', money(s.best, true), cls(s.best)) +
      kpi('Worst trade', money(s.worst, true), cls(s.worst)) +
      kpi('Wins / losses', s.wins + ' / ' + (s.n - s.wins)) +
      '</div>';
  }

  // Equity curve over time (x = trade number, labels = first/last dates)
  function curve(trades) {
    var ys = [0], cum = 0;
    trades.forEach(function (t) { cum += t.pnl; ys.push(Math.round(cum)); });
    var W = 560, H = 230, L = 64, R = 14, T = 14, B = 30;
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    var min = lo, max = hi; if (max === min) { max += 1; min -= 1; }
    var pad = (max - min) * 0.08; max += pad; min -= pad;
    function X(i) { return L + (ys.length === 1 ? 0 : i * (W - L - R) / (ys.length - 1)); }
    function Y(y) { return T + (max - y) * (H - T - B) / (max - min); }
    var d = ys.map(function (y, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(y).toFixed(1); }).join(' ');
    var last = ys[ys.length - 1], color = last >= 0 ? '#047857' : '#b91c1c';
    var svg = '<svg class="chart wide" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Running total of backtest P&L after commission, ' + trades.length + ' trades, ending at ' + esc(money(last, true)) + '">';
    var grid = [0];
    [hi, lo].forEach(function (g) { if (grid.every(function (x) { return Math.abs(Y(x) - Y(g)) >= 14; })) grid.push(g); });
    grid.forEach(function (g) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '" stroke="' + (g === 0 ? '#94a3b8' : '#e2e8f0') + '" stroke-dasharray="' + (g === 0 ? '0' : '4 4') + '"/>' +
        '<text x="' + (L - 8) + '" y="' + (Y(g) + 4).toFixed(1) + '" text-anchor="end">' + esc(money(g)) + '</text>';
    });
    svg += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    if (trades.length) {
      svg += '<text x="' + L + '" y="' + (H - 8) + '" text-anchor="start">' + esc(fmtDate(trades[0].exit)) + '</text>';
      svg += '<text x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(fmtDate(trades[trades.length - 1].exit)) + '</text>';
    }
    return svg + '</svg>';
  }

  function tradeTable(trades) {
    var h = '<div class="tscroll"><table class="bt"><thead><tr><th>Date</th><th>Ticker</th><th>Spread</th><th class="r">Credit</th><th class="r">Exit</th><th class="r">P&amp;L</th></tr></thead><tbody>';
    trades.slice().reverse().forEach(function (t) {
      h += '<tr><td>' + esc(fmtDate(t.exit)) + '</td><td><b>' + esc(t.sym) + '</b></td>' +
        '<td>' + esc(t.short + '/' + t.long + ' ' + t.side) + ' ×' + esc(t.contracts) + '</td>' +
        '<td class="r">$' + Number(t.credit).toFixed(2) + '</td><td class="r">$' + Number(t.exit_value).toFixed(2) + '</td>' +
        '<td class="r ' + cls(t.pnl) + '">' + esc(money(t.pnl, true)) + (t.entry_shift || t.exit_shift ? '*' : '') + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }
  function monthTable(rows, key, fmt) {
    var h = '<div class="tscroll"><table class="bt"><thead><tr><th>' + (key === 'month' ? 'Month' : 'Year') + '</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">P&amp;L</th></tr></thead><tbody>';
    rows.slice().reverse().forEach(function (m) {
      h += '<tr><td>' + esc(fmt(m[key])) + '</td><td class="r">' + m.n + '</td><td class="r">' + pct(m.wins / m.n) + '</td><td class="r ' + cls(m.pnl) + '">' + esc(money(m.pnl, true)) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  // ---------- live record from the sheet ----------
  function liveRecord() {
    var url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&sheet=Tracked&_=' + Date.now();
    return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('sheet ' + r.status); return r.text(); })
      .then(function (txt) {
        var rows = parseCSV(txt).filter(function (t) { return /^TRADE$/i.test(String(t['Signal']).trim()); });
        var closed = [], open = 0;
        rows.forEach(function (t) {
          var gross = num(t['P&L at 9:35 exit ($)']);
          if (gross == null && /SETTLED/i.test(t['Status']) && num(t['P&L at mid ($)']) != null) gross = num(t['P&L at mid ($)']);
          if (gross == null) { open++; return; }
          var m = /commissions open \+ close \$([\d,.]+)/i.exec(t['Exit note'] || '');
          var fee = m ? num(m[1]) : COMMISSION * 2 * (num(t['Contracts']) || 0) * 2;
          closed.push({ sym: String(t['Symbol']).trim(), net: gross - fee, day: String(t['Close day'] || t['Earnings date'] || '').slice(0, 10) });
        });
        closed.sort(function (a, b) { return a.day.localeCompare(b.day); });
        var s = stats(closed.map(function (c) { return c.net; }));
        var h = '<h3 class="bt-h">1 · Live record <span class="pill">exact rules · real quotes</span></h3>';
        h += '<p class="small muted">The scanner\'s own paper trades from its sheet: real quotes at entry, the 9:35 AM exit, minus $0.50/contract commissions. Updates on its own.</p>';
        if (!closed.length) h += '<p class="empty">No closed trades yet.</p>';
        else {
          h += '<div class="kpis">' + kpi('Closed trades', String(s.n)) + kpi('Win rate', pct(s.win_rate)) +
            kpi('Total P&L', money(s.total, true), cls(s.total)) + kpi('Avg / trade', money(s.avg, true), cls(s.avg)) + '</div>';
          h += '<p class="small">' + closed.map(function (c) { return '<b>' + esc(c.sym) + '</b> <span class="' + cls(c.net) + '">' + esc(money(c.net, true)) + '</span>'; }).join(' · ') +
            (open ? ' · ' + open + ' still open' : '') + '</p>';
          if (s.n < 30) h += '<p class="note">Only ' + s.n + ' closed trade' + (s.n === 1 ? '' : 's') + ' so far, far too few to judge the strategy. That\'s why the historical test below exists.</p>';
        }
        $('bt-live').innerHTML = h;
      }).catch(function () {
        $('bt-live').innerHTML = '<p class="empty">Couldn\'t read the live record from the sheet right now. Refresh to try again.</p>';
      });
  }

  // ---------- historical test ----------
  function historical() {
    return fetch('backtest/backtest.json?_=' + Date.now(), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('json ' + r.status); return r.json(); })
      .then(function (b) {
        var tr = b.trades || [], s = b.stats || {};
        var h = '<h3 class="bt-h">2 · Historical test <span class="pill">real option quotes · ' + esc(String(b.range.searched_from).slice(0, 4)) + '–' + esc(String(b.range.searched_to).slice(0, 4)) + '</span></h3>';
        h += '<p class="small muted">The scanner\'s own rule code run day by day over <b>' + esc(b.reports_checked.toLocaleString('en-US')) + '</b> real earnings reports (' + esc(fmtDate(b.range.searched_from)) + ' to ' + esc(fmtDate(b.range.searched_to)) +
          ') on ' + esc(b.universe.split(' (')[0]) + ', priced with real end-of-day bid/ask quotes. P&amp;L is per trade at the scanner\'s ~$1,000 max-loss size, at mid, after $0.50/contract commissions (open + close).</p>';
        if (!tr.length) { $('bt-hist').innerHTML = h + '<p class="empty">No trades.</p>'; return; }
        var half = (b.stats_slippage || {})['0.5'];
        h += '<p class="verdict">Bottom line: <b class="' + cls(s.total) + '">' + esc(money(s.total, true)) + '</b> over ' + s.n + ' trades at mid prices' +
          (half ? ', but <b class="' + cls(half.total) + '">' + esc(money(half.total, true)) + '</b> if each leg pays half the bid-ask spread' : '') + '. Too few trades to call it proven either way.</p>';
        h += kpiBlock(s);
        h += curve(tr);
        h += '<p class="note">Running total, one point per trade, in date order.</p>';
        // slippage
        var sl = b.stats_slippage || {};
        h += '<h4>If fills are worse than mid</h4><div class="tscroll"><table class="bt"><thead><tr><th>Fill</th><th class="r">Wins</th><th class="r">Avg</th><th class="r">Total</th></tr></thead><tbody>';
        [['0', 'Mid (as assumed)'], ['0.25', '¼ of spread'], ['0.5', '½ of spread'], ['1', 'Natural (bid/ask)']].forEach(function (p) {
          var k = Object.keys(sl).filter(function (x) { return Number(x) === Number(p[0]); })[0];
          var x = sl[k]; if (!x) return;
          h += '<tr><td>' + esc(p[1]) + '</td><td class="r">' + pct(x.win_rate) + '</td><td class="r ' + cls(x.avg) + '">' + esc(money(x.avg, true)) + '</td><td class="r ' + cls(x.total) + '">' + esc(money(x.total, true)) + '</td></tr>';
        });
        h += '</tbody></table></div><p class="note">Mid fills are optimistic: each of the 4 legs (2 to open, 2 to close) pays part of the bid-ask spread in real trading.</p>';
        if (b.stats_all_rules) {
          var a = b.stats_all_rules;
          h += '<p class="small">With the term-structure rule applied too (see limits): <b>' + (a.n || 0) + '</b> trades' + (a.n ? ', ' + pct(a.win_rate) + ' wins, total <span class="' + cls(a.total) + '">' + esc(money(a.total, true)) + '</span>' : '') + '.</p>';
        }
        h += '<details><summary>By year</summary>' + monthTable(b.years || [], 'year', function (y) { return y; }) + '</details>';
        h += '<details><summary>By month (' + (b.months || []).length + ' months)</summary>' + monthTable(b.months || [], 'month', fmtMonth) + '</details>';
        h += '<details><summary>Every trade (' + tr.length + ')</summary><p class="note">Date = exit day. Spread = short/long strike, side, × contracts. Credit and exit are per spread at mid; P&amp;L is after commission. * = quotes from 1 trading day off (see limits).</p>' + tradeTable(tr) + '</details>';
        // method
        h += '<details open><summary>How it was tested &amp; limits</summary><div class="method">';
        h += '<p><b>Data (all real, all free):</b> option quotes from DoltHub\'s public options database (end-of-day bid, ask, IV per contract); earnings dates and before/after-the-bell times from Yahoo and DoltHub\'s earnings calendar; stock prices from Yahoo. No simulated or assumed option prices.</p>';
        h += '<p><b>Rules:</b> every keep/skip decision is the scanner\'s own code (rules_v3, the live version), with the live setting implied ÷ average move ≥ 1.0. Entry on the trading day before the report, exit the morning the stock reacts. Best 3 per day.</p>';
        h += '<p><b>Counts:</b> ' + esc(b.reports_checked.toLocaleString('en-US')) + ' reports checked → ' + esc(b.passed_no_option_rules) + ' passed the price, volume and history rules → ' + tr.length + ' trades. ' +
          (b.missing_chain ? esc(b.missing_chain) + ' of the 851 had no option quotes in the database on the scan day (or the day before) and were skipped.' : '') + '</p>';
        if (b.no_exit_quote) h += '<p><b>Left out:</b> the rules took ' + esc(b.no_exit_quote) + ' more trades that have no exit quote in the database (it stops listing an expiry once it\'s under ~2 weeks out). In ' + esc(b.no_exit_breached) + ' of those ' + esc(b.no_exit_quote) + ' (' + pct(b.no_exit_breached / b.no_exit_quote) + ') the stock had crossed the short strike by the exit close, vs ' + esc(b.priced_breached) + ' of the ' + tr.length + ' priced trades (' + pct(b.priced_breached / tr.length) + '), so the priced trades may look a bit better than the full set.</p>';
        h += '<p><b>Where this differs from the live scanner:</b></p><ul class="lim">' + (b.deviations || []).map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>';
        h += '<p><b>Rerun:</b> <code>python backtest/run_backtest.py --scanner-dir ../earnings-iv-crush</code> (see backtest/README.md).</p>';
        h += '</div></details>';
        h += '<p class="small muted bt-upd">Historical test last run: ' + esc(b.generated_utc) + ' UTC · Live record: refreshed when this page opens.</p>';
        $('bt-hist').innerHTML = h;
      }).catch(function () {
        $('bt-hist').innerHTML = '<p class="empty">Couldn\'t load the historical test file. Refresh to try again.</p>';
      });
  }

  function start() { liveRecord(); historical(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
