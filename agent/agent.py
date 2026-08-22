#!/usr/bin/env python3
"""Hyu LAN Proxy Agent. Python 3.10+, standard library only.

The scanner is deliberately constrained to RFC1918 IPv4 networks of at most /24.
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
import re
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
VERSION = "1.1.0"
RFC1918_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


class ApiError(RuntimeError):
    def __init__(self, status: int, detail: str):
        super().__init__(f"API {status}: {detail}")
        self.status = status
        self.detail = detail


def default_config() -> dict[str, Any]:
    return {
        "api_base": DEFAULT_API,
        "agent_id": "",
        "agent_token": "",
        "name": socket.gethostname(),
        "lan_ip_override": "",
        "scan_cidr": "auto",
        "ports": DEFAULT_PORTS,
        "heartbeat_seconds": 10,
        "rescan_seconds": 300,
        "scan_timeout_seconds": 0.3,
        "scan_workers": 64,
        "disabled": [],
    }


def load_config() -> dict[str, Any]:
    config = default_config()
    if not CONFIG_PATH.exists():
        return config
    try:
        stored = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Could not read {CONFIG_PATH}. Fix or remove the invalid config file: {exc}"
        ) from exc
    if not isinstance(stored, dict):
        raise RuntimeError(f"{CONFIG_PATH} must contain a JSON object")
    config.update(stored)
    return config


def save_config(config: dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = CONFIG_PATH.with_suffix(".json.tmp")
    temp_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    try:
        os.chmod(temp_path, 0o600)
    except OSError:
        pass
    os.replace(temp_path, CONFIG_PATH)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


def usable_private_ipv4(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return bool(
        address.version == 4
        and address.is_private
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_unspecified
        and not address.is_reserved
        and any(address in network for network in RFC1918_NETWORKS)
    )


def allowed_scan_network(network: ipaddress.IPv4Network) -> bool:
    return bool(
        network.version == 4
        and network.num_addresses <= 256
        and any(network.subnet_of(parent) for parent in RFC1918_NETWORKS)
    )


def local_ipv4(config: dict[str, Any] | None = None) -> str:
    override = str((config or {}).get("lan_ip_override", "")).strip()
    if override:
        if not usable_private_ipv4(override):
            raise RuntimeError(
                f"lan_ip_override must be an RFC1918 IPv4 address, got: {override}"
            )
        return override

    candidates: list[str] = []
    for destination in (("1.1.1.1", 80), ("8.8.8.8", 80)):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(destination)
            candidates.append(sock.getsockname()[0])
        except OSError:
            pass
        finally:
            sock.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.append(info[4][0])
    except OSError:
        pass

    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if usable_private_ipv4(candidate):
            return candidate

    raise RuntimeError(
        "Could not determine a usable RFC1918 LAN IPv4 address. "
        "Set lan_ip_override in ~/.hyu-proxy-agent/config.json."
    )


def scan_network(config: dict[str, Any]) -> list[dict[str, Any]]:
    lan_ip = local_ipv4(config)
    raw_cidr = str(config.get("scan_cidr", "auto")).strip().lower()
    try:
        network = (
            ipaddress.ip_network(f"{lan_ip}/24", strict=False)
            if raw_cidr == "auto"
            else ipaddress.ip_network(raw_cidr, strict=False)
        )
    except ValueError as exc:
        raise RuntimeError(f"Invalid scan_cidr: {raw_cidr}") from exc

    if not isinstance(network, ipaddress.IPv4Network) or not allowed_scan_network(network):
        raise RuntimeError(
            "scan_cidr must be an RFC1918 IPv4 network of at most /24 "
            "(10/8, 172.16/12, or 192.168/16)"
        )

    ports: set[int] = set()
    try:
        for raw_port in config.get("ports", DEFAULT_PORTS):
            port = int(raw_port)
            if 1 <= port <= 65535:
                ports.add(port)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("ports must be a JSON array of integers") from exc
    if not ports:
        raise RuntimeError("No valid proxy ports are configured")

    timeout = max(0.1, min(float(config.get("scan_timeout_seconds", 0.3)), 2.0))
    workers = max(8, min(int(config.get("scan_workers", 64)), 128))
    targets = [(str(host), port) for host in network.hosts() for port in sorted(ports)]
    found: list[dict[str, Any]] = []

    def probe(target: tuple[str, int]):
        host, port = target
        result = detect_proxy(host, port, timeout)
        return {"host": host, "port": port, **result} if result else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
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
        sock.sendall(
            b"CONNECT example.com:443 HTTP/1.1\r\n"
            b"Host: example.com:443\r\n"
            b"Proxy-Connection: close\r\n\r\n"
        )
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
        if not out:
            return None
        candidate = out[0].strip()
        address = ipaddress.ip_address(candidate)
        return candidate if address.version == 4 else None
    except (FileNotFoundError, subprocess.SubprocessError, ValueError):
        return None


def api_post(config: dict[str, Any], route: str, payload: dict[str, Any], authenticated: bool = True) -> dict[str, Any]:
    base = str(config.get("api_base", DEFAULT_API)).rstrip("/")
    if not re.match(r"^https://", base, re.IGNORECASE):
        raise RuntimeError("api_base must use HTTPS")
    headers = {"content-type": "application/json", "user-agent": f"hyu-lan-agent/{VERSION}"}
    if authenticated:
        token = str(config.get("agent_token", ""))
        if not token:
            raise RuntimeError("Agent is not paired. Run the pair command first.")
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{base}/{route}", data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read().decode()
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise RuntimeError("API returned invalid JSON") from exc
            if not isinstance(parsed, dict):
                raise RuntimeError("API returned an unexpected response")
            return parsed
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise ApiError(exc.code, detail) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach API: {exc.reason}") from exc


def pair(config: dict[str, Any], pairing_key: str, name: str, force: bool = False) -> None:
    if config.get("agent_id") and config.get("agent_token") and not force:
        raise RuntimeError("This device is already paired. Remove the old agent from the dashboard and run pair again with --force if you intentionally want to replace it.")
    clean_name = name.strip()[:80]
    if not clean_name:
        raise RuntimeError("Agent name cannot be empty")
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    payload = {
        "pairing_key": pairing_key.replace(" ", "").strip().upper(),
        "token_hash": token_hash,
        "name": clean_name,
        "platform": f"{platform.system()} {platform.release()}",
        "agent_version": VERSION,
        "capabilities": {"discover": True, "validate": True, "heartbeat": True, "private_ipv4_only": True, "remote_shell": False},
    }
    result = api_post(config, "pair", payload, authenticated=False)
    agent_id = str(result.get("agent_id", ""))
    if not agent_id:
        raise RuntimeError("Pairing succeeded but the API did not return agent_id")
    config.update({"agent_id": agent_id, "agent_token": token, "name": clean_name})
    save_config(config)
    print(f"Paired as {clean_name} ({agent_id}). Credential saved to {CONFIG_PATH}")


def endpoint_key(host: str, port: int, protocol: str) -> str:
    return f"{host}:{int(port)}/{protocol.lower()}"


def find_proxy(proxies: list[dict[str, Any]], host: str, port: int, protocol: str) -> dict[str, Any] | None:
    wanted = endpoint_key(host, port, protocol)
    return next((proxy for proxy in proxies if endpoint_key(proxy["host"], proxy["port"], proxy["protocol"]) == wanted), None)


def execute_command(config: dict[str, Any], command: dict[str, Any], proxies: list[dict[str, Any]]) -> tuple[bool, list[dict[str, Any]], str | None]:
    kind = command.get("command_type")
    payload = command.get("payload") or {}
    try:
        if kind == "rescan":
            proxies = scan_network(config)
        elif kind == "validate_proxy":
            host, port, proto = str(payload["host"]), int(payload["port"]), str(payload["protocol"]).lower()
            if not usable_private_ipv4(host):
                raise ValueError("Refusing validation outside RFC1918 address space")
            if not 1 <= port <= 65535 or proto not in {"http", "socks5"}:
                raise ValueError("Invalid proxy endpoint")
            proxy = find_proxy(proxies, host, port, proto)
            if proxy is None:
                raise ValueError("Proxy is no longer present in the current snapshot")
            timeout = max(0.1, min(float(config.get("scan_timeout_seconds", 0.3)), 2.0))
            started = time.perf_counter()
            try:
                healthy = check_socks5(host, port, timeout) if proto == "socks5" else check_http_proxy(host, port, timeout)
            except OSError:
                healthy = False
            proxy["healthy"] = healthy
            proxy["latency_ms"] = max(1, round((time.perf_counter() - started) * 1000)) if healthy else None
        elif kind == "set_proxy_enabled":
            host, port, proto = str(payload["host"]), int(payload["port"]), str(payload["protocol"]).lower()
            if not usable_private_ipv4(host) or proto not in {"http", "socks5"} or not 1 <= port <= 65535:
                raise ValueError("Invalid proxy endpoint")
            if find_proxy(proxies, host, port, proto) is None:
                raise ValueError("Proxy is no longer present in the current snapshot")
            key = endpoint_key(host, port, proto)
            disabled = set(config.get("disabled", []))
            disabled.add(key) if payload.get("enabled") is False else disabled.discard(key)
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
    interval = max(5, min(int(config.get("heartbeat_seconds", 10)), 300))
    rescan_seconds = max(0, min(int(config.get("rescan_seconds", 300)), 86400))
    proxies: list[dict[str, Any]] = []
    snapshot_complete = False
    last_roundtrip_ms: int | None = None
    last_lan_ip: str | None = None
    next_scan_at = time.monotonic()
    if no_scan:
        next_scan_at = time.monotonic() + rescan_seconds if rescan_seconds else float("inf")
        print("Starting without an initial LAN scan.")
    else:
        print("Discovering private-network proxies…")
        try:
            proxies = scan_network(config)
            snapshot_complete = True
            print(f"Detected {len(proxies)} proxy endpoint(s).")
        except Exception as exc:
            print(f"Initial scan failed; heartbeat will continue and existing registry entries will be kept as stale/unhealthy: {exc}", file=sys.stderr)
        next_scan_at = time.monotonic() + rescan_seconds if rescan_seconds else float("inf")
    print("Starting heartbeat.")
    consecutive_failures = 0
    while True:
        now_mono = time.monotonic()
        if rescan_seconds and now_mono >= next_scan_at:
            try:
                proxies = scan_network(config)
                snapshot_complete = True
                print(f"periodic scan ok · proxies={len(proxies)}")
                next_scan_at = time.monotonic() + rescan_seconds
            except Exception as exc:
                print(f"periodic scan failed: {exc}", file=sys.stderr)
                next_scan_at = time.monotonic() + min(60, rescan_seconds)
        disabled = set(config.get("disabled", []))
        outbound = []
        for proxy in proxies:
            item = dict(proxy)
            item["enabled"] = endpoint_key(item["host"], item["port"], item["protocol"]) not in disabled
            outbound.append(item)
        try:
            last_lan_ip = local_ipv4(config)
        except Exception as exc:
            print(f"LAN IP detection failed; using last known value: {exc}", file=sys.stderr)
        payload = {
            "name": config.get("name", socket.gethostname()),
            "lan_ip": last_lan_ip,
            "tailscale_ip": tailscale_ipv4(),
            "agent_version": VERSION,
            "latency_ms": last_roundtrip_ms,
            "proxy_snapshot_complete": snapshot_complete,
            "proxies": outbound,
        }
        started = time.perf_counter()
        sleep_for = interval
        try:
            result = api_post(config, "heartbeat", payload)
            last_roundtrip_ms = max(1, round((time.perf_counter() - started) * 1000))
            consecutive_failures = 0
            commands = result.get("commands") or []
            if commands:
                print(f"Received {len(commands)} command(s).")
            for command in commands:
                ok, proxies, error = execute_command(config, command, proxies)
                if ok and command.get("command_type") == "rescan":
                    snapshot_complete = True
                    next_scan_at = time.monotonic() + rescan_seconds if rescan_seconds else float("inf")
                try:
                    api_post(config, "command-result", {"command_id": command["id"], "ok": ok, "error": error})
                except Exception as report_error:
                    print(f"Could not report command result; the command may be retried: {report_error}", file=sys.stderr)
            print(f"heartbeat ok · proxies={len(proxies)} · roundtrip={last_roundtrip_ms}ms")
        except ApiError as exc:
            consecutive_failures += 1
            if exc.status == 401:
                raise RuntimeError("Agent credential was rejected. Remove this device from the dashboard, then pair it again.") from exc
            sleep_for = min(60, interval * (2 ** min(consecutive_failures, 3)))
            print(f"heartbeat failed: {exc} · retry in {sleep_for}s", file=sys.stderr)
        except Exception as exc:
            consecutive_failures += 1
            sleep_for = min(60, interval * (2 ** min(consecutive_failures, 3)))
            print(f"heartbeat failed: {exc} · retry in {sleep_for}s", file=sys.stderr)
        time.sleep(sleep_for)


def print_status(config: dict[str, Any]) -> None:
    print(json.dumps({
        "paired": bool(config.get("agent_id") and config.get("agent_token")),
        "agent_id": config.get("agent_id") or None,
        "name": config.get("name"),
        "api_base": config.get("api_base"),
        "lan_ip_override": config.get("lan_ip_override") or None,
        "scan_cidr": config.get("scan_cidr"),
        "ports": config.get("ports"),
        "heartbeat_seconds": config.get("heartbeat_seconds"),
        "rescan_seconds": config.get("rescan_seconds"),
        "scan_timeout_seconds": config.get("scan_timeout_seconds"),
        "scan_workers": config.get("scan_workers"),
        "tailscale_ip": tailscale_ipv4(),
        "credential_path": str(CONFIG_PATH),
        "credential_present": bool(config.get("agent_token")),
    }, indent=2))


def reset_local_config(config: dict[str, Any], confirmed: bool) -> None:
    if not confirmed:
        raise RuntimeError("Refusing to remove the local credential without --yes. Remove the agent from the dashboard first.")
    if CONFIG_PATH.exists():
        CONFIG_PATH.unlink()
    print("Local pairing credential removed. The server-side agent entry is not deleted automatically; remove it from the dashboard if it still exists.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Hyu LAN Proxy Agent")
    sub = parser.add_subparsers(dest="command", required=True)
    pair_p = sub.add_parser("pair", help="Pair this device using a one-time dashboard key")
    pair_p.add_argument("--key", required=True)
    pair_p.add_argument("--name", default=socket.gethostname())
    pair_p.add_argument("--force", action="store_true", help="Replace an existing local pairing credential")
    run_p = sub.add_parser("run", help="Discover proxies and start heartbeat")
    run_p.add_argument("--no-scan", action="store_true", help="Start heartbeat without an initial LAN scan")
    scan_p = sub.add_parser("scan", help="Run a one-off private-LAN proxy scan")
    scan_p.add_argument("--json", action="store_true")
    sub.add_parser("status", help="Show local agent configuration without the token")
    reset_p = sub.add_parser("reset", help="Remove the local pairing credential/configuration")
    reset_p.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    config = load_config()
    if args.command == "pair":
        pair(config, args.key, args.name, args.force)
    elif args.command == "run":
        run(config, args.no_scan)
    elif args.command == "scan":
        result = scan_network(config)
        print(json.dumps(result, indent=2) if args.json else "\n".join(f"{p['host']}:{p['port']} {p['protocol'].upper()} {p['latency_ms']}ms" for p in result))
    elif args.command == "status":
        print_status(config)
    elif args.command == "reset":
        reset_local_config(config, args.yes)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
