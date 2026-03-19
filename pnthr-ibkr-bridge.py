"""
PNTHR Den — IBKR TWS Bridge (Phase 1: Read-Only)

Connects to TWS, reads account + positions every 60 seconds,
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
    from ibapi.client import EClient
    from ibapi.wrapper import EWrapper
except ImportError:
    print("[BRIDGE] ERROR: ibapi not installed. Run: pip install ibapi")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv optional — env vars can be set manually

# ── Configuration ─────────────────────────────────────────────────────────────
PNTHR_TOKEN   = os.getenv('PNTHR_TOKEN')
PNTHR_API_URL = os.getenv('PNTHR_API_URL', 'http://localhost:5000')
TWS_HOST      = os.getenv('TWS_HOST', '127.0.0.1')
TWS_PORT      = int(os.getenv('TWS_PORT', '7496'))
TWS_CLIENT_ID = int(os.getenv('TWS_CLIENT_ID', '99'))
SYNC_INTERVAL = 60  # seconds between pushes

if '--paper' in sys.argv:
    TWS_PORT = 7497
    print("[BRIDGE] Using PAPER account (port 7497)")


# ── TWS Bridge App ─────────────────────────────────────────────────────────────
class PNTHRBridge(EWrapper, EClient):
    """
    Connects to TWS via the socket API, collects account data and positions,
    then pushes a JSON snapshot to the PNTHR Den server every 60 seconds.
    Never places orders. Read-only.
    """

    def __init__(self):
        EClient.__init__(self, self)
        self.account_values  = {}
        self.positions       = []
        self.account_ready   = threading.Event()
        self.positions_ready = threading.Event()
        self.connected       = False
        self.account_id      = None

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
        print(f"[BRIDGE] TWS Error {errorCode}: {errorString}")

    def nextValidId(self, orderId):
        """Called when the connection is fully established and ready."""
        print(f"[BRIDGE] Ready (next order ID: {orderId})")

    # ── Data requests ─────────────────────────────────────────────────────────
    def _request_data(self):
        """Request fresh account + position data from TWS."""
        self.account_values  = {}
        self.positions       = []
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
        if position != 0:
            self.positions.append({
                'symbol':        contract.symbol,
                'secType':       contract.secType,
                'currency':      contract.currency,
                'shares':        float(position),
                'marketPrice':   float(marketPrice),
                'marketValue':   float(marketValue),
                'avgCost':       float(averageCost),
                'unrealizedPNL': float(unrealizedPNL),
                'realizedPNL':   float(realizedPNL),
            })

    def accountDownloadEnd(self, accountName):
        self.account_ready.set()

    def position(self, account, contract, pos, avgCost):
        pass  # Handled in updatePortfolio

    def positionEnd(self):
        self.positions_ready.set()

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
            'positions': self.positions,
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
            data      = resp.json()
            nav       = payload['account']['netLiquidation']
            pos_count = len(payload['positions'])
            mismatch  = len(data.get('mismatches', []))
            ts        = datetime.now().strftime('%H:%M:%S')
            mismatch_str = f" | ⚠ {mismatch} share mismatch(es)" if mismatch else ""
            print(f"[BRIDGE] ✓ {ts}  NAV: ${nav:>12,.2f}  |  {pos_count} positions{mismatch_str}")
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
    """True during US market hours Mon–Fri 9:30–16:00 ET."""
    et  = timezone(timedelta(hours=-4))   # EDT (UTC-4); adjust to -5 in winter if needed
    now = datetime.now(et)
    if now.weekday() >= 5:
        return False
    open_  = now.replace(hour=9,  minute=30, second=0, microsecond=0)
    close_ = now.replace(hour=16, minute=0,  second=0, microsecond=0)
    return open_ <= now <= close_


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print("  PNTHR Den — IBKR TWS Bridge  (Phase 1: Read-Only)")
    print(f"  TWS:    {TWS_HOST}:{TWS_PORT}  (client ID {TWS_CLIENT_ID})")
    print(f"  Server: {PNTHR_API_URL}")
    print(f"  Sync:   every {SYNC_INTERVAL}s")
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

    print(f"[BRIDGE] Syncing every {SYNC_INTERVAL}s. Press Ctrl+C to stop.\n")

    try:
        while True:
            if app.connected:
                payload = app.get_payload()
                if payload['account']['netLiquidation'] > 0:
                    push_to_pnthr(payload)
                else:
                    print("[BRIDGE] ⚠ No account data yet — TWS may still be loading")
            else:
                print("[BRIDGE] Disconnected — attempting reconnect...")
                try:
                    app.connect(TWS_HOST, TWS_PORT, TWS_CLIENT_ID)
                    time.sleep(2)
                    app.reqAccountUpdates(True, "")
                    app.reqPositions()
                    app.account_ready.wait(timeout=15)
                except Exception:
                    pass

            time.sleep(SYNC_INTERVAL)

    except KeyboardInterrupt:
        print("\n[BRIDGE] Shutting down...")
        try:
            app.reqAccountUpdates(False, "")
            app.cancelPositions()
        except Exception:
            pass
        app.disconnect()
        print("[BRIDGE] Disconnected. Goodbye.")


if __name__ == '__main__':
    main()
