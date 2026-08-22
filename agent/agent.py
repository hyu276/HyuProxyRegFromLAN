#!/usr/bin/env python3
"""Hyu LAN Proxy Agent. Python 3.10+, standard library only.

The scanner is deliberately constrained to the current RFC1918 /24 by default.
It never scans public address space and never executes arbitrary remote commands.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import ipaddress
import json
import os
import platform
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_API = "https://zkrhwqgmynbbmoktokdq.supabase.co/functions/v1/lan-agent-api"
DEFAULT_PORTS = [7890, 7891, 1080, 8080, 3128, 8888, 9050]
CONFIG_DIR = Path.home() / ".hyu-proxy-agent"
CONFIG_PATH = CONFIG_DIR / "config.json"
VERSION = "1.0.0"


def load_config() -> dict[str, Any]:
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return {"api_base": DEFAULT_API, "agent_id": "", "agent_token": "", "name": socket.gethostname(), "scan_cidr": "auto", "ports": DEFAULT_PORTS, "heartbeat_seconds": 10, "scan_timeout_seconds": 0.3, "disabled": []}


def save_config(config: dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


def local_ipv4() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
    except OSError:
        ip = socket.gethostbyname(socket.gethostname())
    finally:
        sock.close()
    address = ipaddress.ip_address(ip)
    if not address.is_private:
        raise RuntimeError(f"Refusing non-private LAN address: {ip}")
    return ip


def scan_network(config: dict[str, Any]) -> list[dict[str, Any]]:
    lan_ip = local_ipv4()
    raw_cidr = str(config.get("scan_cidr", "auto"))
    network = ipaddress.ip_network(f"{lan_ip}/24", strict=False) if raw_cidr == "auto" else ipaddress.ip_network(raw_cidr, strict=False)
    if not network.is_private or network.version != 4:
        raise RuntimeError("scan_cidr must be a private IPv4 network")
    if network.num_addresses > 256:
        raise RuntimeError("scan_cidr is limited to at most a /24 (256 addresses)")
    ports = sorted({int(p) for p in config.get("ports", DEFAULT_PORTS) if 1 <= int(p) <= 65535})
    timeout = max(0.1, min(float(config.get("scan_timeout_seconds", 0.3)), 2.0))
    targets = [(str(host), port) for host in network.hosts() for port in ports]
    found: list[dict[str, Any]] = []

    def probe(target: tuple[str, int]):
        host, port = target
        result = detect_proxy(host, port, timeout)
        return {"host": host, "port": port, **result} if result else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=96) as pool:
        for result in pool.map(probe, targets, chunksize=8):
            if result:
                found.append(result)
    return sorted(found, key=lambda p: (ipaddress.ip_address(p["host"]), p["port"], p["protocol"]))


def detect_proxy(host: str, port: int, timeout: float) -> dict[str, Any] | None:
    preferred_socks = port in {1080, 7891, 9050}
    checks = [check_socks5, check_http_proxy] if preferred_socks else [check_http_proxy, check_socks5]
    for check in checks:
        started = time.perf_counter()
        try:
            if check(host, port, timeout):
                ms = max(1, round((time.perf_counter() - started) * 1000))
                return {"protocol": "socks5" if check is check_socks5 else "http", "healthy": True, "latency_ms": ms}
        except OSError:
            pass
    return None


def check_socks5(host: str, port: int, timeout: float) -> bool:
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(b"\x05\x01\x00")
        return sock.recv(2) == b"\x05\x00"


def check_http_proxy(host: str, port: int, timeout: float) -> bool:
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Connection: close\r\n\r\n")
        data = sock.recv(96)
        if not data.startswith(b"HTTP/"):
            return False
        try:
            status = int(data.split(b" ", 2)[1])
        except (IndexError, ValueError):
            return False
        return 200 <= status < 300 or status == 407


def tailscale_ipv4() -> str | None:
    try:
        out = subprocess.check_output(["tailscale", "ip", "-4"], stderr=subprocess.DEVNULL, timeout=2, text=True).strip().splitlines()
        return out[0].strip() if out else None
    except (FileNotFoundError, subprocess.SubprocessError):
        return None


def api_post(config: dict[str, Any], route: str, payload: dict[str, Any], authenticated: bool = True) -> dict[str, Any]:
    base = str(config.get("api_base", DEFAULT_API)).rstrip("/")
    headers = {"content-type": "application/json", "user-agent": f"hyu-lan-agent/{VERSION}"}
    if authenticated:
        token = str(config.get("agent_token", ""))
        if not token:
            raise RuntimeError("Agent is not paired. Run the pair command first.")
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{base}/{route}", data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"API {exc.code}: {detail}") from exc


def pair(config: dict[str, Any], pairing_key: str, name: str) -> None:
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    payload = {"pairing_key": pairing_key.replace(" ", "").strip().upper(), "token_hash": token_hash, "name": name, "platform": f"{platform.system()} {platform.release()}", "agent_version": VERSION, "capabilities": {"discover": True, "validate": True, "heartbeat": True, "private_ipv4_only": True, "remote_shell": False}}
    result = api_post(config, "pair", payload, authenticated=False)
    config.update({"agent_id": result["agent_id"], "agent_token": token, "name": name})
    save_config(config)
    print(f"Paired as {name} ({result['agent_id']}). Credential saved to {CONFIG_PATH}")


def endpoint_key(host: str, port: int, protocol: str) -> str:
    return f"{host}:{int(port)}/{protocol.lower()}"


def execute_command(config: dict[str, Any], command: dict[str, Any], proxies: list[dict[str, Any]]) -> tuple[bool, list[dict[str, Any]], str | None]:
    kind = command.get("command_type")
    payload = command.get("payload") or {}
    try:
        if kind == "rescan":
            proxies = scan_network(config)
        elif kind == "validate_proxy":
            host, port, proto = str(payload["host"]), int(payload["port"]), str(payload["protocol"]).lower()
            if not ipaddress.ip_address(host).is_private:
                raise ValueError("Refusing validation outside private address space")
            check = detect_proxy(host, port, float(config.get("scan_timeout_seconds", 0.3)))
            for p in proxies:
                if endpoint_key(p["host"], p["port"], p["protocol"]) == endpoint_key(host, port, proto):
                    p.update(check or {"healthy": False, "latency_ms": None})
        elif kind == "set_proxy_enabled":
            key = endpoint_key(payload["host"], int(payload["port"]), payload["protocol"])
            disabled = set(config.get("disabled", []))
            if payload.get("enabled") is False:
                disabled.add(key)
            else:
                disabled.discard(key)
            config["disabled"] = sorted(disabled)
            save_config(config)
        elif kind == "rename_agent":
            name = str(payload.get("name", "")).strip()[:80]
            if not name:
                raise ValueError("name is required")
            config["name"] = name
            save_config(config)
        else:
            raise ValueError(f"Unsupported command: {kind}")
        return True, proxies, None
    except Exception as exc:
        return False, proxies, str(exc)


def run(config: dict[str, Any], no_scan: bool = False) -> None:
    if not config.get("agent_id") or not config.get("agent_token"):
        raise RuntimeError("Agent is not paired. Run: python agent/agent.py pair --key <KEY> --name <NAME>")
    print("Discovering private-network proxies…")
    proxies = [] if no_scan else scan_network(config)
    print(f"Detected {len(proxies)} proxy endpoint(s). Starting heartbeat.")
    interval = max(5, min(int(config.get("heartbeat_seconds", 10)), 300))
    while True:
        started = time.perf_counter()
        disabled = set(config.get("disabled", []))
        outbound = []
        for p in proxies:
            q = dict(p)
            q["enabled"] = endpoint_key(q["host"], q["port"], q["protocol"]) not in disabled
            outbound.append(q)
        payload = {"name": config.get("name", socket.gethostname()), "lan_ip": local_ipv4(), "tailscale_ip": tailscale_ipv4(), "agent_version": VERSION, "latency_ms": None, "proxies": outbound}
        try:
            result = api_post(config, "heartbeat", payload)
            network_ms = max(1, round((time.perf_counter() - started) * 1000))
            commands = result.get("commands") or []
            if commands:
                print(f"Received {len(commands)} command(s).")
            for command in commands:
                ok, proxies, error = execute_command(config, command, proxies)
                try:
                    api_post(config, "command-result", {"command_id": command["id"], "ok": ok, "error": error})
                except Exception as report_error:
                    print(f"Could not report command result: {report_error}", file=sys.stderr)
            print(f"heartbeat ok · proxies={len(proxies)} · roundtrip={network_ms}ms")
        except Exception as exc:
            print(f"heartbeat failed: {exc}", file=sys.stderr)
        time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description="Hyu LAN Proxy Agent")
    sub = parser.add_subparsers(dest="command", required=True)
    pair_p = sub.add_parser("pair", help="Pair this device using a one-time dashboard key")
    pair_p.add_argument("--key", required=True)
    pair_p.add_argument("--name", default=socket.gethostname())
    run_p = sub.add_parser("run", help="Discover proxies and start heartbeat")
    run_p.add_argument("--no-scan", action="store_true", help="Start heartbeat without an initial LAN scan")
    scan_p = sub.add_parser("scan", help="Run a one-off private-LAN proxy scan")
    scan_p.add_argument("--json", action="store_true")
    args = parser.parse_args()
    config = load_config()
    if args.command == "pair": pair(config, args.key, args.name)
    elif args.command == "run": run(config, args.no_scan)
    elif args.command == "scan":
        result = scan_network(config)
        print(json.dumps(result, indent=2) if args.json else "\n".join(f"{p['host']}:{p['port']} {p['protocol'].upper()} {p['latency_ms']}ms" for p in result))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
