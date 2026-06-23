"""
PNTHR Den — IBKR TWS Bridge (Phase 2: Auto-Close from TWS Fills)

Connects to TWS, reads account + positions + open stop orders every 60 seconds,
pushes to the PNTHR Den server. Runs alongside TWS Mosaic.
TWS continues operating completely normally — this is a passive observer only.

Usage:
  python pnthr-ibkr-bridge.py          # Live account (port 7496)
  python pnthr-ibkr-bridge.py --paper  # Paper account (port 7497)

Prerequisites:
  pip install ibapi requests python-dotenv

.env file (same directory as this script, never committed to git):
  PNTHR_TOKEN=eyJhbGciOiJIUzI1NiIs...   ← your JWT from PNTHR Den localStorage
  PNTHR_API_URL=https://pnthr100-scanner-api.onrender.com
  TWS_HOST=127.0.0.1
  TWS_PORT=7496
  TWS_CLIENT_ID=99
"""

import os
import sys
import time
import threading
import requests
from datetime import datetime, timezone, timedelta
try:
    from zoneinfo import ZoneInfo          # Python 3.9+
    _ET = ZoneInfo('America/New_York')     # handles EST/EDT automatically
except ImportError:
    _ET = timezone(timedelta(hours=-4))    # fallback: EDT only (no DST awareness)

try:
    from ibapi.client import EClient
    from ibapi.wrapper import EWrapper
    from ibapi.execution import ExecutionFilter
    from ibapi.contract import Contract
    from ibapi.order    import Order
except ImportError:
    print("[BRIDGE] ERROR: ibapi not installed. Run: pip install ibapi")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '.env.bridge'))
except ImportError:
    pass  # python-dotenv optional — env vars can be set manually

# ── Configuration ─────────────────────────────────────────────────────────────
PNTHR_TOKEN   = os.getenv('PNTHR_TOKEN')
PNTHR_API_URL = os.getenv('PNTHR_API_URL', 'http://localhost:5000')
TWS_HOST      = os.getenv('TWS_HOST', '127.0.0.1')
TWS_PORT      = int(os.getenv('TWS_PORT', '7496'))
# Client ID 0 is REQUIRED for self-healing, not cosmetic. Per the IBKR TWS API, only a
# client connecting with ID 0 can "take over" orders that are not bound to it. After TWS's
# nightly restart, the engine's own GTC protective stops come back UNBOUND (orderId 0, PNTHR
# tag stripped) and become uncancellable by any client EXCEPT id 0. As id 0, reqOpenOrders()
# BINDS those orphaned stops (assigns a real orderId) so the engine can cancel/retrail them
# automatically — zero human intervention. A non-zero id cannot, which is exactly what
# stranded 17 stops as uncancellable orphans and stacked the KLAC/LRCX duplicates on
# 2026-06-23. The local .env.bridge must ALSO set TWS_CLIENT_ID=0 (it overrides this default).
TWS_CLIENT_ID = int(os.getenv('TWS_CLIENT_ID', '0'))
SYNC_INTERVAL = 60  # seconds between read-only pushes

# ── Phase 4 write configuration ──────────────────────────────────────────────
# Master kill switch — when false (default) the outbox poller does nothing.
# Per-action gating lives server-side in the enqueue hooks (IBKR_AUTO_*
# env vars on Render). Both layers must be on for a command to flow.
IBKR_WRITES_ENABLED = os.getenv('IBKR_WRITES_ENABLED', 'false').lower() == 'true'
# 679/Carnivore (MAIN outbox) execution poller. DEFAULT OFF (Scott 2026-06-05: ONLY Ambush
# trades on this account). When false, the bridge never starts the 679 execution thread, so a
# non-Ambush order cannot execute through this bridge. Read-only views are unaffected.
MAIN_OUTBOX_ENABLED = os.getenv('MAIN_OUTBOX_ENABLED', 'false').lower() == 'true'
# Dry-run logs commands and reports DONE without actually calling IB API.
# Useful to verify the wire format before flipping IBKR_WRITES_ENABLED.
IBKR_WRITES_DRY_RUN = os.getenv('IBKR_WRITES_DRY_RUN', 'true').lower() == 'true'
# Ambush-ONLY dry-run: logs Ambush commands as DONE without calling IB, while the
# main 679/Carnivore outbox keeps trading for real. Lets Ambush dry-run in isolation.
AMBUSH_DRY_RUN      = os.getenv('AMBUSH_DRY_RUN', 'false').lower() == 'true'
OUTBOX_POLL_SEC     = int(os.getenv('OUTBOX_POLL_SEC', '30'))
OUTBOX_STALE_SEC    = int(os.getenv('OUTBOX_STALE_SEC', '600'))  # 10 min

# Rate limits — hard-coded per the locked design (PLAN_2026-04-29.md universal
# guardrails). Bridge enforces these even if server-side enqueue ever bypasses
# its own checks.
RATE_PER_SYMBOL_PER_MIN = 5
RATE_GLOBAL_PER_MIN     = 50

if '--paper' in sys.argv:
    TWS_PORT = 7497
    print("[BRIDGE] Using PAPER account (port 7497)")


# ── Rate limiter — token bucket per symbol + global ──────────────────────────
# Used by Phase 4 write methods. Cap is hardcoded (5/min/symbol, 50/min global)
# per the locked design. Read-only sync calls are not rate-limited.
class RateLimiter:
    def __init__(self, per_symbol, per_global):
        self.per_symbol = per_symbol
        self.per_global = per_global
        self._symbol_history = {}  # symbol → [timestamps]
        self._global_history = []
        self._lock = threading.Lock()

    def can_send(self, symbol):
        now = time.time()
        cutoff = now - 60.0
        with self._lock:
            self._global_history = [t for t in self._global_history if t > cutoff]
            sym_hist = [t for t in self._symbol_history.get(symbol, []) if t > cutoff]
            self._symbol_history[symbol] = sym_hist
            if len(self._global_history) >= self.per_global:
                return False, 'GLOBAL_RATE_LIMIT'
            if len(sym_hist) >= self.per_symbol:
                return False, 'SYMBOL_RATE_LIMIT'
            return True, None

    def record(self, symbol):
        now = time.time()
        with self._lock:
            self._global_history.append(now)
            self._symbol_history.setdefault(symbol, []).append(now)


# ── TWS Bridge App ─────────────────────────────────────────────────────────────
class PNTHRBridge(EWrapper, EClient):
    """
    Connects to TWS via the socket API, collects account data and positions,
    then pushes a JSON snapshot to the PNTHR Den server every 60 seconds.

    Phase 1/2/3: read-only sync (NAV, positions, stop orders, executions).
    Phase 4 (gated by IBKR_WRITES_ENABLED): also processes the server-side
    outbox queue, placing/cancelling/modifying stop orders in TWS.
    """

    def __init__(self):
        EClient.__init__(self, self)
        self.account_values  = {}
        # ── positions stored as dict keyed by symbol ──────────────────────────
        # Using a dict (not a list) means:
        #   • Closing a position (pos=0) immediately deletes the key — no stale entries
        #   • Re-opening the same ticker overwrites cleanly — no duplicates on reconnect
        #   • get_payload() converts to list for the server JSON payload
        self.positions_dict  = {}
        self.open_orders     = {}   # permId → {orderId, symbol, stopPrice, action, orderType, shares}
        self.executions      = []   # Phase 2: fills captured via reqExecutions
        self.account_ready   = threading.Event()
        self.positions_ready = threading.Event()
        self.orders_ready    = threading.Event()
        self.executions_ready = threading.Event()
        self.connected       = False
        self.account_id      = None
        self._exec_req_id    = 2000  # increments each cycle to avoid stale callbacks
        # ── Phase 4 write-side state ──────────────────────────────────────────
        # nextValidId is set by IB on connection — every subsequent placeOrder
        # call must use a unique, monotonically increasing ID. We allocate by
        # incrementing past the seed value.
        self._next_order_id     = None
        self._next_order_lock   = threading.Lock()
        self._order_status      = {}  # orderId → {status, permId, filled, ...}
        self._order_status_lock = threading.Lock()
        # ── IBKR historical hourly bars (2026-06-03, READ-ONLY) ───────────────
        # Feeds the Ambush 2-bar-low exit + breakout re-entry with TRUE IBKR bars
        # (matching the trader's TWS chart). Separate reqId space from orders.
        self._hist_req_id   = 9000
        self._hist_lock     = threading.Lock()
        self._hist_bars     = {}   # reqId → [bar dicts]
        self._hist_done     = {}   # reqId → threading.Event

    # ── Connection lifecycle ──────────────────────────────────────────────────
    def connectAck(self):
        print("[BRIDGE] Connected to TWS ✓")
        self.connected = True

    def connectionClosed(self):
        print("[BRIDGE] Disconnected from TWS")
        self.connected = False

    def error(self, reqId, errorCode, errorString, advancedOrderRejectJson=""):
        # Suppress routine market-data farm messages
        if errorCode in (2104, 2106, 2107, 2108, 2119, 2158):
            return
        if errorCode == 502:
            print("[BRIDGE] Cannot connect to TWS — is it running with API enabled?")
            print("[BRIDGE] Check: TWS → Edit → Global Configuration → API → Settings")
            return
        if errorCode == 504:
            print("[BRIDGE] Not connected to TWS")
            return
        # Error 10147 = "OrderId X that needs to be cancelled is not found".
        # TWS has no record of this orderId — the order is already gone (filled,
        # manually cancelled in TWS, expired, or a stale orderId from our cache
        # that was rebuilt during a reconnect). The desired end state of a
        # cancel is "order absent" — and absent it is. Mark the orderId as
        # ALREADY_GONE in _order_status so the cancel waiter in
        # cancel_order_by_perm_id exits successfully instead of timing out and
        # dragging MODIFY_LOT_TRIGGER / MODIFY_STOP into PHASE_CANCEL failure.
        if errorCode == 10147 and isinstance(reqId, int) and reqId > 0:
            with self._order_status_lock:
                prev = self._order_status.get(reqId, {})
                self._order_status[reqId] = {
                    **prev,
                    'orderId':   reqId,
                    'status':    'ALREADY_GONE',
                    'updatedAt': time.time(),
                }
            print(f"[BRIDGE] TWS Error 10147 for orderId {reqId}: treating as already-gone (cancel succeeds)")
            return
        print(f"[BRIDGE] TWS Error {errorCode}: {errorString}")

    def nextValidId(self, orderId):
        """Called when the connection is fully established and ready.
        Phase 4 needs this seed value to allocate IDs for new orders."""
        with self._next_order_lock:
            self._next_order_id = int(orderId)
        print(f"[BRIDGE] Ready (next order ID: {orderId})")

    # ── Data requests ─────────────────────────────────────────────────────────
    def _request_data(self):
        """Request fresh account + position data from TWS."""
        self.account_values  = {}
        self.positions_dict  = {}  # clear dict so re-subscription starts fresh
        self.account_ready.clear()
        self.positions_ready.clear()
        self.reqAccountUpdates(True, "")   # "" = default account
        self.reqPositions()

    # ── Account data callbacks ────────────────────────────────────────────────
    def updateAccountValue(self, key, val, currency, accountName):
        self.account_id = accountName
        if currency in ('USD', ''):
            self.account_values[key] = {'value': val, 'currency': currency}

    def updatePortfolio(self, contract, position, marketPrice, marketValue,
                        averageCost, unrealizedPNL, realizedPNL, accountName):
        symbol = contract.symbol
        if position != 0:
            # Upsert: adds new or overwrites existing entry for this symbol
            self.positions_dict[symbol] = {
                'symbol':        symbol,
                'secType':       contract.secType,
                'currency':      contract.currency,
                'shares':        float(position),
                'marketPrice':   float(marketPrice),
                'marketValue':   float(marketValue),
                'avgCost':       float(averageCost),
                'unrealizedPNL': float(unrealizedPNL),
                'realizedPNL':   float(realizedPNL),
            }
        else:
            # position=0 means TWS just confirmed this position is fully closed.
            # Remove it immediately so the next sync doesn't send stale share counts.
            self.positions_dict.pop(symbol, None)

    def accountDownloadEnd(self, accountName):
        self.account_ready.set()

    def position(self, account, contract, pos, avgCost):
        """Fallback position handler — populates positions_dict from reqPositions().

        updatePortfolio (from reqAccountUpdates) is primary and provides richer data
        (marketPrice, marketValue, unrealizedPNL). But TWS has a known quirk where
        reqAccountUpdates streams account values (NAV) without streaming portfolio
        callbacks. When that happens, this fallback ensures positions still sync
        via the reliable reqPositions() path. If updatePortfolio fires later, it
        overwrites with richer data. Market-price-dependent fields default to 0
        until updatePortfolio catches up.
        """
        symbol = contract.symbol
        if pos != 0:
            # Only populate if not already set by updatePortfolio (avoid clobbering richer data)
            if symbol not in self.positions_dict:
                self.positions_dict[symbol] = {
                    'symbol':        symbol,
                    'secType':       contract.secType,
                    'currency':      contract.currency,
                    'shares':        float(pos),
                    'marketPrice':   0.0,   # filled by updatePortfolio when it fires
                    'marketValue':   0.0,   # filled by updatePortfolio when it fires
                    'avgCost':       float(avgCost),
                    'unrealizedPNL': 0.0,   # filled by updatePortfolio when it fires
                    'realizedPNL':   0.0,   # filled by updatePortfolio when it fires
                }
        else:
            self.positions_dict.pop(symbol, None)

    def positionEnd(self):
        self.positions_ready.set()

    # ── Open order callbacks ───────────────────────────────────────────────────
    def openOrder(self, orderId, contract, order, orderState):
        """Capture live stop orders placed in TWS. Called once per order."""
        if order.orderType not in ('STP', 'STP LMT'):
            return
        try:
            stop_price = float(order.auxPrice)
        except (TypeError, ValueError):
            return
        if stop_price <= 0:
            return
        try:
            shares = float(order.totalQuantity)
        except (TypeError, ValueError):
            shares = 0.0
        # Key by permId (permanent unique ID assigned by TWS). Orders placed
        # manually in TWS — not by this API client — come back with orderId=0,
        # so keying by orderId would collapse them all into a single entry.
        # permId is guaranteed unique across the account lifetime.
        perm_id = getattr(order, 'permId', 0) or 0
        key = perm_id if perm_id else f"_synth_{len(self.open_orders)}_{contract.symbol}_{orderId}"
        # Capture orderRef — empty/missing for orders the user entered manually
        # in TWS, set to 'PNTHR' for orders this bridge placed via the API.
        # The orphan janitor uses this as its primary whitelist.
        order_ref = (getattr(order, 'orderRef', '') or '').strip()
        # DOWNGRADE GUARD (2026-06-05): a single sync calls reqOpenOrders() (binds
        # THIS client's own orders → real orderId + 'PNTHR' ref) then reqAllOpenOrders()
        # (captures manual TWS orders too, but may re-report our own orders UNBOUND:
        # orderId 0, empty ref). Never let the unbound report overwrite the bound one —
        # an orderId-0 entry is uncancellable (TWS error 10147) and that is exactly
        # what created the restart orphans (BABA/WRD 2026-06-05). Keep the strongest
        # identity seen for this permId this sync.
        prior = self.open_orders.get(key)
        if prior:
            if not orderId and prior.get('orderId'):
                orderId = prior['orderId']
            if not order_ref and prior.get('orderRef'):
                order_ref = prior['orderRef']
        self.open_orders[key] = {
            'orderId':   orderId,
            'permId':    perm_id,
            'symbol':    contract.symbol.upper(),
            'stopPrice': round(stop_price, 4),
            'action':    order.action,
            'orderType': order.orderType,
            'shares':    shares,
            'orderRef':  order_ref,
        }

    def openOrderEnd(self):
        """All open orders have been delivered for this request."""
        self.orders_ready.set()

    # ── Phase 4 order-status tracking ─────────────────────────────────────────
    # orderStatus callback fires multiple times per order lifecycle (Submitted,
    # PreSubmitted, Filled, Cancelled). Phase 4 write methods wait for a
    # terminal status (Submitted/Cancelled/Filled) before reporting back to
    # the outbox, so the server only sees DONE when TWS has actually accepted
    # the order.
    def orderStatus(self, orderId, status, filled, remaining, avgFillPrice,
                    permId, parentId, lastFillPrice, clientId, whyHeld, mktCapPrice):
        with self._order_status_lock:
            prev = self._order_status.get(orderId, {})
            self._order_status[orderId] = {
                'orderId':       orderId,
                'status':        status,
                'permId':        int(permId) if permId else prev.get('permId'),
                'filled':        float(filled or 0),
                'remaining':     float(remaining or 0),
                'avgFillPrice':  float(avgFillPrice or 0),
                'whyHeld':       whyHeld or '',
                'updatedAt':     time.time(),
            }

    # ── Execution callbacks (Phase 2) ─────────────────────────────────────────
    def execDetails(self, reqId, contract, execution):
        """Called once per execution when reqExecutions() is invoked."""
        if contract.secType != 'STK':
            return  # ignore options, futures, etc.
        try:
            price  = float(execution.price)
            shares = float(execution.shares)
        except (TypeError, ValueError):
            return
        if price <= 0 or shares <= 0:
            return
        self.executions.append({
            'execId':   execution.execId,
            'symbol':   contract.symbol.upper(),
            'side':     execution.side,    # 'BOT' (bought) or 'SLD' (sold)
            'shares':   shares,
            'price':    round(price, 4),
            'avgPrice': round(float(execution.avgPrice or price), 4),
            'time':     execution.time,    # "YYYYMMDD  HH:MM:SS" format
            'orderId':  execution.orderId,
        })

    def execDetailsEnd(self, reqId):
        """All executions for this request have been delivered."""
        self.executions_ready.set()

    # ── Phase 4 write methods ─────────────────────────────────────────────────
    # Each method places exactly ONE IB API call (or a cancel + place pair for
    # MODIFY_STOP) and returns a structured result the outbox poller can ship
    # back to the server. None of these methods touch the read-only payload
    # path — they're side-channel calls into the existing IB API connection.

    def _allocate_order_id(self):
        """Allocate the next unique orderId. Each placeOrder must use a fresh
        ID so IB API can route status callbacks correctly."""
        with self._next_order_lock:
            if self._next_order_id is None:
                return None
            oid = self._next_order_id
            self._next_order_id += 1
            return oid

    def _wait_for_status(self, order_id, terminal_states, timeout=15.0):
        """Poll _order_status until one of the terminal_states arrives or
        timeout. Returns the latest status dict (or None if no status ever
        landed). terminal_states is e.g. ('Submitted','PreSubmitted','Filled')
        for a place_order or ('Cancelled','ApiCancelled') for a cancel."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._order_status_lock:
                st = self._order_status.get(order_id)
            if st and st['status'] in terminal_states:
                return st
            time.sleep(0.25)
        with self._order_status_lock:
            return self._order_status.get(order_id)

    @staticmethod
    def _build_stock_contract(ticker):
        c = Contract()
        c.symbol   = ticker.upper()
        c.secType  = 'STK'
        c.exchange = 'SMART'
        c.currency = 'USD'
        return c

    # ── IBKR historical hourly bars (2026-06-03, READ-ONLY) ──────────────────
    def historicalData(self, reqId, bar):
        with self._hist_lock:
            self._hist_bars.setdefault(reqId, []).append({
                'date':  bar.date,
                'open':  float(bar.open),
                'high':  float(bar.high),
                'low':   float(bar.low),
                'close': float(bar.close),
            })

    def historicalDataEnd(self, reqId, start, end):
        ev = self._hist_done.get(reqId)
        if ev:
            ev.set()

    def fetch_hourly_bars(self, ticker, timeout=15):
        """READ-ONLY: ~2 days of 1-hour RTH bars from IBKR via reqHistoricalData.
        Returns [{date,open,high,low,close}] (TWS order) or [] on timeout/error.
        Never places an order."""
        with self._hist_lock:
            self._hist_req_id += 1
            req_id = self._hist_req_id
            self._hist_bars[req_id] = []
        ev = threading.Event()
        self._hist_done[req_id] = ev
        try:
            self.reqHistoricalData(
                req_id, self._build_stock_contract(ticker),
                '', '2 D', '1 hour', 'TRADES', 1, 1, False, [])
        except Exception as e:
            print(f"[BARS] reqHistoricalData failed for {ticker}: {e}")
            self._hist_done.pop(req_id, None)
            with self._hist_lock:
                self._hist_bars.pop(req_id, None)
            return []
        got = ev.wait(timeout)
        with self._hist_lock:
            bars = self._hist_bars.pop(req_id, [])
        self._hist_done.pop(req_id, None)
        if not got:
            print(f"[BARS] {ticker}: timeout after {timeout}s ({len(bars)} partial bars)")
        # Drop the still-forming current-hour bar (2026-06-03). reqHistoricalData with
        # endDateTime='' returns the in-progress bar as the LAST element while its hour
        # is still open. The engine's 2-bar exit must use COMPLETED bars only — shipping
        # the forming bar made the trailing stop flip between bars and sit at the wrong
        # level (GFS/FN/MKSI/EA never fired at the true 2-bar low). Bar labels and
        # datetime.now() are both this machine's local TZ (= the TWS account TZ), so the
        # last bar is still forming whenever now < bar_start + 1 hour.
        if bars:
            try:
                parts = bars[-1]['date'].split()
                bar_start = datetime.strptime(parts[0] + ' ' + parts[1], '%Y%m%d %H:%M:%S')
                if datetime.now() < bar_start + timedelta(hours=1):
                    dropped = bars.pop()
                    print(f"[BARS] {ticker}: dropped forming bar {dropped['date']} (completed bars only)")
            except Exception as e:
                print(f"[BARS] {ticker}: forming-bar check skipped ({e})")
        return bars

    # Order-reference tag stamped on every order PNTHR places via the API.
    # TWS's manual order entry UI does NOT expose this field, so any order
    # carrying this tag was placed by us. The orphan janitor uses this as a
    # whitelist: only orders tagged with PNTHR_ORDER_REF are eligible for
    # auto-cancel. Manual stops/limits the user places directly in TWS will
    # have an empty orderRef and are invisible to the janitor.
    PNTHR_ORDER_REF = 'PNTHR'

    def place_protective_stop(self, ticker, action, shares, stop_price,
                              tif='GTC', rth=True, order_type='STP', limit_price=None):
        """Place a protective stop. Action is 'SELL' for LONG, 'BUY' for SHORT.

        Two shapes (per Phase 4 locked design):
          • RTH default: order_type='STP', limit_price=None — pure stop-market.
          • Extended hours: order_type='STP LMT', limit_price set by caller —
            IBKR rejects STP outside RTH, so the server sends STP LMT with a
            slippage-cushion lmtPrice when stopExtendedHours=True.

        Returns {ok, orderId, permId, status, error}."""
        if not self.connected:
            return {'ok': False, 'error': 'BRIDGE_DISCONNECTED'}
        oid = self._allocate_order_id()
        if oid is None:
            return {'ok': False, 'error': 'NO_NEXT_ORDER_ID'}
        order_type = (order_type or 'STP').upper()
        if order_type == 'STP LMT' and (limit_price is None or float(limit_price) <= 0):
            return {'ok': False, 'error': 'STP_LMT_REQUIRES_LIMIT_PRICE'}
        contract = self._build_stock_contract(ticker)
        order = Order()
        order.action        = action.upper()
        order.orderType     = order_type
        order.auxPrice      = float(stop_price)
        if order_type == 'STP LMT':
            order.lmtPrice  = float(limit_price)
        order.totalQuantity = int(shares)
        order.tif           = tif
        order.outsideRth    = not rth
        # Stamp the PNTHR fingerprint so the orphan janitor can distinguish
        # bridge-placed orders from manual orders the trader entered in TWS.
        order.orderRef      = self.PNTHR_ORDER_REF
        # Disable IB's deprecated/optional flag set explicitly to avoid noisy
        # rejections on newer TWS builds.
        order.eTradeOnly    = False
        order.firmQuoteOnly = False
        try:
            self.placeOrder(oid, contract, order)
        except Exception as e:
            return {'ok': False, 'orderId': oid, 'error': f'PLACE_THREW: {e}'}
        st = self._wait_for_status(oid, ('Submitted', 'PreSubmitted', 'Filled'), timeout=15.0)
        if not st:
            return {'ok': False, 'orderId': oid, 'error': 'NO_STATUS_AFTER_15S'}
        return {
            'ok':      st['status'] in ('Submitted', 'PreSubmitted', 'Filled'),
            'orderId': oid,
            'permId':  st.get('permId'),
            'status':  st['status'],
            'orderType': order_type,
            'orderRef':  self.PNTHR_ORDER_REF,
        }

    def cancel_order_by_perm_id(self, perm_id):
        """Cancel an existing order by permId. Looks up the orderId from our
        cached open_orders map (TWS's manual orders use orderId=0, so cancel
        by permId via the permId-keyed cancelOrder API).

        Idempotent: if the permId is not in our cache, the order is already
        gone (filled, cancelled in TWS, or never existed) — treat as success
        with status='ALREADY_GONE'. Without this, every cancel retry against
        a stale permId fails forever, which (a) leaves CANCEL_RELATED_ORDERS
        marked FAILED so orphan lot triggers sit in TWS, and (b) makes
        MODIFY_STOP abort with the position naked. The desired end state of
        a cancel is "order absent" — and absent it is."""
        if not self.connected:
            return {'ok': False, 'error': 'BRIDGE_DISCONNECTED'}
        # Find the cached order by permId
        target = None
        for k, o in self.open_orders.items():
            if o.get('permId') == perm_id:
                target = o
                break
        if not target:
            return {'ok': True, 'permId': perm_id, 'status': 'ALREADY_GONE'}
        # ibapi signature changed across versions — older releases take just
        # cancelOrder(orderId), newer ones take cancelOrder(orderId, manualOrderCancelTime).
        # Bridge crashed silently on 2026-05-05 13:52 because it always passed
        # 2 args against an older ibapi installation. Try the 2-arg call first,
        # fall back to 1-arg on TypeError so either ibapi version works.
        try:
            self.cancelOrder(target['orderId'], '')
        except TypeError:
            try:
                self.cancelOrder(target['orderId'])
            except Exception as e:
                return {'ok': False, 'error': f'CANCEL_THREW: {e}'}
        except Exception as e:
            return {'ok': False, 'error': f'CANCEL_THREW: {e}'}
        # ALREADY_GONE is set by the error() callback when TWS responds with
        # error 10147 (orderId not found). Treat as a terminal success — the
        # order is absent, which is the desired end state of a cancel.
        st = self._wait_for_status(target['orderId'], ('Cancelled', 'ApiCancelled', 'ALREADY_GONE'), timeout=10.0)
        ok = st is not None and st['status'] in ('Cancelled', 'ApiCancelled', 'ALREADY_GONE')
        return {'ok': ok, 'orderId': target['orderId'], 'permId': perm_id,
                'status': st['status'] if st else 'NO_STATUS'}

    def cancel_related_orders(self, ticker):
        """Cancel every protective stop currently open for `ticker`. Used by
        Phase 4b when a position fully closes."""
        if not self.connected:
            return {'ok': False, 'error': 'BRIDGE_DISCONNECTED'}
        ticker = ticker.upper()
        cancelled = []
        failures  = []
        for k, o in list(self.open_orders.items()):
            if o['symbol'] != ticker or o['orderType'] not in ('STP', 'STP LMT'):
                continue
            res = self.cancel_order_by_perm_id(o['permId'])
            (cancelled if res['ok'] else failures).append({**o, 'result': res})
        return {
            'ok':        len(failures) == 0,
            'cancelled': cancelled,
            'failures':  failures,
        }

    def cancel_pnthr_protective_stops(self, ticker, action=None):
        """Cancel EVERY PNTHR-tagged protective stop (STP / STP LMT) open for `ticker`
        on the given `action` side, so after placing a fresh one there is EXACTLY ONE.
        Manual stops the user entered in TWS (empty orderRef) are LEFT ALONE —
        tightest-stop-wins. This sweeps any duplicate/orphan a single-orderId cancel
        missed: the pre-fix LOT_TRAIL/2BAR_TRACK race AND a cache-miss 'placed_new'
        both left two SE cover stops (90.65 + 92.89). `action` (BUY = short cover /
        SELL = long exit) keeps us off the opposite-side lot triggers (a LONG's BUY-STP
        pyramid adds, a SHORT's SELL-STP adds). Idempotent (ALREADY_GONE = success)."""
        if not self.connected:
            return {'ok': False, 'error': 'BRIDGE_DISCONNECTED'}
        ticker = ticker.upper()
        cancelled, failures = [], []
        for k, o in list(self.open_orders.items()):
            if o.get('symbol') != ticker:
                continue
            if o.get('orderType') not in ('STP', 'STP LMT'):
                continue
            if (o.get('orderRef') or '').strip() != self.PNTHR_ORDER_REF:
                continue  # manual TWS stop — protect it (tightest-stop-wins)
            if action and o.get('action') and o.get('action') != action:
                continue  # opposite side (lot-trigger add) — not a protective stop
            res = self.cancel_order_by_perm_id(o['permId'])
            (cancelled if res['ok'] else failures).append(
                {'permId': o['permId'], 'orderId': o['orderId'], 'stopPrice': o.get('stopPrice'), 'result': res})
        return {'ok': len(failures) == 0, 'cancelled': cancelled, 'failures': failures}

    def sell_position(self, ticker, action, shares, order_type='MKT',
                      limit_price=None, tif='DAY', rth=True):
        """Place a closing sell (LONG) or cover (SHORT) for an existing position.
        Used by Phase 4f when the user clicks 'Close Position' in PNTHR — the
        outbox enqueues a SELL_POSITION command and the bridge places the actual
        TWS order. The fill arrives back via the next bridge sync's executions[]
        and Phase 2's processExecutions records the canonical close at the
        REAL fill price.

        Order type:
          • MKT (RTH default): immediate fill at market
          • LMT (extended-hours required, also valid in RTH): user-specified
            limit price; IBKR rejects MKT outside RTH so the UI must collect
            a limit when the user is closing after hours.

        Action: 'SELL' for LONG positions, 'BUY' for SHORT covers.

        Returns {ok, orderId, permId, status, error}."""
        if not self.connected:
            return {'ok': False, 'error': 'BRIDGE_DISCONNECTED'}
        oid = self._allocate_order_id()
        if oid is None:
            return {'ok': False, 'error': 'NO_NEXT_ORDER_ID'}
        order_type = (order_type or 'MKT').upper()
        if order_type not in ('MKT', 'LMT'):
            return {'ok': False, 'error': f'BAD_ORDER_TYPE:{order_type}'}
        if order_type == 'LMT' and (limit_price is None or float(limit_price) <= 0):
            return {'ok': False, 'error': 'LMT_REQUIRES_LIMIT_PRICE'}
        contract = self._build_stock_contract(ticker)
        order = Order()
        order.action        = action.upper()
        order.orderType     = order_type
        order.totalQuantity = int(shares)
        order.tif           = tif
        order.outsideRth    = not rth
        if order_type == 'LMT':
            order.lmtPrice  = float(limit_price)
        # Stamp the PNTHR fingerprint so the orphan janitor recognizes this
        # as bridge-placed (relevant when a partial fill leaves a working
        # remainder that later orphans).
        order.orderRef      = self.PNTHR_ORDER_REF
        order.eTradeOnly    = False
        order.firmQuoteOnly = False
        try:
            self.placeOrder(oid, contract, order)
        except Exception as e:
            return {'ok': False, 'orderId': oid, 'error': f'PLACE_THREW: {e}'}
        # Allow more time for fill confirmation than for stop placement —
        # market orders fill quickly, but limit orders during ext-hours can
        # take a moment to cross.
        st = self._wait_for_status(oid, ('Submitted', 'PreSubmitted', 'Filled'), timeout=20.0)
        if not st:
            return {'ok': False, 'orderId': oid, 'error': 'NO_STATUS_AFTER_20S'}
        return {
            'ok':         st['status'] in ('Submitted', 'PreSubmitted', 'Filled'),
            'orderId':    oid,
            'permId':     st.get('permId'),
            'status':     st['status'],
            'orderType':  order_type,
            'tif':        tif,
            'rth':        rth,
        }

    def modify_stop(self, ticker, old_perm_id, new_stop_price, action, shares,
                    tif='GTC', rth=True, order_type='STP', limit_price=None):
        """IB API has no true 'modify' — cancel old + place new. Both must
        succeed for ok=True. If the cancel succeeds but the new place fails,
        the position is briefly NAKED (and that's reported as 'NAKED_AFTER_MODIFY'
        in the result so the operator knows to manually re-stop).

        Order shape (STP vs STP LMT) is plumbed through to place_protective_stop
        so a position toggling stopExtendedHours mid-life rebuilds the order
        in the right form on the next 4c sync.

        2026-06-03: cancels ALL PNTHR protective stops for this ticker+side, not just
        old_perm_id, so a duplicate/orphan from a past cancel race or a cache-miss
        'placed_new' is swept too — end state = exactly ONE PNTHR stop at the new
        level. Manual TWS stops are untouched. old_perm_id is now advisory only."""
        cancel = self.cancel_pnthr_protective_stops(ticker, action=action)
        place = self.place_protective_stop(
            ticker, action, shares, new_stop_price,
            tif=tif, rth=rth, order_type=order_type, limit_price=limit_price,
        )
        return {
            'ok':           place['ok'],
            'phase':        'PLACE_AFTER_CANCEL_ALL',
            'cancelResult': cancel,
            'placeResult':  place,
            'naked':        not place['ok'],  # true == we swept but couldn't replace
        }

    # ── Payload builder ───────────────────────────────────────────────────────
    def get_payload(self):
        def _float(key):
            v = self.account_values.get(key, {}).get('value', 0)
            try:
                return float(v)
            except (ValueError, TypeError):
                return 0.0

        return {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'accountId': self.account_id,
            'account': {
                'netLiquidation':    _float('NetLiquidation'),
                'totalCashValue':    _float('TotalCashValue'),
                'buyingPower':       _float('BuyingPower'),
                'grossPositionValue': _float('GrossPositionValue'),
                'maintenanceMargin': _float('MaintMarginReq'),
                'availableFunds':    _float('AvailableFunds'),
            },
            'positions': list(self.positions_dict.values()),
            # positionsConfirmed: True only when this snapshot's position list is
            # TRUSTWORTHY — either positions are present, or reqPositions has COMPLETED
            # (positionEnd -> positions_ready set) confirming the account is genuinely
            # FLAT. The push gate below already refuses to send an unconfirmed-empty
            # snapshot; this flag carries that same guarantee into the stored doc so the
            # Ambush engine can safely trust a 0-position snapshot (genuinely flat) and
            # never mistake a mid-reconnect blank for "the whole book went flat".
            'positionsConfirmed': bool(self.positions_dict) or self.positions_ready.is_set(),
            'stopOrders': list(self.open_orders.values()),
            'executions': self.executions,
        }


# ── Sync helper ────────────────────────────────────────────────────────────────
def push_to_pnthr(payload):
    """POST the snapshot to PNTHR Den. Non-fatal on failure."""
    try:
        resp = requests.post(
            f"{PNTHR_API_URL}/api/ibkr/sync",
            json=payload,
            headers={
                'Content-Type':  'application/json',
                'Authorization': f'Bearer {PNTHR_TOKEN}',
            },
            timeout=10,
        )
        if resp.status_code == 200:
            data        = resp.json()
            nav         = payload['account']['netLiquidation']
            pos_count   = len(payload['positions'])
            stop_count  = len(payload.get('stopOrders', []))
            exec_count  = len(payload.get('executions', []))
            mismatch    = len(data.get('mismatches', []))
            stop_mis    = len(data.get('stopMismatches', []))
            auto_closed = data.get('autoClosedPositions', [])
            ts          = datetime.now().strftime('%H:%M:%S')
            mismatch_str = f" | ⚠ {mismatch} share mismatch(es)" if mismatch else ""
            stop_mis_str = f" | ⚠ {stop_mis} stop mismatch(es)" if stop_mis else ""
            exec_str     = f" | {exec_count} fills" if exec_count else ""
            print(f"[BRIDGE] ✓ {ts}  NAV: ${nav:>12,.2f}  |  {pos_count} pos  |  {stop_count} stops{exec_str}{mismatch_str}{stop_mis_str}")
            if auto_closed:
                for ac in auto_closed:
                    print(f"[BRIDGE]   ⚡ AUTO-CLOSED {ac['ticker']} ({ac['direction']}) @ ${ac['exitPrice']:.2f} — {ac['exitReason']}")
            if data.get('untracked'):
                syms = ', '.join(p['symbol'] for p in data['untracked'])
                print(f"[BRIDGE]   Untracked in PNTHR: {syms}")
        else:
            print(f"[BRIDGE] ✗ Sync failed {resp.status_code}: {resp.text[:200]}")
    except requests.exceptions.ConnectionError:
        print(f"[BRIDGE] ✗ Cannot reach {PNTHR_API_URL} — server down?")
    except requests.exceptions.Timeout:
        print("[BRIDGE] ✗ Request timed out (>10s)")
    except Exception as e:
        print(f"[BRIDGE] ✗ Unexpected error: {e}")


def is_market_hours():
    """True during US market hours Mon–Fri 9:30–16:00 ET (DST-aware)."""
    now = datetime.now(_ET)
    if now.weekday() >= 5:
        return False
    open_  = now.replace(hour=9,  minute=30, second=0, microsecond=0)
    close_ = now.replace(hour=16, minute=0,  second=0, microsecond=0)
    return open_ <= now <= close_


def is_in_blackout_window():
    """Pause writes during market-open chaos (9:25-9:35). For the CLOSE, block ONLY
    AFTER the 4:00 bell (16:00-16:05): new entries are allowed right up to the close
    (orders placed before 16:00 fill), but a market order after the bell won't fill in
    RTH. Mirror of server/ibkrOutbox.isInBlackoutWindow (2026-06-04)."""
    now = datetime.now(_ET)
    minute_of_day = now.hour * 60 + now.minute
    if 565 <= minute_of_day <= 575:
        return 'OPEN_BLACKOUT'
    if 960 <= minute_of_day <= 965:
        return 'CLOSE_BLACKOUT'
    return None


# ── Phase 4 outbox poller ────────────────────────────────────────────────────
# Runs in its own thread alongside the read-only sync loop. Polls the server
# every OUTBOX_POLL_SEC seconds for PENDING commands, executes them via the
# IB API, and reports DONE / FAILED back. Fully gated by IBKR_WRITES_ENABLED:
# when off (default), the thread loops but never calls the IB API or even hits
# the server (so server logs stay clean).
def _outbox_get_pending():
    try:
        r = requests.get(
            f"{PNTHR_API_URL}/api/admin/ibkr-outbox/pending",
            headers={'Authorization': f'Bearer {PNTHR_TOKEN}'},
            timeout=10,
        )
        if r.status_code == 200:
            return r.json().get('commands', [])
        return []
    except Exception as e:
        print(f"[OUTBOX] ✗ pending fetch failed: {e}")
        return []


def _outbox_post(path, body=None):
    try:
        r = requests.post(
            f"{PNTHR_API_URL}{path}",
            json=body or {},
            headers={
                'Content-Type':  'application/json',
                'Authorization': f'Bearer {PNTHR_TOKEN}',
            },
            timeout=10,
        )
        return r.status_code == 200
    except Exception as e:
        print(f"[OUTBOX] ✗ POST {path} failed: {e}")
        return False


def _execute_command(app, rate_limiter, cmd):
    """Run a single outbox command. Returns (ok, response_dict, error_str)."""
    request   = cmd.get('request') or {}
    command   = cmd['command']
    ticker    = (request.get('ticker') or '').upper()

    # Rate limit — bridge-side enforcement on top of server-side dedup.
    can_send, rate_reason = rate_limiter.can_send(ticker)
    if not can_send:
        return False, None, f'RATE_LIMITED:{rate_reason}'

    # Blackout windows (open/close chaos).
    blackout = is_in_blackout_window()
    if blackout:
        return False, None, f'BLACKOUT:{blackout}'

    if IBKR_WRITES_DRY_RUN:
        print(f"[OUTBOX] DRY-RUN {command} {ticker} {request} (no IB API call made)")
        rate_limiter.record(ticker)
        return True, {'dryRun': True, 'command': command, 'request': request}, None

    # Real IB API path.
    rate_limiter.record(ticker)

    if command == 'PLACE_STOP':
        action = 'SELL' if (request.get('direction') or 'LONG').upper() != 'SHORT' else 'BUY'
        result = app.place_protective_stop(
            ticker      = ticker,
            action      = action,
            shares      = request.get('shares'),
            stop_price  = request.get('stopPrice'),
            tif         = request.get('tif') or 'GTC',
            rth         = bool(request.get('rth', True)),
            order_type  = request.get('orderType') or 'STP',
            limit_price = request.get('lmtPrice'),
        )
        return result.get('ok', False), result, (None if result.get('ok') else result.get('error') or result.get('status'))

    if command == 'CANCEL_RELATED_ORDERS':
        result = app.cancel_related_orders(ticker)
        if result.get('ok'):
            return True, result, None
        # Surface specific failure detail instead of opaque SOME_CANCEL_FAILED
        # so the outbox audit log shows which permIds + reasons actually broke.
        failures = result.get('failures') or []
        detail = '; '.join(
            f"{f.get('permId')}:{(f.get('result') or {}).get('error') or (f.get('result') or {}).get('status') or 'UNKNOWN'}"
            for f in failures[:5]
        ) or 'SOME_CANCEL_FAILED'
        return False, result, f'SOME_CANCEL_FAILED[{detail}]'

    if command == 'CANCEL_ORDER':
        perm_id = request.get('permId') or request.get('oldPermId')
        if not perm_id:
            return False, None, 'MISSING_PERMID'
        result = app.cancel_order_by_perm_id(perm_id)
        # Always coalesce error first, then status — pre-fix this read status
        # only, which left err=None when result carried error (PERMID_NOT_FOUND)
        # and the server fell back to storing the whole response object as the
        # error string ("[object Object]" in the UI).
        return result.get('ok', False), result, (None if result.get('ok') else (result.get('error') or result.get('status') or 'CANCEL_FAILED'))

    if command == 'SELL_POSITION':
        # Action depends on the position direction we're closing.
        # LONG → SELL (sell the shares we hold)
        # SHORT → BUY (buy-to-cover the borrowed shares)
        action = 'SELL' if (request.get('direction') or 'LONG').upper() != 'SHORT' else 'BUY'
        result = app.sell_position(
            ticker      = ticker,
            action      = action,
            shares      = request.get('shares'),
            order_type  = request.get('orderType') or 'MKT',
            limit_price = request.get('limitPrice'),
            tif         = request.get('tif') or 'DAY',
            rth         = bool(request.get('rth', True)),
        )
        return result.get('ok', False), result, (None if result.get('ok') else result.get('error') or result.get('status'))

    if command == 'MODIFY_STOP':
        action = 'SELL' if (request.get('direction') or 'LONG').upper() != 'SHORT' else 'BUY'
        result = app.modify_stop(
            ticker          = ticker,
            old_perm_id     = request.get('oldPermId'),
            new_stop_price  = request.get('newStopPrice'),
            action          = action,
            shares          = request.get('shares'),
            tif             = request.get('tif') or 'GTC',
            rth             = bool(request.get('rth', True)),
            order_type      = request.get('orderType') or 'STP',
            limit_price     = request.get('lmtPrice'),
        )
        return result.get('ok', False), result, (None if result.get('ok') else f'MODIFY_FAILED_PHASE_{result.get("phase")}')

    # ── Phase 4g: pyramid lot triggers ─────────────────────────────────────
    # A lot trigger is the SAME stop-order shape (STP/STP LMT) as a protective
    # stop, but with the OPPOSITE action — LONG pyramid adds = BUY STOP above
    # market, SHORT adds = SELL STOP below. We reuse place_protective_stop /
    # modify_stop verbatim; only the action computation flips.
    if command == 'PLACE_LOT_TRIGGER':
        action = 'BUY' if (request.get('direction') or 'LONG').upper() != 'SHORT' else 'SELL'
        result = app.place_protective_stop(
            ticker      = ticker,
            action      = action,
            shares      = request.get('shares'),
            stop_price  = request.get('triggerPrice'),
            tif         = request.get('tif') or 'GTC',
            rth         = bool(request.get('rth', True)),
            order_type  = request.get('orderType') or 'STP',
            limit_price = request.get('lmtPrice'),
        )
        # Annotate lot number on the response so the outbox audit log carries it.
        if isinstance(result, dict):
            result['lot'] = request.get('lot')
        return result.get('ok', False), result, (None if result.get('ok') else result.get('error') or result.get('status'))

    if command == 'MODIFY_LOT_TRIGGER':
        action = 'BUY' if (request.get('direction') or 'LONG').upper() != 'SHORT' else 'SELL'
        result = app.modify_stop(
            ticker          = ticker,
            old_perm_id     = request.get('oldPermId'),
            new_stop_price  = request.get('newTriggerPrice'),
            action          = action,
            shares          = request.get('shares'),
            tif             = request.get('tif') or 'GTC',
            rth             = bool(request.get('rth', True)),
            order_type      = request.get('orderType') or 'STP',
            limit_price     = request.get('lmtPrice'),
        )
        if isinstance(result, dict):
            result['lot'] = request.get('lot')
        return result.get('ok', False), result, (None if result.get('ok') else f'MODIFY_LOT_FAILED_PHASE_{result.get("phase")}')

    # ── Catch-up market order ──────────────────────────────────────────────
    # Fired when price crossed an L2/L3/L4 trigger by 5+ ticks without the
    # original BUY/SELL STP filling (cancelled, never placed, or fired without
    # filling). RTH-only — server gates outside-RTH by holding the catch-up
    # in pendingCatchUp on the position; enqueue happens at next RTH cron tick
    # and IBKR rejects MKT outside RTH anyway.
    #
    # Uses the existing sell_position() helper which is a generic market-order
    # placer for LONG-buy / SHORT-sell — direction logic flips action like
    # PLACE_LOT_TRIGGER. Designed for immediate fill so the rebalance math
    # for L3+/L4+/L5 can run on confirmed fill data.
    if command == 'BUY_MARKET_TO_CATCH_UP':
        action = 'BUY' if (request.get('direction') or 'LONG').upper() != 'SHORT' else 'SELL'
        result = app.sell_position(
            ticker      = ticker,
            action      = action,
            shares      = request.get('shares'),
            order_type  = 'MKT',          # always market — RTH-only enforced upstream
            limit_price = None,
            tif         = 'DAY',
            rth         = True,
        )
        if isinstance(result, dict):
            result['lot']    = request.get('lot')
            result['source'] = 'CATCH_UP'
        return result.get('ok', False), result, (None if result.get('ok') else result.get('error') or result.get('status'))

    return False, None, f'UNKNOWN_COMMAND:{command}'


def outbox_poller_loop(app, rate_limiter, stop_event):
    """Background thread: polls outbox and dispatches write commands."""
    print(f"[OUTBOX] Poller starting — every {OUTBOX_POLL_SEC}s | "
          f"writes={'ENABLED' if IBKR_WRITES_ENABLED else 'DISABLED'} | "
          f"dryRun={'ON' if IBKR_WRITES_DRY_RUN else 'OFF'} | "
          f"staleGuard={OUTBOX_STALE_SEC}s")
    while not stop_event.is_set():
        try:
            if not IBKR_WRITES_ENABLED:
                # Master kill switch off — skip polling entirely. The server
                # also gates enqueue per IBKR_AUTO_* flags, so the queue is
                # almost certainly empty anyway.
                stop_event.wait(OUTBOX_POLL_SEC); continue

            if not app.connected:
                stop_event.wait(OUTBOX_POLL_SEC); continue

            pending = _outbox_get_pending()
            if not pending:
                stop_event.wait(OUTBOX_POLL_SEC); continue

            print(f"[OUTBOX] Found {len(pending)} pending command(s)")
            for cmd in pending:
                cmd_id = cmd.get('id')
                if not cmd_id:
                    continue
                # Staleness guard — refuse to execute commands that have been
                # sitting in the queue too long. The crons re-enqueue fresh
                # commands every minute, so anything stale is outdated.
                created_at = cmd.get('createdAt')
                if created_at and OUTBOX_STALE_SEC > 0:
                    try:
                        if isinstance(created_at, str):
                            created_dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                        else:
                            created_dt = created_at
                        age_sec = (datetime.now(timezone.utc) - created_dt).total_seconds()
                        if age_sec > OUTBOX_STALE_SEC:
                            ticker = cmd.get('request', {}).get('ticker', '?')
                            _outbox_post(f"/api/admin/ibkr-outbox/{cmd_id}/failed",
                                         body={'error': f'STALE:{int(age_sec)}s > {OUTBOX_STALE_SEC}s limit'})
                            print(f"[OUTBOX] ⏰ STALE {cmd['command']} {ticker} — {int(age_sec)}s old, skipped")
                            continue
                    except Exception as e:
                        print(f"[OUTBOX] ⚠ staleness check failed for {cmd_id}: {e} — proceeding")

                # Lock the row before executing — prevents double-execution
                # if multiple bridges (paper + live, future) ever poll at once.
                if not _outbox_post(f"/api/admin/ibkr-outbox/{cmd_id}/executing"):
                    print(f"[OUTBOX] ✗ failed to mark EXECUTING for {cmd_id}; skipping")
                    continue

                try:
                    ok, response, err = _execute_command(app, rate_limiter, cmd)
                except Exception as e:
                    ok, response, err = False, None, f'EXEC_THREW:{e}'

                if ok:
                    _outbox_post(f"/api/admin/ibkr-outbox/{cmd_id}/done", body=response)
                    print(f"[OUTBOX] ✓ {cmd['command']} {cmd.get('request', {}).get('ticker')} → DONE")
                else:
                    _outbox_post(f"/api/admin/ibkr-outbox/{cmd_id}/failed", body={'error': err, 'response': response})
                    print(f"[OUTBOX] ✗ {cmd['command']} {cmd.get('request', {}).get('ticker')} → FAILED: {err}")
        except Exception as e:
            print(f"[OUTBOX] ✗ poller loop error: {e}")
        stop_event.wait(OUTBOX_POLL_SEC)
    print("[OUTBOX] Poller stopped.")


# ── PNTHR AMBUSH outbox poller ──────────────────────────────────────────────
# Separate outbox for the Ambush V7 strategy. Polls /api/admin/ambush-outbox/
# and executes compound commands (entry = market order + stop, exit = cancel +
# sell, modify_stop = find existing stop + cancel + replace).

AMBUSH_ENABLED = os.getenv('AMBUSH_ENABLED', 'true').lower() == 'true'
AMBUSH_POLL_SEC = int(os.getenv('AMBUSH_POLL_SEC', '15'))  # poll faster than main outbox

def _ambush_get_pending():
    try:
        r = requests.get(
            f"{PNTHR_API_URL}/api/admin/ambush-outbox/pending",
            headers={'Authorization': f'Bearer {PNTHR_TOKEN}'},
            timeout=10,
        )
        if r.status_code == 200:
            return r.json().get('commands', [])
        return []
    except Exception as e:
        print(f"[AMBUSH] ✗ pending fetch failed: {e}")
        return []


def _ambush_post(path, body=None):
    try:
        r = requests.post(
            f"{PNTHR_API_URL}{path}",
            json=body or {},
            headers={
                'Content-Type':  'application/json',
                'Authorization': f'Bearer {PNTHR_TOKEN}',
            },
            timeout=10,
        )
        return r.status_code == 200
    except Exception as e:
        print(f"[AMBUSH] ✗ POST {path} failed: {e}")
        return False


def _find_protective_stop(app, ticker, stop_action):
    """Find the permId of the protective stop order for a ticker.
    For LONG positions: protective stop = SELL STP (stop_action='SELL').
    For SHORT positions: protective stop = BUY STP (stop_action='BUY').
    Lot triggers have the OPPOSITE action so they won't match."""
    for key, order in app.open_orders.items():
        if (order.get('symbol', '').upper() == ticker.upper() and
            order.get('action', '').upper() == stop_action.upper() and
            order.get('orderType', '').upper() in ('STP', 'STP LMT')):
            return order.get('permId')
    return None


def _execute_ambush_command(app, rate_limiter, cmd):
    """Execute a single Ambush outbox command. Returns (ok, response, error)."""
    request = cmd.get('request') or {}
    command = cmd['command']
    ticker  = (request.get('ticker') or '').upper()

    # Rate limit
    can_send, rate_reason = rate_limiter.can_send(ticker)
    if not can_send:
        return False, None, f'RATE_LIMITED:{rate_reason}'

    # Blackout windows
    blackout = is_in_blackout_window()
    if blackout:
        return False, None, f'BLACKOUT:{blackout}'

    if IBKR_WRITES_DRY_RUN or AMBUSH_DRY_RUN:
        print(f"[AMBUSH] DRY-RUN {command} {ticker} {request}")
        rate_limiter.record(ticker)
        return True, {'dryRun': True, 'command': command, 'request': request}, None

    rate_limiter.record(ticker)
    is_long = (request.get('direction') or 'LONG').upper() != 'SHORT'

    # ── ENTRY (BUY_ENTRY / SHORT_ENTRY) ──────────────────────────────────
    # Compound: 1) Market order to open position  2) Place protective stop
    if command in ('BUY_ENTRY', 'SHORT_ENTRY'):
        entry_action = 'BUY' if is_long else 'SELL'
        stop_action  = 'SELL' if is_long else 'BUY'
        shares = request.get('shares')

        # 1. Market entry order
        entry_result = app.sell_position(
            ticker=ticker, action=entry_action, shares=shares,
            order_type='MKT', limit_price=None, tif='DAY', rth=True,
        )
        if not entry_result.get('ok'):
            return False, entry_result, entry_result.get('error') or 'ENTRY_FAILED'

        # 2. Protective stop — CLEAN SLATE FIRST. Cancel any existing protective stop
        # on the exit side before placing the new one, so a re-entry can NEVER stack a
        # second protective stop. D 2026-06-05: a 22-sh stop from an earlier entry
        # lingered alongside the new 21-sh stop (~43 sh of coverage on 21 sh); when
        # price dropped, BOTH fired and OVER-SOLD, flipping the long to a short. Entry
        # now sweeps-then-places exactly like MODIFY_STOP. (Reconcile-before-act already
        # guarantees we only enter when flat, so there is no live position to un-protect.)
        stop_price = request.get('stopPrice')
        stop_result = None
        if stop_price:
            time.sleep(1)  # brief pause for TWS to register the position
            app.cancel_pnthr_protective_stops(ticker, action=stop_action)
            stop_result = app.place_protective_stop(
                ticker=ticker, action=stop_action, shares=shares,
                stop_price=stop_price, tif='GTC', rth=True,
            )
            if not stop_result.get('ok'):
                print(f"[AMBUSH] ⚠ {ticker} entry OK but protective stop FAILED — position NAKED")

        return True, {
            'entry': entry_result,
            'stop': stop_result,
            'command': command,
        }, None

    # ── EXIT (SELL_EXIT / COVER_EXIT) ────────────────────────────────────
    # Compound: 1) Cancel all related orders  2) Market order to close
    if command in ('SELL_EXIT', 'COVER_EXIT'):
        exit_action = 'SELL' if is_long else 'BUY'
        shares = request.get('shares')

        # 1. Cancel all related orders (stops + lot triggers)
        cancel_result = app.cancel_related_orders(ticker)

        # 2. Market exit
        time.sleep(0.5)
        exit_result = app.sell_position(
            ticker=ticker, action=exit_action, shares=shares,
            order_type='MKT', limit_price=None, tif='DAY', rth=True,
        )
        return exit_result.get('ok', False), {
            'cancel': cancel_result,
            'exit': exit_result,
            'command': command,
        }, (None if exit_result.get('ok') else exit_result.get('error') or 'EXIT_FAILED')

    # ── MODIFY_STOP ──────────────────────────────────────────────────────
    # Find existing protective stop by ticker + action, cancel + replace
    if command == 'MODIFY_STOP':
        stop_action = 'SELL' if is_long else 'BUY'
        new_stop = request.get('newStopPrice')
        shares = request.get('shares')
        # Always sweep ALL PNTHR stops for this ticker+side, then place exactly one
        # (modify_stop does both, and a clean sweep with nothing to cancel just places).
        # Replaces the old _find_protective_stop path that, on a cache miss, fell through
        # to placing a NEW stop WITHOUT cancelling the existing one — a second source of
        # the SE double-stop (the 'placed_new:true' events in SE's history).
        result = app.modify_stop(
            ticker=ticker, old_perm_id=None, new_stop_price=new_stop,
            action=stop_action, shares=shares, tif='GTC', rth=True,
        )
        return result.get('ok', False), result, (
            None if result.get('ok') else f'MODIFY_FAILED_PHASE_{result.get("phase")}')

    # ── PLACE_LOT_TRIGGER ────────────────────────────────────────────────
    # Rest ONE add-side stop for the next pyramid lot (LONG add = BUY STOP above,
    # SHORT add = SELL STOP below). IDEMPOTENT: sweep any existing add-side lot
    # trigger for this ticker FIRST, then place exactly one — so the engine
    # re-resting the same on-deck lot (snapshot-lag re-place) never stacks a
    # duplicate. cancel_pnthr_protective_stops is side-aware: it touches ONLY the
    # add-side, leaving the opposite-side protective stop and any manual TWS stop
    # untouched (the ALAB double-stop cannot recur).
    if command == 'PLACE_LOT_TRIGGER':
        lot_action = 'BUY' if is_long else 'SELL'
        app.cancel_pnthr_protective_stops(ticker, action=lot_action)
        result = app.place_protective_stop(
            ticker=ticker, action=lot_action, shares=request.get('shares'),
            stop_price=request.get('triggerPrice'), tif='GTC', rth=True,
        )
        if isinstance(result, dict):
            result['lot'] = request.get('lot')
        return result.get('ok', False), result, (
            None if result.get('ok') else result.get('error') or result.get('status'))

    # ── CANCEL_LOT_TRIGGER ───────────────────────────────────────────────
    # Cancel the resting add-side lot trigger for `ticker` (LONG add = BUY STP,
    # SHORT add = SELL STP). Used when the position goes over the 10% cap, the
    # ladder is complete, or a phantom reconciles to flat. Side-aware: leaves the
    # opposite-side protective stop and any manual TWS stop alone. Idempotent
    # (ALREADY_GONE = success), so a repeat with nothing to cancel is harmless.
    if command == 'CANCEL_LOT_TRIGGER':
        lot_action = 'BUY' if is_long else 'SELL'
        result = app.cancel_pnthr_protective_stops(ticker, action=lot_action)
        return result.get('ok', False), result, (
            None if result.get('ok') else 'CANCEL_LOT_FAILED')

    # ── CANCEL_ORDER ─────────────────────────────────────────────────────
    # Cancel one specific order by permId. Used by the duplicate/orphan
    # protective-stop trim to remove a stop the orderRef sweep can't reach
    # (e.g. a prior-session stop returned untagged after a bridge restart).
    # cancel_order_by_perm_id is idempotent (ALREADY_GONE = success), so a
    # repeat while the 60s snapshot catches up is harmless.
    if command == 'CANCEL_ORDER':
        perm_id = request.get('permId') or request.get('oldPermId')
        if not perm_id:
            return False, None, 'MISSING_PERMID'
        result = app.cancel_order_by_perm_id(perm_id)
        return result.get('ok', False), result, (
            None if result.get('ok') else (result.get('error') or result.get('status') or 'CANCEL_FAILED'))

    return False, None, f'UNKNOWN_AMBUSH_COMMAND:{command}'


def ambush_outbox_poller_loop(app, rate_limiter, stop_event):
    """Background thread: polls Ambush outbox and dispatches commands."""
    print(f"[AMBUSH] Poller starting — every {AMBUSH_POLL_SEC}s | "
          f"writes={'ENABLED' if IBKR_WRITES_ENABLED else 'DISABLED'} | "
          f"AMBUSH_DRY_RUN={'ON (no real trades)' if (AMBUSH_DRY_RUN or IBKR_WRITES_DRY_RUN) else 'OFF (LIVE)'}")
    while not stop_event.is_set():
        try:
            if not IBKR_WRITES_ENABLED or not AMBUSH_ENABLED:
                stop_event.wait(AMBUSH_POLL_SEC)
                continue

            if not app.connected:
                stop_event.wait(AMBUSH_POLL_SEC)
                continue

            pending = _ambush_get_pending()
            if not pending:
                stop_event.wait(AMBUSH_POLL_SEC)
                continue

            print(f"[AMBUSH] Found {len(pending)} pending command(s)")
            for cmd in pending:
                cmd_id = cmd.get('id')
                if not cmd_id:
                    continue

                # Staleness guard — 5 min for Ambush (faster cycle)
                created_at = cmd.get('createdAt')
                if created_at and OUTBOX_STALE_SEC > 0:
                    try:
                        if isinstance(created_at, str):
                            created_dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                        else:
                            created_dt = created_at
                        age_sec = (datetime.now(timezone.utc) - created_dt).total_seconds()
                        if age_sec > 300:  # 5 min stale guard for Ambush
                            _ambush_post(f"/api/admin/ambush-outbox/{cmd_id}/failed",
                                         body={'error': f'STALE:{int(age_sec)}s'})
                            print(f"[AMBUSH] ⏰ STALE {cmd['command']} {cmd.get('request', {}).get('ticker', '?')} — {int(age_sec)}s old")
                            continue
                    except Exception as e:
                        print(f"[AMBUSH] ⚠ staleness check failed for {cmd_id}: {e}")

                # Lock before executing
                if not _ambush_post(f"/api/admin/ambush-outbox/{cmd_id}/executing"):
                    print(f"[AMBUSH] ✗ failed to mark EXECUTING for {cmd_id}")
                    continue

                try:
                    ok, response, err = _execute_ambush_command(app, rate_limiter, cmd)
                except Exception as e:
                    ok, response, err = False, None, f'EXEC_THREW:{e}'

                if ok:
                    _ambush_post(f"/api/admin/ambush-outbox/{cmd_id}/done", body=response)
                    print(f"[AMBUSH] ✓ {cmd['command']} {cmd.get('request', {}).get('ticker')} → DONE")
                else:
                    _ambush_post(f"/api/admin/ambush-outbox/{cmd_id}/failed",
                                 body={'error': err, 'response': response})
                    print(f"[AMBUSH] ✗ {cmd['command']} {cmd.get('request', {}).get('ticker')} → FAILED: {err}")
        except Exception as e:
            print(f"[AMBUSH] ✗ poller loop error: {e}")
        stop_event.wait(AMBUSH_POLL_SEC)
    print("[AMBUSH] Poller stopped.")


# ── Main ───────────────────────────────────────────────────────────────────────
# ── IBKR hourly-bar feed loop (2026-06-03, READ-ONLY) ───────────────────────
# Fetches true IBKR 1-hour bars for every ticker the Ambush engine tracks and
# POSTs them to the server, which the engine seeds its 2-bar-low exit + breakout
# re-entry from (matching the trader's TWS chart, unlike FMP's :30-aligned bars).
# Uses reqHistoricalData ONLY — never places an order. Paced under IBKR's
# 60-requests/10-min historical limit.
HOURLY_BARS_ENABLED  = os.getenv('HOURLY_BARS_ENABLED', 'true').lower() == 'true'
HOURLY_BARS_POLL_SEC = int(os.getenv('HOURLY_BARS_POLL_SEC', '180'))   # per-ticker refresh staleness (catches each new completed hourly bar)
HOURLY_BARS_SPACING  = float(os.getenv('HOURLY_BARS_SPACING', '11'))   # sec between requests (IBKR 60-req/10-min pacing)
BAR_DISCOVERY_SEC    = int(os.getenv('BAR_DISCOVERY_SEC', '20'))       # how often we re-poll the monitored list for NEW tickers
HOURLY_BARS_BATCH    = int(os.getenv('HOURLY_BARS_BATCH', '6'))        # max stale refreshes per cycle (new tickers always fetched first)
HOURLY_BARS_FAIL_RETRY_SEC = int(os.getenv('HOURLY_BARS_FAIL_RETRY_SEC', '30'))  # retry a FAILED fetch this soon (not a full POLL_SEC) — fixes silent-staleness

def hourly_bars_loop(app, stop_event):
    # Per-ticker last-fetch epoch. NEW tickers (a manual entry, an adopted position, a
    # STALKING->HUNTING re-entry candidate) are fetched on the very NEXT discovery poll
    # (~BAR_DISCOVERY_SEC) — FIRST priority, every cycle — so they get their 2-bar stop
    # within ~30-60s instead of waiting a full sweep. The old loop swept ALL tickers
    # then slept 10 min, leaving a manual entry naked for 10-20 min. Already-known
    # tickers refresh round-robin, a capped batch per cycle, so a new completed hourly
    # bar reaches the engine within a few minutes of the hour close while staying under
    # IBKR's 60-request/10-min historical-data limit.
    last_fetched = {}
    rr = 0
    while not stop_event.is_set():
        try:
            if app.connected and PNTHR_TOKEN:
                r = requests.get(
                    f"{PNTHR_API_URL}/api/admin/ambush/bar-tickers",
                    headers={'Authorization': f'Bearer {PNTHR_TOKEN}'}, timeout=10)
                tickers = r.json().get('tickers', []) if r.status_code == 200 else []
                # Forget tickers no longer monitored (so a re-add fetches fresh).
                for gone in [t for t in list(last_fetched) if t not in tickers]:
                    last_fetched.pop(gone, None)
                now_t = time.time()
                new_t = [t for t in tickers if t not in last_fetched]            # never fetched -> priority
                stale = [t for t in tickers if t in last_fetched
                         and now_t - last_fetched[t] >= HOURLY_BARS_POLL_SEC]     # due for refresh
                if stale:
                    rr %= len(stale)
                    refresh = (stale[rr:] + stale[:rr])[:HOURLY_BARS_BATCH]       # rotate so we don't always hit the same few
                    rr += len(refresh)
                else:
                    refresh = []
                work = new_t + refresh
                posted = 0
                for t in work:
                    if stop_event.is_set():
                        break
                    bars = app.fetch_hourly_bars(t)
                    if bars and _ambush_post('/api/admin/ambush/hourly-bars',
                                             {'ticker': t, 'bars': bars, 'source': 'IBKR'}):
                        last_fetched[t] = time.time()                 # mark fresh ONLY on success
                        posted += 1
                    else:
                        # BUG FIX (2026-06-04): a failed/timed-out fetch (IBKR market-data
                        # farm hiccup, Error 2103) must NOT be marked fresh — that silently
                        # froze the feed for 80+ min (FLEX/IESC/ON). Schedule a fast retry
                        # instead of waiting a full HOURLY_BARS_POLL_SEC.
                        last_fetched[t] = time.time() - (HOURLY_BARS_POLL_SEC - HOURLY_BARS_FAIL_RETRY_SEC)
                        print(f"[BARS] {t}: fetch/post FAILED — fast-retry in ~{HOURLY_BARS_FAIL_RETRY_SEC}s (feed not marked fresh)")
                    stop_event.wait(HOURLY_BARS_SPACING)  # IBKR pacing
                if work:
                    print(f"[BARS] posted {posted}/{len(work)} ({len(new_t)} new, {len(refresh)} refresh)")
        except Exception as e:
            print(f"[BARS] loop error: {e}")
        stop_event.wait(BAR_DISCOVERY_SEC)


def main():
    print("=" * 60)
    print("  PNTHR Den — IBKR TWS Bridge")
    print(f"  TWS:    {TWS_HOST}:{TWS_PORT}  (client ID {TWS_CLIENT_ID})")
    print(f"  Server: {PNTHR_API_URL}")
    print(f"  Sync:   every {SYNC_INTERVAL}s  |  Outbox poll: every {OUTBOX_POLL_SEC}s")
    print(f"  Phase 4 writes: {'ENABLED' if IBKR_WRITES_ENABLED else 'DISABLED'}"
          f"{'  (DRY-RUN)' if IBKR_WRITES_ENABLED and IBKR_WRITES_DRY_RUN else ''}")
    print(f"  Ambush V7.6: {'ENABLED' if AMBUSH_ENABLED else 'DISABLED'}"
          f"{'  (DRY-RUN — no real Ambush trades)' if (AMBUSH_DRY_RUN or IBKR_WRITES_DRY_RUN) else '  (LIVE WRITES)'}"
          f" (poll: {AMBUSH_POLL_SEC}s)")
    print(f"  Staleness guard: {OUTBOX_STALE_SEC}s (commands older than {OUTBOX_STALE_SEC // 60}min auto-rejected)")
    print("=" * 60)

    if not PNTHR_TOKEN:
        print("[BRIDGE] ERROR: PNTHR_TOKEN not set.")
        print("[BRIDGE] Get it from: PNTHR Den → DevTools → Application → Local Storage → pnthr_token")
        print("[BRIDGE] Then add it to a .env file in this directory.")
        sys.exit(1)

    app = PNTHRBridge()

    print("[BRIDGE] Connecting to TWS...")
    try:
        app.connect(TWS_HOST, TWS_PORT, TWS_CLIENT_ID)
    except Exception as e:
        print(f"[BRIDGE] Connection failed: {e}")
        print("[BRIDGE] Is TWS running? Is API enabled (Edit → Global Config → API → Settings)?")
        sys.exit(1)

    # Run the TWS message loop in a background daemon thread
    api_thread = threading.Thread(target=app.run, daemon=True)
    api_thread.start()

    # Give the connection a moment to establish
    time.sleep(2)
    if not app.connected:
        print("[BRIDGE] Not connected after 2s. Check TWS API settings and port.")
        sys.exit(1)

    # Subscribe once — TWS streams updates continuously after this
    app.reqAccountUpdates(True, "")
    app.reqPositions()

    # Wait for initial data load (up to 15s)
    app.account_ready.wait(timeout=15)
    app.positions_ready.wait(timeout=15)

    # ── ORPHAN SELF-HEAL (client 0 only) ───────────────────────────────────────────────────
    # reqAutoOpenOrders(True) can ONLY be called by client 0; it auto-binds orders going
    # forward, and combined with the per-cycle reqOpenOrders() (sync loop below) it BINDS any
    # currently-open UNBOUND order too — including the engine's own stops that TWS handed back
    # unbound after its nightly restart. Once bound they carry a real orderId, so the engine's
    # dup-trim / re-trail can cancel + replace them on its own. THIS is what makes orphaned-stop
    # recovery fully automatic. Without client 0 the bridge can SEE orphans but never clear them.
    if TWS_CLIENT_ID == 0:
        try:
            app.reqAutoOpenOrders(True)
            print("[BRIDGE] Client 0: reqAutoOpenOrders(True) — will bind + manage all resting orders (orphaned-stop self-heal ENABLED).")
        except Exception as e:
            print(f"[BRIDGE] ⚠ reqAutoOpenOrders failed: {e}")
    else:
        print(f"[BRIDGE] ⚠ Client ID {TWS_CLIENT_ID} (not 0): CANNOT take over orphaned stops after a TWS restart. Set TWS_CLIENT_ID=0 in .env.bridge to enable orphan self-heal.")

    # Phase 4 outbox poller (the MAIN 679/Carnivore execution path). DISABLED by default
    # (Scott 2026-06-05: ONLY Ambush trades on this account). The bridge does NOT run the
    # 679 execution poller unless MAIN_OUTBOX_ENABLED=true, so a non-Ambush order can never
    # execute through this bridge — regardless of the Render auto-exec flags. The read-only
    # views (PNTHR MCE / AI Orders / trades) are UNAFFECTED: signal generation + the
    # read-only IBKR sync are separate and keep running. Re-enable by setting MAIN_OUTBOX_ENABLED=true.
    rate_limiter = RateLimiter(RATE_PER_SYMBOL_PER_MIN, RATE_GLOBAL_PER_MIN)
    outbox_stop_event = threading.Event()
    if MAIN_OUTBOX_ENABLED:
        outbox_thread = threading.Thread(
            target=outbox_poller_loop,
            args=(app, rate_limiter, outbox_stop_event),
            daemon=True,
            name='outbox-poller',
        )
        outbox_thread.start()
    else:
        print("[BRIDGE] 679/Carnivore execution poller DISABLED (MAIN_OUTBOX_ENABLED=false) — only Ambush can trade.")

    # Ambush V7 outbox poller — separate thread, faster poll cycle.
    # Polls /api/admin/ambush-outbox/pending for Ambush-specific commands.
    ambush_stop_event = threading.Event()
    if AMBUSH_ENABLED:
        ambush_thread = threading.Thread(
            target=ambush_outbox_poller_loop,
            args=(app, rate_limiter, ambush_stop_event),
            daemon=True,
            name='ambush-poller',
        )
        ambush_thread.start()
    else:
        print("[AMBUSH] Poller disabled (AMBUSH_ENABLED=false)")

    # IBKR hourly-bar feed — READ-ONLY reqHistoricalData; posts bars for the engine.
    bars_stop_event = threading.Event()
    if HOURLY_BARS_ENABLED:
        bars_thread = threading.Thread(
            target=hourly_bars_loop,
            args=(app, bars_stop_event),
            daemon=True,
            name='hourly-bars',
        )
        bars_thread.start()
        print("[BARS] IBKR hourly-bar feed started (read-only)")
    else:
        print("[BARS] Hourly-bar feed disabled (HOURLY_BARS_ENABLED=false)")

    print(f"[BRIDGE] Syncing every {SYNC_INTERVAL}s. Press Ctrl+C to stop.\n")

    try:
        while True:
            if app.connected:
                # Refresh open stop orders snapshot before building payload.
                # ROOT-CAUSE FIX (2026-06-05, completed 2026-06-23): reqOpenOrders() FIRST
                # BINDS open orders — restoring a real orderId AND (for our own) the 'PNTHR'
                # ref. As CLIENT 0 (see TWS_CLIENT_ID note) this binds EVERY currently-open
                # unbound order, including stops TWS handed back orphaned (orderId 0, no tag)
                # after its nightly restart — NOT just this session's. Without it those stops
                # (a) looked like manual stops the sweep won't touch and (b) were uncancellable
                # by orderId 0 (TWS 10147) — the BABA/WRD + 2026-06-23 KLAC/LRCX orphans. Once
                # bound they carry a real orderId, so the engine can cancel/retrail them itself.
                # reqAllOpenOrders() then adds any remaining manual TWS stops. The openOrder
                # downgrade-guard keeps the bound identity if the 2nd call re-reports 0.
                app.open_orders = {}
                app.orders_ready.clear()
                app.reqOpenOrders()              # bind OUR own orders (real orderId + ref)
                app.orders_ready.wait(timeout=5)
                app.orders_ready.clear()
                app.reqAllOpenOrders()           # + capture manual TWS orders
                app.orders_ready.wait(timeout=5)  # orders arrive fast

                # Request executions (fills) from TWS. Default lookback is
                # 7 days so the server's auto-fill recorder (Phase 4h) can
                # backfill pyramid lot fills that fired before the recorder
                # was deployed. The server dedups by execId in
                # pnthr_ibkr_executions, so re-sending old fills each cycle
                # is harmless after the first sync (processed execs are
                # filtered out before Phase 2/4h logic runs). TWS itself
                # limits history to ~7 days; set EXECUTION_LOOKBACK_DAYS to
                # tune (e.g., 1 = today only).
                lookback_days = int(os.getenv('EXECUTION_LOOKBACK_DAYS', '7'))
                exec_filter = ExecutionFilter()
                cutoff = datetime.now(_ET) - timedelta(days=lookback_days)
                exec_filter.time = cutoff.strftime('%Y%m%d-%H:%M:%S')

                app.executions = []
                app.executions_ready.clear()
                app._exec_req_id += 1
                app.reqExecutions(app._exec_req_id, exec_filter)
                app.executions_ready.wait(timeout=5)

                payload = app.get_payload()
                # ── DO NOT push an EMPTY-and-UNCONFIRMED snapshot (2026-06-04 root-cause) ──
                # After a reconnect, positions_dict is cleared until reqPositions completes
                # (positionEnd sets positions_ready). Pushing during that window writes 0
                # positions, which the engine reads as "the whole book went flat" — it then
                # drops stops, strands real positions unmanaged, and re-places duplicate
                # stops (it sees 0 stop orders). Only push when we either HAVE positions, or
                # reqPositions has CONFIRMED the account is genuinely flat (positions_ready
                # set). Otherwise keep the server's last good snapshot and nudge a re-request.
                if payload['account']['netLiquidation'] <= 0:
                    print("[BRIDGE] ⚠ No account data yet — TWS may still be loading; not pushing")
                elif not app.positions_dict and not app.positions_ready.is_set():
                    print("[BRIDGE] ⚠ Positions not loaded yet (reqPositions pending) — NOT pushing EMPTY snapshot (preserving last good); re-requesting positions")
                    app.reqPositions()
                else:
                    push_to_pnthr(payload)
            else:
                print("[BRIDGE] Disconnected — attempting reconnect...")
                try:
                    app.connect(TWS_HOST, TWS_PORT, TWS_CLIENT_ID)
                    time.sleep(2)
                    app.positions_dict = {}        # clear stale positions before fresh subscription
                    app.positions_ready.clear()    # gate pushes until reqPositions repopulates (no empty-snapshot writes)
                    app.reqAccountUpdates(True, "")
                    app.reqPositions()
                    app.account_ready.wait(timeout=15)
                    app.positions_ready.wait(timeout=15)  # wait for the real position list before resuming pushes
                    # Re-arm orphan self-heal after a reconnect (a reconnect/TWS restart is
                    # exactly when stops come back unbound). Client 0 only; idempotent.
                    if TWS_CLIENT_ID == 0:
                        try:
                            app.reqAutoOpenOrders(True)
                        except Exception:
                            pass
                except Exception:
                    pass

            time.sleep(SYNC_INTERVAL)

    except KeyboardInterrupt:
        print("\n[BRIDGE] Shutting down...")
        outbox_stop_event.set()
        ambush_stop_event.set()
        bars_stop_event.set()
        try:
            app.reqAccountUpdates(False, "")
            app.cancelPositions()
        except Exception:
            pass
        app.disconnect()
        print("[BRIDGE] Disconnected. Goodbye.")


if __name__ == '__main__':
    main()
