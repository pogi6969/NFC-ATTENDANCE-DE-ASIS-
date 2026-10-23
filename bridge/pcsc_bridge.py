#!/usr/bin/env python3
"""USB NFC reader bridge (ACR122U and other PC/SC readers).

Runs on the computer the reader is plugged into. Each card tap is sent to the
attendance server; taps made while offline are saved in queue.json and sent later.

    pip install pyscard
    python pcsc_bridge.py --server https://your-server.example.com --key dev_xxx

The key comes from the dashboard: Gate readers -> Add reader.
"""

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from smartcard.CardMonitoring import CardMonitor, CardObserver
from smartcard.Exceptions import CardConnectionException, NoCardException

GET_UID = [0xFF, 0xCA, 0x00, 0x00, 0x00]
QUEUE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "queue.json")


class Bridge:
    def __init__(self, server, key):
        self.url = server.rstrip("/") + "/api/tap"
        self.key = key
        self.lock = threading.Lock()
        self.last = ("", 0.0)

    def post(self, uid, at=None):
        body = {"uid": uid}
        if at:
            body["at"] = at
        req = urllib.request.Request(
            self.url,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "X-Device-Key": self.key},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode())

    def load_queue(self):
        try:
            with open(QUEUE_FILE) as f:
                return json.load(f)
        except (OSError, ValueError):
            return []

    def save_queue(self, items):
        with open(QUEUE_FILE, "w") as f:
            json.dump(items[-5000:], f)

    def tap(self, uid):
        now = time.monotonic()
        if self.last[0] == uid and now - self.last[1] < 3:
            return
        self.last = (uid, now)
        try:
            r = self.post(uid)
        except urllib.error.HTTPError as e:
            print(f"{uid}: not recorded ({e.code}) {e.read().decode(errors='replace')}")
            return
        except (urllib.error.URLError, OSError):
            with self.lock:
                q = self.load_queue()
                q.append({"uid": uid, "at": datetime.now(timezone.utc).isoformat()})
                self.save_queue(q)
            print(f"{uid}: offline, saved ({len(q)} waiting)")
            return
        if r.get("status") == "ok":
            s = r["student"]
            print(f"{r['direction']:3}  {r['time']:>8}  {s['name']} ({s.get('grade', '')} {s.get('section', '')})")
        else:
            print(f"{uid}: {r.get('message', r.get('status'))}")

    def sync_forever(self):
        while True:
            time.sleep(15)
            with self.lock:
                q = self.load_queue()
                while q:
                    try:
                        self.post(q[0]["uid"], q[0]["at"])
                    except urllib.error.HTTPError as e:
                        if e.code == 401 or e.code >= 500:
                            break
                        # Rejected for good (for example older than 7 days): drop it.
                    except (urllib.error.URLError, OSError):
                        break
                    q = q[1:]
                    self.save_queue(q)
                    print(f"synced an offline tap ({len(q)} left)")


class Observer(CardObserver):
    def __init__(self, bridge):
        self.bridge = bridge

    def update(self, observable, actions):
        added, _removed = actions
        for card in added:
            try:
                conn = card.createConnection()
                conn.connect()
                data, sw1, sw2 = conn.transmit(GET_UID)
                conn.disconnect()
            except (CardConnectionException, NoCardException) as e:
                print(f"could not read the card: {e}")
                continue
            if (sw1, sw2) == (0x90, 0x00) and data:
                self.bridge.tap("".join(f"{b:02X}" for b in data))


def main():
    p = argparse.ArgumentParser(description="Send NFC taps from a USB reader to the attendance server.")
    p.add_argument("--server", default=os.environ.get("NFC_SERVER", ""), help="server address, e.g. https://attendance.school.edu.ph")
    p.add_argument("--key", default=os.environ.get("NFC_DEVICE_KEY", ""), help="reader key from the dashboard")
    args = p.parse_args()
    if not args.server or not args.key:
        p.error("--server and --key are required (or set NFC_SERVER and NFC_DEVICE_KEY)")

    bridge = Bridge(args.server, args.key)
    threading.Thread(target=bridge.sync_forever, daemon=True).start()
    monitor = CardMonitor()
    monitor.addObserver(Observer(bridge))
    print("Ready. Tap a card on the reader. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
