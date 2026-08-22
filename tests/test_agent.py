import importlib.util
import pathlib
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("hyu_agent", ROOT / "agent" / "agent.py")
AGENT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AGENT)


class AgentSafetyTests(unittest.TestCase):
    def test_usable_private_ipv4_accepts_only_rfc1918_hosts(self):
        for value in ("10.0.0.2", "172.16.10.4", "192.168.1.15"):
            self.assertTrue(AGENT.usable_private_ipv4(value), value)
        for value in (
            "127.0.0.1",
            "169.254.1.2",
            "100.64.0.1",
            "8.8.8.8",
            "224.0.0.1",
            "not-an-ip",
        ):
            self.assertFalse(AGENT.usable_private_ipv4(value), value)

    def test_scan_network_rejects_non_rfc1918_and_larger_than_24(self):
        import ipaddress

        self.assertTrue(
            AGENT.allowed_scan_network(ipaddress.ip_network("192.168.1.0/24"))
        )
        self.assertFalse(
            AGENT.allowed_scan_network(ipaddress.ip_network("192.168.0.0/16"))
        )
        self.assertFalse(
            AGENT.allowed_scan_network(ipaddress.ip_network("100.64.0.0/24"))
        )

    def test_set_proxy_enabled_rejects_stale_endpoint(self):
        config = {"disabled": []}
        command = {
            "command_type": "set_proxy_enabled",
            "payload": {
                "host": "192.168.1.15",
                "port": 7890,
                "protocol": "http",
                "enabled": False,
            },
        }
        ok, _, error = AGENT.execute_command(config, command, [])
        self.assertFalse(ok)
        self.assertIn("no longer present", error)

    def test_validate_proxy_preserves_protocol(self):
        config = {"scan_timeout_seconds": 0.1}
        proxies = [
            {
                "host": "192.168.1.15",
                "port": 7890,
                "protocol": "http",
                "healthy": False,
                "latency_ms": None,
            }
        ]
        command = {
            "command_type": "validate_proxy",
            "payload": {
                "host": "192.168.1.15",
                "port": 7890,
                "protocol": "http",
            },
        }
        with mock.patch.object(AGENT, "check_http_proxy", return_value=True):
            ok, updated, error = AGENT.execute_command(config, command, proxies)
        self.assertTrue(ok, error)
        self.assertEqual(updated[0]["protocol"], "http")
        self.assertTrue(updated[0]["healthy"])


if __name__ == "__main__":
    unittest.main()
