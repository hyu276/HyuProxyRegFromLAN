# HyuProxyRegFromLAN

Outbound-only LAN proxy registry and dashboard.

## Architecture

```text
                         INTERNET
                            |
                     +------v-------+
                     |   Vercel     |
                     | Live Website |
                     | + API health |
                     +------+-------+
                            |
                 +----------v----------+
                 |      Supabase       |
                 | Auth / PostgreSQL   |
                 | Realtime / Registry |
                 | Pairing / Commands  |
                 +----------+----------+
                            ^
                  outbound HTTPS only
                            |
                 +----------+----------+
LAN DEVICE       |      LAN Agent      |
-----------------| discover proxy      |
192.168.x.x      | validate HTTP/SOCKS |
local proxy ---->| register/update     |
                 | heartbeat/commands  |
                 +----------+----------+
                            |
                       local network
```

The dashboard is a control plane, not a public proxy gateway. The agent never opens an inbound Internet listener and never accepts arbitrary shell commands. For remote use of the actual proxy endpoint, put the devices in a private overlay network such as Tailscale instead of publishing the proxy port to the Internet.

## Current Supabase backend

Project URL: `https://zkrhwqgmynbbmoktokdq.supabase.co`

The browser uses a Supabase publishable key, which is intentionally public and is restricted by Row Level Security. Elevated backend credentials are not committed to this repository.

## Use in GitHub Codespaces

Open a Codespace from **this repository**. The included `.devcontainer/devcontainer.json` installs Python 3.12 and Node 22 and forwards port 8000.

Preview the dashboard locally:

```bash
python -m http.server 8000
```

Then open the forwarded port.

## Pair a LAN device

1. Sign in to the website.
2. Click **Generate key**.
3. On the LAN device, clone/download this repository.
4. Pair once:

```bash
python agent/agent.py pair --key ABCD1234EF56 --name PC-HUY-01
```

5. Start the agent:

```bash
python agent/agent.py run
```

The agent stores its credential at `~/.hyu-proxy-agent/config.json`. The raw token never goes into Supabase; only its SHA-256 digest is stored server-side.

## Discovery behavior

By default the agent scans only the current private IPv4 `/24` and these common proxy ports:

`7890, 7891, 1080, 8080, 3128, 8888, 9050`

The scan refuses public IP space and networks larger than `/24`. Edit `~/.hyu-proxy-agent/config.json` to change ports or set an explicit private `scan_cidr`.

## Dashboard commands

The database allows only structured commands:

- `rescan`
- `validate_proxy`
- `set_proxy_enabled`
- `rename_agent`

There is deliberately no `shell`, `exec`, or arbitrary command type.

## Windows auto-start

After pairing:

```powershell
powershell -ExecutionPolicy Bypass -File .\agent\install_windows.ps1
```

## Backend source of truth

- `supabase/migrations/0001_lan_proxy_registry.sql` — schema, RLS, pairing RPC, Realtime publication.
- `supabase/functions/lan-agent-api/index.ts` — pairing, heartbeat and command-result API.

The same migration/function are deployed to the connected Supabase project.
