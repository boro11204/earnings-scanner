# Backtest

`backtest.json` feeds the **Backtest** section of the dashboard. It is made by `run_backtest.py`.

**What it is:** the earnings scanner's own rule code (`rules_v3.py` from the private repo
`boro11204/earnings-iv-crush`, live version cb866eb, with the Railway setting
`V3_MIN_IMPLIED_HIST_RATIO=1.0`) run day by day over real past earnings reports, priced with
real end-of-day option quotes. Commission $0.50 per contract per leg, paid on the open and the
close. Fills at mid (optimistic), with a slippage table at 25%, 50% and 100% of the half spread.

**Data (free, no keys):**
- Option quotes: DoltHub public database `post-no-preference/options`, table `option_chain`
  (end-of-day bid / ask / IV / delta).
- Earnings dates and BMO/AMC timing: `events.csv` (Yahoo earnings dates 2021–2026 plus
  DoltHub `post-no-preference/earnings` calendar for 2020–2021 history).
- Stock prices and volume: Yahoo daily bars.

**Limits** (also shown on the page): no weekly expiries in the data (the nearest is usually 2–3
weeks out), no option volume/open interest (universe limited to 193 liquid names instead), only
closing quotes (exit at the reaction-day close instead of 9:35 AM), ~25 strikes per expiry, and
the term-structure rule is skipped in the headline numbers (shown separately).

**Rerun:**

```
git clone https://github.com/boro11204/earnings-iv-crush ../earnings-iv-crush   # private
pip install pandas numpy yfinance requests
python backtest/run_backtest.py --scanner-dir ../earnings-iv-crush
git add backtest/backtest.json && git commit -m "Refresh backtest"
```

The first run downloads ~900 daily option chains (20–30 min) into `backtest/cache/`
(not committed). To extend the test, add new reports to `events.csv`.

Analysis only, not advice.
