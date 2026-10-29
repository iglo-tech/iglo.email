#!/usr/bin/env python3
"""Read quota metadata without starting an inference turn or exposing account data."""

import datetime
import json
import math
import os
import selectors
import subprocess
import sys
import time


def sample():
    process = subprocess.Popen(
        ["codex", "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    pending = bytearray()
    deadline = time.monotonic() + 20

    def send(value):
        process.stdin.write((json.dumps(value) + "\n").encode())
        process.stdin.flush()

    def receive(request_id):
        while time.monotonic() < deadline:
            while b"\n" in pending:
                line, _, rest = pending.partition(b"\n")
                pending[:] = rest
                message = json.loads(line)
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError("quota_rpc_rejected")
                    return message["result"]
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            pending.extend(chunk)
            if len(pending) > 1024 * 1024:
                raise RuntimeError("quota_response_too_large")
        raise RuntimeError("quota_rpc_timeout")

    try:
        send({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {
                "name": "iglo_cos_quota",
                "title": "iglo.email quota preflight",
                "version": "1.0.0",
            }},
        })
        receive(1)
        send({"method": "initialized"})
        send({"id": 2, "method": "account/rateLimits/read"})
        return receive(2)
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdin.close()
        process.stdout.close()


def normalize(raw):
    buckets = raw.get("rateLimitsByLimitId") or {"default": raw.get("rateLimits")}
    windows = []
    for key, bucket in buckets.items():
        if not isinstance(bucket, dict):
            continue
        limit_id = bucket.get("limitId") or key
        # The generic Codex pool governs the Sol/Terra fleet. Keep unrelated
        # model buckets visible, but do not switch because an unused pool is low.
        relevant = limit_id in ("codex", "default")
        for name in ("primary", "secondary"):
            value = bucket.get(name)
            if not isinstance(value, dict):
                continue
            used = value.get("usedPercent")
            if isinstance(used, bool) or not isinstance(used, (int, float)):
                continue
            if not math.isfinite(used) or not 0 <= used <= 100:
                continue
            windows.append({
                "limitId": limit_id,
                "window": name,
                "usedPercent": used,
                "remainingPercent": 100 - used,
                "windowDurationMins": value.get("windowDurationMins"),
                "resetsAt": value.get("resetsAt"),
                "appliesToDefaultFleet": relevant,
            })
    relevant = [row["remainingPercent"] for row in windows if row["appliesToDefaultFleet"]]
    remaining = min(relevant) if relevant else None
    return {
        "available": remaining is not None,
        "windows": windows,
        "minimumRemainingPercent": remaining,
        "switchToAnthropic": remaining <= 1 if remaining is not None else None,
    }


if __name__ == "__main__":
    result = {
        "source": "codex-app-server/account/rateLimits/read",
        "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "thresholdRemainingPercent": 1,
    }
    try:
        result.update(normalize(sample()))
    except Exception as error:
        # Never print provider response bodies, auth files, account or billing data.
        result.update(available=False, switchToAnthropic=None, error=type(error).__name__)
    print(json.dumps(result, allow_nan=False))
    sys.exit(0 if result["available"] else 2)
