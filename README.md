# Earnings IV-Crush Scanner: live dashboard

**Live page:** https://boro11204.github.io/earnings-scanner/

A phone-first page that shows the earnings scanner's latest scan, current picks, paper trades and results.

- It reads the scanner's Google Sheet ("Earnings IV Crush Log", view-only link) straight from your browser each time it opens, so it updates on its own after every scan. No server, no keys, no tracking.
- Tabs used: `Sheet1` (one row per stock per scan) and `Tracked` (every trade and its 9:35 AM exit).
- P&L shown = the sheet's "P&L at 9:35 exit ($)" minus commission ($0.50 per contract per leg, open and close). Near-misses are listed separately and not counted.

Files: `index.html`, `app.js`, `styles.css`. Tests: `node --test test/*.test.js`.

Paper trading results. Analysis only, not advice.
