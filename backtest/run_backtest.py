#!/usr/bin/env python3
"""
Historical backtest of the earnings IV-crush scanner's CURRENT rules on REAL
historical option quotes.  Writes backtest.json for the dashboard's Backtest
section.  Analysis only, not advice.

How to rerun (free, no API keys):
  1. git clone the scanner repo (private: boro11204/earnings-iv-crush) next to
     this repo, so ../earnings-iv-crush/rules_v3.py exists.
  2. pip install pandas numpy yfinance requests
  3. python backtest/run_backtest.py --scanner-dir ../earnings-iv-crush
     (first run takes ~20-30 min: it downloads ~900 daily option chains from
     DoltHub's free public database and caches them in backtest/cache/)
  4. commit backtest/backtest.json

Data (all free, all real):
  * Option quotes: DoltHub "post-no-preference/options" (table option_chain):
    end-of-day bid / ask / IV / delta per contract.  Limits: about 25 strikes
    per expiry, only the 3-4 expiries that are ~2+ weeks out (no weekly
    front-week expiry), no volume and no open interest.
  * Earnings dates + before/after-the-bell timing: backtest/events.csv
    (Yahoo earnings dates 2021-2026 + DoltHub "post-no-preference/earnings"
    earnings_calendar for 2020-2021 history).
  * Stock prices and volume: Yahoo daily bars (yfinance).

What is the scanner's own code: every rule decision is made by the scanner's
rules_v3.evaluate_ticker_v3 + rules_v2.rank_and_select (commit cb866eb), with
Railway's setting V3_MIN_IMPLIED_HIST_RATIO=1.0.  Deviations forced by the
data are listed in DEVIATIONS below and shown on the page.
"""
import argparse, bisect, contextlib, copy, datetime as dt, io, json, os, sys, time
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DOLT = "https://www.dolthub.com/api/v1alpha1/post-no-preference/{db}/master"
COMMISSION = 0.50            # $ per contract, per leg, per side (open and close)
SLIPPAGE = [0.0, 0.25, 0.5, 1.0]   # share of the half bid-ask spread paid per leg per side
START, END = "2021-06-01", None    # END defaults to the newest date in the option data

DEVIATIONS = [
    "Expiry: the data has no weekly options, so each trade uses the first expiry in the data on/after the reaction day (usually 2-3 weeks out) instead of the first weekly. Less of that option's value is earnings premium, so the IV crush per trade is smaller than in the live scanner.",
    "Options volume / open interest rule (300 contracts or 5,000 OI) can't be checked: the data has no volume or OI. Instead the universe is 193 large, liquid optionable stocks where that rule almost always passes.",
    "Prices are end-of-day quotes: entry at the mid of the closing quote on the scan day (the scanner enters before the close, at mid); exit at the mid of the closing quote on the reaction day (the scanner exits at 9:35 AM). The close exit includes the whole first day's move, not just the opening gap.",
    "Term-structure rule (front IV / next-month IV >= 1.3) is compared on 2-3-week vs ~5-week options, which dilutes it; headline results skip it, and the page shows the result with it applied too.",
    "The database stops listing an expiry once it is under ~2 weeks out, so many trades have no exit quote on the reaction day (or the day after). Those trades are left out of the P&L; the page shows how many and how often the stock had crossed the short strike in them.",
    "The database skips some days for some stocks (mostly Tuesdays and Thursdays). When the scan day has no quotes, the quotes from 1 trading day earlier are used for the entry; when the exit day has none, the next trading day's close is used. Each such trade is marked in the trade list.",
    "Stock prices: Yahoo's history is adjusted for later splits and spin-offs, so when it doesn't match the option strikes, the stock price is read from the option quotes themselves (put-call parity).",
    "Strikes come from ~25 listed strikes per expiry, so the strike and wing chosen can differ from the full chain the live scanner sees.",
]


def dolt(db, q, timeout=170, tries=3):
    last = None
    for _ in range(tries):
        try:
            j = requests.get(DOLT.format(db=db), params={"q": q}, timeout=timeout).json()
            if j.get("query_execution_status") == "Success":
                if j.get("query_execution_message") == "RowLimit":
                    raise RuntimeError("DoltHub truncated the result at 1000 rows; use smaller batches")
                return j.get("rows") or []
            last = j.get("query_execution_message")
        except RuntimeError:
            raise
        except Exception as e:  # network / timeout
            last = str(e)
        time.sleep(3)
    raise RuntimeError(f"DoltHub query failed: {last}")


class Backtest:
    def __init__(self, scanner_dir, cache_dir, workers=8):
        sys.path.insert(0, os.path.abspath(scanner_dir))
        global strategy_core, rules_v2, rules_v3, OptionQuote
        import strategy_core, rules_v2, rules_v3  # noqa: the scanner's own code
        from strategy_core import OptionQuote
        self.CFG = strategy_core.StrategyConfig()
        with contextlib.redirect_stdout(io.StringIO()):
            base = rules_v3.rules_from_env({"V3_MIN_IMPLIED_HIST_RATIO": "1.0"})  # Railway setting
        base.min_chain_volume = 0      # data has no volume / OI (see DEVIATIONS)
        base.min_chain_oi_alt = 0
        self.rules_all = base
        self.rules_headline = copy.deepcopy(base)
        self.rules_headline.min_term_kink = 0.0
        self.cache = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self.pool = ThreadPoolExecutor(workers)

    # ---------- data ----------
    def load(self):
        ev = pd.read_csv(os.path.join(HERE, "events.csv"))
        self.events = {}
        for r in ev.itertuples():
            self.events.setdefault(r.symbol, []).append((r.report_date, r.timing if isinstance(r.timing, str) else None))
        for s in self.events:
            self.events[s].sort()
        self.syms = sorted(self.events)
        import yfinance as yf
        px = yf.download(self.syms + ["SPY"], start="2019-01-01", auto_adjust=False, progress=False,
                         group_by="ticker", threads=True, timeout=60)
        self.tdays = [d.strftime("%Y-%m-%d") for d in px["SPY"]["Close"].dropna().index]
        self.closes, self.vols = {}, {}
        for s in self.syms:
            try:
                d = px[s][["Close", "Volume"]].dropna()
            except KeyError:
                continue
            self.closes[s] = {k.strftime("%Y-%m-%d"): float(v) for k, v in d["Close"].items()}
            self.vols[s] = d["Volume"]

    def prev_td(self, d):
        return self.tdays[bisect.bisect_left(self.tdays, d) - 1]

    def next_td(self, d):
        i = bisect.bisect_right(self.tdays, d)
        return self.tdays[i] if i < len(self.tdays) else None

    def chains(self, day, syms):
        """{symbol: [rows]} for one date; cached on disk; <=5 symbols per query (DoltHub caps 1000 rows)."""
        out = {}
        todo = []
        for s in syms:
            p = os.path.join(self.cache, f"{day}_{s}.json")
            if os.path.exists(p):
                out[s] = json.load(open(p))
            else:
                todo.append(s)

        def get(batch):
            q = ("SELECT act_symbol,expiration,strike,call_put,bid,ask,vol,delta FROM option_chain "
                 f"WHERE date='{day}' AND act_symbol IN ({','.join(repr(s) for s in batch)})")
            rows = dolt("options", q)
            res = {s: [] for s in batch}
            for r in rows:
                res[r["act_symbol"]].append(r)
            for s, rs in res.items():
                json.dump(rs, open(os.path.join(self.cache, f"{day}_{s}.json"), "w"))
            return res
        for res in self.pool.map(get, [todo[i:i + 5] for i in range(0, len(todo), 5)]):
            out.update(res)
        return out

    def prefetch(self, pairs):
        """Fetch many (day, symbol) chains in parallel into the cache."""
        by_day = {}
        for d, sym in pairs:
            if not os.path.exists(os.path.join(self.cache, f"{d}_{sym}.json")):
                by_day.setdefault(d, set()).add(sym)
        jobs = [(d, sorted(ss)[i:i + 5]) for d, ss in by_day.items() for i in range(0, len(ss), 5)]
        list(ThreadPoolExecutor(14).map(lambda j: self.chains(j[0], j[1]), jobs))

    # ---------- rules ----------
    def closes_before(self, s, d):
        return {k: v for k, v in self.closes[s].items() if k < d}

    def candidates(self, end):
        """Every report in range with a known BMO/AMC time.  Scanner timing: scan + entry on the trading
        day before the report; exit the morning the stock reacts (BMO: report day, AMC: next day)."""
        out = []
        for s, evs in self.events.items():
            if s not in self.closes:
                continue
            for d, t in evs:
                if not (START <= d <= end) or t not in ("BMO", "AMC"):
                    continue
                entry = self.prev_td(d)
                exitd = d if t == "BMO" else self.next_td(d)
                if exitd and exitd <= end and entry in self.closes[s]:
                    out.append(dict(sym=s, report=d, timing=t, entry=entry, exit=exitd))
        return out

    def prefilter(self, c):
        """Rules that need no option data, using the scanner's own helpers, in the scanner's order.
        Returns None if it passes (the full rule code re-checks all of these anyway)."""
        s = c["sym"]
        spot = self.closes[s][c["entry"]]
        if spot < 20:
            return "Stock under $20"
        v = self.vols[s]
        if v[v.index.strftime("%Y-%m-%d") < c["entry"]].tail(20).mean() < 500000:
            return "Stock volume too low"
        dcs = self.closes_before(s, c["entry"])
        past = [e for e in self.events[s] if e[0] < c["report"]]
        moves = rules_v2.historical_earnings_moves(past, dcs, 8)
        if len(moves) < 6:
            return "Not enough earnings history"
        avg = sum(moves) / len(moves)
        sd, _ = rules_v3.daily_sd_from_closes(dcs, 20, 30)
        if not sd or avg / sd < 3:
            return "Earnings move under 3 normal days"
        if max(moves) / avg > 2.2:
            return "Gapper (worst move too big)"
        return None

    @staticmethod
    def parity_spot(rows, exp):
        """Stock price implied by the option quotes themselves (put-call parity at the strikes where the
        call and put are closest in price). Yahoo's daily closes are adjusted for later splits and
        spin-offs (PANW, MMM, T, FDX...), while the option strikes are as they were that day."""
        calls, puts = {}, {}
        for r in rows:
            if r["expiration"] != exp:
                continue
            b, a = float(r["bid"] or 0), float(r["ask"] or 0)
            if a <= 0:
                continue
            (calls if r["call_put"] == "Call" else puts)[float(r["strike"])] = (b + a) / 2
        ks = sorted(set(calls) & set(puts), key=lambda k: abs(calls[k] - puts[k]))[:2]
        if not ks:
            return None
        return sum(k + calls[k] - puts[k] for k in ks) / len(ks)

    @staticmethod
    def quote(r):
        f = lambda x: float(x) if x not in (None, "") else 0.0
        return OptionQuote(strike=float(r["strike"]), option_type="call" if r["call_put"] == "Call" else "put",
                           delta=f(r.get("delta")), iv=f(r.get("vol")), bid=f(r["bid"]), ask=f(r["ask"]))

    def evaluate(self, c, rows, rules):
        exps = sorted({r["expiration"] for r in rows})
        reaction = c["report"] if c["timing"] == "BMO" else self.next_td(c["report"])
        front = next((e for e in exps if e >= reaction), None)
        if not front:
            return None, None
        fq = [self.quote(r) for r in rows if r["expiration"] == front]
        back = strategy_core.pick_back_month_expiration(exps, front, self.CFG, today=c["qday"])
        bq = [self.quote(r) for r in rows if r["expiration"] == back] if back else None
        s = c["sym"]
        qd = c["qday"]   # the day the quotes are from (the scan day, or 1 trading day earlier if missing)
        spot = self.closes[s][qd]
        ps = self.parity_spot(rows, front)
        if ps and abs(ps / spot - 1) > 0.03:   # adjusted close doesn't match the strikes: use the real price
            spot = ps
        dte = max((dt.date.fromisoformat(front) - dt.date.fromisoformat(qd)).days, 1)
        v = self.vols[s]
        avg_vol = float(v[v.index.strftime("%Y-%m-%d") < qd].tail(20).mean())
        past = [e for e in self.events[s] if e[0] < c["report"]]
        with contextlib.redirect_stdout(io.StringIO()):
            sig = rules_v3.evaluate_ticker_v3(s, fq, spot, front, dte, self.closes_before(s, qd), past, bq,
                                              rules, self.CFG, stock_avg_volume=avg_vol, report_date=c["report"])
        return sig, dict(front=front, back=back, dte=dte, spot=spot)

    # ---------- P&L ----------
    @staticmethod
    def leg(rows, exp, strike, side):
        cp = "Call" if side == "call" else "Put"
        for r in rows:
            if r["expiration"] == exp and abs(float(r["strike"]) - strike) < 1e-6 and r["call_put"] == cp:
                return float(r["bid"] or 0), float(r["ask"] or 0)
        return None

    def pnl(self, t, exit_rows):
        sig = t["sig"]; sp = sig.candidate
        side, exp, n = sp.side, t["front"], sig.contracts
        eS, eL = (sp.short.bid, sp.short.ask), (sp.long.bid, sp.long.ask)
        xS, xL = self.leg(exit_rows, exp, sp.short.strike, side), self.leg(exit_rows, exp, sp.long.strike, side)
        if xS is None or xL is None:
            return None
        fee = COMMISSION * 2 * n * 2
        out = {}
        for s in SLIPPAGE:
            mid = lambda q: (q[0] + q[1]) / 2
            hs = lambda q: (q[1] - q[0]) / 2
            credit = (mid(eS) - s * hs(eS)) - (mid(eL) + s * hs(eL))
            cost = (mid(xS) + s * hs(xS)) - (mid(xL) - s * hs(xL))
            cost = min(max(cost, 0.0), sp.width)     # a spread is worth between 0 and its width
            out[str(s)] = round((credit - cost) * 100 * n - fee, 2)
        mid_credit = (eS[0] + eS[1]) / 2 - (eL[0] + eL[1]) / 2
        mid_exit = min(max((xS[0] + xS[1]) / 2 - (xL[0] + xL[1]) / 2, 0.0), sp.width)
        return dict(pnl=out, fee=fee, credit=round(mid_credit, 2), exit=round(mid_exit, 2),
                    short_exit=xS, long_exit=xL)

    # ---------- run ----------
    def run(self, end=None):
        self.load()
        end = end or END or self.tdays[-1]
        cands = self.candidates(end)
        skips = {}
        live = []
        for c in cands:
            why = self.prefilter(c)
            if why:
                skips[why] = skips.get(why, 0) + 1
            else:
                live.append(c)
        by_day = {}
        for c in live:
            by_day.setdefault(c["entry"], []).append(c)
        print(f"{len(cands)} reports, {len(live)} pass the no-option-data rules, {len(by_day)} scan days", file=sys.stderr)
        results = {"headline": [], "all_rules": []}
        missing = 0
        # quotes: the scan day; the database skips some days, so fall back to 1 trading day earlier
        self.prefetch([(c["entry"], c["sym"]) for c in live])
        for c in live:
            c["qday"], c["entry_shift"] = c["entry"], 0
            if not self.chains(c["entry"], [c["sym"]]).get(c["sym"]):
                c["qday"], c["entry_shift"] = self.prev_td(c["entry"]), 1
        self.prefetch([(c["qday"], c["sym"]) for c in live if c["entry_shift"]])
        for i, (day, cs) in enumerate(sorted(by_day.items())):
            for key, rules in (("headline", self.rules_headline), ("all_rules", self.rules_all)):
                sigs = []
                for c in cs:
                    rows = self.chains(c["qday"], [c["sym"]]).get(c["sym"]) or []
                    if c["qday"] not in self.closes[c["sym"]]:
                        rows = []
                    if not rows:
                        if key == "headline":
                            missing += 1
                        continue
                    sig, info = self.evaluate(c, rows, rules)
                    if sig is None:
                        continue
                    sigs.append((c, sig, info))
                rules_v2.rank_and_select([s for _, s, _ in sigs], rules)
                for c, sig, info in sigs:
                    if key == "headline" and not sig.tradeable:
                        lab = reason_label(sig.reason)
                        skips[lab] = skips.get(lab, 0) + 1
                    if sig.tradeable:
                        results[key].append(dict(c, sig=sig, **info))
            if i % 25 == 0:
                print(f"  scan day {i + 1}/{len(by_day)} {day}", file=sys.stderr)
        # exits
        # exits: the reaction day; if the database has no quote that day, 1 trading day later
        alltr = [t for key in results for t in results[key]]
        self.prefetch([(t["exit"], t["sym"]) for t in alltr])
        self.prefetch([(self.next_td(t["exit"]), t["sym"]) for t in alltr
                       if not self.chains(t["exit"], [t["sym"]]).get(t["sym"]) and self.next_td(t["exit"]) <= end])
        out = {}
        t_noexit = {}
        for key, ts in results.items():
            rows = []
            noexit = 0
            for t in ts:
                t["xday"], t["exit_shift"] = t["exit"], 0
                p = self.pnl(t, self.chains(t["exit"], [t["sym"]]).get(t["sym"]) or [])
                nx = self.next_td(t["exit"])
                if p is None and nx and nx <= end:
                    p = self.pnl(t, self.chains(nx, [t["sym"]]).get(t["sym"]) or [])
                    t["xday"], t["exit_shift"] = nx, 1
                if p is None:
                    noexit += 1
                    sp = t["sig"].candidate
                    ex_rows = self.chains(t["exit"], [t["sym"]]).get(t["sym"]) or []
                    nx_rows = self.chains(nx, [t["sym"]]).get(t["sym"]) or [] if nx and nx <= end else []
                    px_exit = (self.closes[t["sym"]][t["exit"]] * t["spot"] / self.closes[t["sym"]][t["qday"]]
                               if t["exit"] in self.closes[t["sym"]] else None)
                    t_noexit.setdefault(key, []).append(dict(
                        sym=t["sym"], entry=t["qday"], exit=t["exit"], side=sp.side, short=sp.short.strike,
                        long=sp.long.strike, expiry=t["front"], contracts=t["sig"].contracts,
                        credit=round(sp.short.mid - sp.long.mid, 2), width=sp.width,
                        exit_close=px_exit, chain_on_exit_day=bool(ex_rows), chain_next_day=bool(nx_rows),
                        expiry_listed_exit_day=any(r["expiration"] == t["front"] for r in ex_rows + nx_rows)))
                    continue
                sig = t["sig"]; sp = sig.candidate
                rows.append(dict(
                    report=t["report"], timing=t["timing"], entry=t["qday"], exit=t["xday"], sym=t["sym"],
                    entry_shift=t["entry_shift"], exit_shift=t["exit_shift"],
                    side=sp.side, short=sp.short.strike, long=sp.long.strike, expiry=t["front"], dte=t["dte"],
                    contracts=sig.contracts, spot=round(t["spot"], 2), credit=p["credit"], exit_value=p["exit"],
                    width=sp.width, fee=p["fee"], pnl=p["pnl"]["0.0"], pnl_slip=p["pnl"],
                    implied=round(sig.implied_move_earn or 0, 4), hist=round(sig.historical_avg_move or 0, 4),
                    move=round(self.closes[t["sym"]].get(t["xday"], 0) / self.closes[t["sym"]][t["qday"]] - 1, 4)
                    if t["xday"] in self.closes[t["sym"]] else None,
                    exit_stock=round(self.closes[t["sym"]][t["xday"]] * t["spot"] / self.closes[t["sym"]][t["qday"]], 2)
                    if t["xday"] in self.closes[t["sym"]] else None,
                    strike_source=getattr(sig, "strike_source", None)))
            rows.sort(key=lambda r: (r["exit"], r["sym"]))
            out[key] = dict(trades=rows, no_exit_quote=noexit, no_exit_trades=t_noexit.get(key, []))
        return dict(cands=len(cands), passed_prefilter=len(live), scan_days=len(by_day),
                    missing_chain=missing, skips=skips, end=end, **out)


def reason_label(r):
    r = str(r or "")
    import re
    for pat, lab in [(r"^low volume", "Options volume too low"), (r"price floor", "Stock under $20"),
                     (r"normal days", "Earnings move under 3 normal days"), (r"^gapper", "Gapper (worst move too big)"),
                     (r"last year", "Implied move below last year's same-quarter move"),
                     (r"avg past move", "Implied move below the average past move"),
                     (r"term structure", "Term structure flat"), (r"usable past reports", "Not enough earnings history"),
                     (r"^CANDIDATE", "Not in the day's top 3"), (r"max loss per contract", "Max loss per spread over budget"),
                     (r"bump|distance-rule", "No strike far enough / credit too small"), (r"credit", "Credit too small"),
                     (r"straddle", "No at-the-money quote")]:
        if re.search(pat, r, re.I):
            return lab
    return "Other"


def stats(trades, key="pnl"):
    pn = [t[key] if key == "pnl" else t["pnl_slip"][key] for t in trades]
    if not pn:
        return dict(n=0)
    cum, peak, dd = 0.0, 0.0, 0.0
    for x in pn:
        cum += x; peak = max(peak, cum); dd = min(dd, cum - peak)
    wins = [x for x in pn if x > 0]
    return dict(n=len(pn), wins=len(wins), win_rate=round(len(wins) / len(pn), 4), total=round(sum(pn), 2),
                avg=round(sum(pn) / len(pn), 2), max_dd=round(dd, 2), best=round(max(pn), 2), worst=round(min(pn), 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scanner-dir", default=os.path.join(HERE, "..", "..", "earnings-iv-crush"))
    ap.add_argument("--cache", default=os.path.join(HERE, "cache"))
    ap.add_argument("--out", default=os.path.join(HERE, "backtest.json"))
    a = ap.parse_args()
    bt = Backtest(a.scanner_dir, a.cache)
    r = bt.run()
    write_json(r, a.out)


def write_json(r, path):
    head = r["headline"]["trades"]
    allr = r["all_rules"]["trades"]
    months = {}
    for t in head:
        m = t["exit"][:7]
        mm = months.setdefault(m, dict(month=m, n=0, wins=0, pnl=0.0))
        mm["n"] += 1; mm["wins"] += t["pnl"] > 0; mm["pnl"] = round(mm["pnl"] + t["pnl"], 2)
    years = {}
    for t in head:
        y = t["exit"][:4]
        yy = years.setdefault(y, dict(year=y, n=0, wins=0, pnl=0.0))
        yy["n"] += 1; yy["wins"] += t["pnl"] > 0; yy["pnl"] = round(yy["pnl"] + t["pnl"], 2)
    doc = dict(
        generated_utc=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M"),
        range=dict(start=head[0]["exit"] if head else None, end=head[-1]["exit"] if head else None,
                   searched_from=START, searched_to=r["end"]),
        universe="193 large, liquid optionable US stocks (backtest/events.csv)",
        reports_checked=r["cands"], passed_no_option_rules=r["passed_prefilter"], scan_days=r["scan_days"],
        missing_chain=r["missing_chain"], no_exit_quote=r["headline"]["no_exit_quote"],
        entry_shifted=sum(t["entry_shift"] for t in head), exit_shifted=sum(t["exit_shift"] for t in head),
        no_exit_breached=sum(1 for t in r["headline"]["no_exit_trades"] if t["exit_close"] is not None and
                             ((t["exit_close"] < t["short"]) if t["side"] == "put" else (t["exit_close"] > t["short"]))),
        priced_breached=sum(1 for t in head if t.get("exit_stock") is not None and
                            ((t["exit_stock"] < t["short"]) if t["side"] == "put" else (t["exit_stock"] > t["short"]))),
        no_exit_trades=[{k: t[k] for k in ("sym", "entry", "exit", "side", "short", "long", "exit_close")}
                        for t in r["headline"]["no_exit_trades"]],
        skip_reasons=sorted(r["skips"].items(), key=lambda kv: -kv[1])[:12],
        commission=COMMISSION, slippage_levels=SLIPPAGE,
        stats=stats(head), stats_slippage={str(s): stats(head, str(s)) for s in SLIPPAGE},
        stats_all_rules=stats(allr), all_rules_trades=len(allr),
        months=sorted(months.values(), key=lambda m: m["month"]),
        years=sorted(years.values(), key=lambda y: y["year"]),
        trades=head, deviations=DEVIATIONS,
        source=dict(options="DoltHub post-no-preference/options (free public database, end-of-day quotes)",
                    earnings="Yahoo earnings dates + DoltHub post-no-preference/earnings calendar",
                    prices="Yahoo daily bars", rules="scanner rules_v3 (earnings-iv-crush cb866eb)"))
    json.dump(doc, open(path, "w"), indent=1)
    return doc


if __name__ == "__main__":
    main()
