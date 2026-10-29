// Reads the final site files and checks the core content, viewport, local assets and P&L math.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SITE = fs.existsSync(path.join(__dirname, '..', 'site', 'index.html')) ? path.join(__dirname, '..', 'site') : path.join(__dirname, '..');
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');

test('page basics', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width/);
  assert.match(html, /<title>Earnings IV-Crush Scanner/);
  assert.match(html, /Paper trading results\. Analysis only, not advice\./);
  for (const id of ['scan', 'picks', 'stats', 'open', 'closed', 'history', 'how']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(fs.existsSync(path.join(SITE, '.nojekyll')));
  for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) assert.ok(fs.existsSync(path.join(SITE, m[1])), 'missing asset ' + m[1]);
  assert.doesNotMatch(html + js, /TODO|lorem|placeholder|api[_-]?key|token=/i);
  assert.doesNotMatch(html + js, /googletagmanager|google-analytics|gtag\(|facebook/i);
});

test('data source is the public sheet, no keys', () => {
  assert.match(js, /1vR2L7P3qNfFPkLSt25euHVW2RNE-U1KOAPh3xTA4Pb8/);
  assert.match(js, /export\?format=csv&gid=/);
  assert.match(js, /gviz\/tq\?tqx=out:csv&headers=1/);
});

test('CSV parsing and P&L after commission', () => {
  const ctx = { window: { __SCANNER_NO_AUTOLOAD: true }, document: {}, console };
  vm.createContext(ctx); vm.runInContext(js, ctx);
  const s = ctx.window.__scanner;
  const rows = s.toObjects(s.parseCSV('Symbol,Signal,Contracts,P&L at 9:35 exit ($),Exit note,Status\nNFLX,TRADE,10,270,"P&L before fees (commissions open + close $20.00 at $0.50/contract per leg)",SETTLED\nNOW,TRADE,2,-710,,POST-EARNINGS\nXYZ,TRADE,3,,,OPEN\n'));
  assert.strictEqual(rows.length, 3);
  const [a, b, c] = rows.map(s.buildTrade);
  assert.strictEqual(a.net, 250); assert.strictEqual(a.fee, 20);
  assert.strictEqual(b.fee, 4); assert.strictEqual(b.net, -714);  // 0.50 x 2 legs x 2 contracts x open+close
  assert.strictEqual(c.closed, false);
  assert.strictEqual(s.reasonLabel('Stock 3.025 below $20 price floor'), 'Stock under $20');
});
