#!/usr/bin/env python3
"""Core (deltachat-rpc-server) SecureJoin helper for local madmail Docker tests.

Env:
  MADMAIL_URL   default https://172.28.100.10
  MODE          core-core | core-inviter | core-joiner
  SJ_TIMEOUT_MS default 90000
  INVITE_FILE   for core-joiner (path to invite URI text file)
"""
from __future__ import annotations

import json
import os
import shutil
import ssl
import sys
import time
import urllib.request
from pathlib import Path

from deltachat_rpc_client import Rpc, DeltaChat

SERVER = os.environ.get("MADMAIL_URL", "https://172.28.100.10")
MODE = os.environ.get("MODE", "core-core")
TIMEOUT = int(os.environ.get("SJ_TIMEOUT_MS", "90000")) / 1000.0

_ssl = ssl.create_default_context()
_ssl.check_hostname = False
_ssl.verify_mode = ssl.CERT_NONE


def reg() -> dict:
    req = urllib.request.Request(f"{SERVER}/new", method="POST")
    with urllib.request.urlopen(req, context=_ssl, timeout=30) as r:
        return json.loads(r.read())


def make_account(label: str):
    d = Path(f"/tmp/dc-docker-sj-{label}-{os.getpid()}")
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    rpc = Rpc(accounts_dir=str(d))
    rpc.start()
    dc = DeltaChat(rpc)
    acc = dc.add_account()
    info = reg()
    print(f"[{label}] registered {info['email']}", flush=True)
    acc.add_transport_from_qr(info["dclogin_url"])
    try:
        acc.set_config("imap_certificate_checks", "3")
    except Exception:
        pass
    acc.bring_online()
    for _ in range(40):
        if acc.is_configured():
            break
        time.sleep(0.25)
    if not acc.is_configured():
        raise RuntimeError(f"{label} not configured")
    print(f"[{label}] configured", flush=True)
    return rpc, acc, info


def wait_joiner_success(acc, timeout=TIMEOUT) -> bool:
    """Use official helper; falls back to manual event loop with deadline."""
    import threading

    result = {"ok": False}

    def _run():
        try:
            acc.wait_for_securejoin_joiner_success()
            result["ok"] = True
        except Exception as e:
            print(f"  joiner wait error: {e}", flush=True)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        print("  joiner wait timeout", flush=True)
        return False
    return result["ok"]


def wait_inviter_success(acc, timeout=TIMEOUT) -> bool:
    import threading

    result = {"ok": False}

    def _run():
        try:
            acc.wait_for_securejoin_inviter_success()
            result["ok"] = True
        except Exception as e:
            print(f"  inviter wait error: {e}", flush=True)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        print("  inviter wait timeout", flush=True)
        return False
    return result["ok"]


def core_core() -> int:
    rpc_a, alice, _ = make_account("alice")
    rpc_b, bob, _ = make_account("bob")
    qr = alice.get_qr_code()
    print("INVITE_URI=" + qr, flush=True)

    # Start waiters before join so we don't miss progress events
    import threading

    inviter_ok = {"v": False}
    joiner_ok = {"v": False}

    def inv():
        inviter_ok["v"] = wait_inviter_success(alice, TIMEOUT)

    def joi():
        joiner_ok["v"] = wait_joiner_success(bob, TIMEOUT)

    ti = threading.Thread(target=inv, daemon=True)
    tj = threading.Thread(target=joi, daemon=True)
    ti.start()
    tj.start()
    time.sleep(0.3)

    chat = bob.secure_join(qr)
    print(f"secure_join chat_id={getattr(chat, 'id', chat)}", flush=True)
    tj.join(TIMEOUT + 5)
    ti.join(25)
    print(f"joiner_ok={joiner_ok['v']} inviter_ok={inviter_ok['v']}", flush=True)
    rpc_a.close()
    rpc_b.close()
    if joiner_ok["v"]:
        print("RESULT ok", flush=True)
        return 0
    print("RESULT fail", flush=True)
    return 1


def core_inviter() -> int:
    rpc_a, alice, _ = make_account("core-inviter")
    qr = alice.get_qr_code()
    print("INVITE_URI=" + qr, flush=True)
    done = Path("/tmp/sj-cross-done")
    if done.exists():
        done.unlink()
    ok = wait_inviter_success(alice, TIMEOUT + 60)
    # also allow done-file signal
    if not ok and done.exists() and done.read_text().strip() == "1":
        ok = wait_inviter_success(alice, 25)
    print(f"inviter_ok={ok}", flush=True)
    rpc_a.close()
    if ok:
        print("RESULT ok", flush=True)
        return 0
    print("RESULT fail", flush=True)
    return 1


def core_joiner() -> int:
    invite_file = os.environ.get("INVITE_FILE", "/tmp/sj-madcore-invite.txt")
    uri = Path(invite_file).read_text().strip()
    print("joining", uri[:100], flush=True)
    rpc_b, bob, _ = make_account("core-joiner")
    import threading

    joiner_ok = {"v": False}

    def joi():
        joiner_ok["v"] = wait_joiner_success(bob, TIMEOUT)

    t = threading.Thread(target=joi, daemon=True)
    t.start()
    time.sleep(0.3)
    chat = bob.secure_join(uri)
    print(f"secure_join chat_id={getattr(chat, 'id', chat)}", flush=True)
    t.join(TIMEOUT + 5)
    rpc_b.close()
    if joiner_ok["v"]:
        print("RESULT ok", flush=True)
        return 0
    print("RESULT fail", flush=True)
    return 1


def main() -> None:
    print(f"MODE={MODE} SERVER={SERVER}", flush=True)
    if MODE == "core-core":
        sys.exit(core_core())
    if MODE == "core-inviter":
        sys.exit(core_inviter())
    if MODE == "core-joiner":
        sys.exit(core_joiner())
    print("unknown MODE", MODE, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
