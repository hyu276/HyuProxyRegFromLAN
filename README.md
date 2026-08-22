# HyuProxyRegFromLAN

Outbound-only LAN proxy registry and dashboard.

Live dashboard: `https://hyu-proxy-reg-from-lan.vercel.app`

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
RFC1918 IPv4     | validate HTTP/SOCKS |
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
npm run dev
```

Then open the forwarded port.

> Codespaces is only for development/preview. A Codespace is not inside your home/office LAN, so it cannot discover proxies on your physical `192.168.x.x`, `10.x.x.x`, or `172.16-31.x.x` network. Run `agent/agent.py` on the actual LAN device that can reach the proxies.

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

By default the agent scans only RFC1918 private IPv4 space, limited to the current `/24`, and these common proxy ports:

`7890, 7891, 1080, 8080, 3128, 8888, 9050`

The scan rejects public, loopback, link-local and non-RFC1918 addresses, and refuses networks larger than `/24`. Edit `~/.hyu-proxy-agent/config.json` to change ports, set an explicit private `scan_cidr`, or set `lan_ip_override` if automatic adapter detection chooses the wrong LAN interface.

## Dashboard commands

The database allows only structured commands:

- `rescan`
- `validate_proxy`
- `set_proxy_enabled`
- `rename_agent`

There is deliberately no `shell`, `exec`, or arbitrary command type. The **Registry** toggle only controls whether that endpoint is enabled in this registry; it does not start or stop the underlying proxy application on the LAN device.

## Windows auto-start

After pairing:

```powershell
powershell -ExecutionPolicy Bypass -File .\agent\install_windows.ps1
```

## Backend source of truth

- `supabase/migrations/0001_lan_proxy_registry.sql` — initial schema, RLS, pairing RPC, Realtime publication.
- `supabase/migrations/0002_audit_hardening.sql` — least-privilege grants, optimized RLS, command retry leases, device removal support.
- `supabase/functions/lan-agent-api/index.ts` — pairing, heartbeat and command-result API.

The same migrations/function are deployed to the connected Supabase project.

---

## Hướng dẫn sử dụng chi tiết (Tiếng Việt)

### 1. Repo này dùng để làm gì?

Repo này tạo một **control plane quản lý proxy trong LAN từ xa**. Một LAN Agent nhẹ chạy trên máy thật trong mạng nội bộ sẽ:

1. Xác định IPv4 LAN thuộc dải RFC1918.
2. Quét các port proxy được cấu hình trong phạm vi tối đa `/24`.
3. Thực hiện handshake để phân biệt HTTP proxy và SOCKS5 thay vì chỉ coi một port mở là proxy.
4. Gửi heartbeat, IP, trạng thái proxy và latency lên Supabase qua HTTPS outbound.
5. Nhận một tập lệnh có cấu trúc từ dashboard như rescan/validate/enable-disable/rename.

Website trên Vercel chỉ quản lý state. Website **không phải proxy gateway** và backend không mở cổng inbound từ Internet vào LAN.

### 2. Yêu cầu trước khi sử dụng

Trên máy LAN nên có:

- Python 3.10 trở lên. Python 3.12 được khuyến nghị.
- Git nếu muốn clone repo bằng lệnh.
- Kết nối Internet outbound HTTPS tới Supabase.
- Quyền truy cập mạng tới các host/port proxy cần phát hiện.
- Tailscale là tùy chọn nếu bạn muốn truy cập proxy qua private overlay từ thiết bị khác.

Không cần cài thư viện Python ngoài vì agent chỉ dùng standard library.

### 3. Mở dashboard

Bản production hiện tại:

```text
https://hyu-proxy-reg-from-lan.vercel.app
```

Tại dashboard:

1. Tạo tài khoản hoặc đăng nhập bằng email/password.
2. Sau khi đăng nhập, dashboard chỉ đọc agent/proxy thuộc tài khoản hiện tại nhờ Supabase RLS.
3. Bấm **Generate key** để tạo pairing key dùng một lần.

Pairing key có thời hạn 10 phút. Mỗi lần tạo key mới, pairing key cũ chưa dùng của cùng tài khoản sẽ bị vô hiệu hóa để tránh có nhiều key còn hiệu lực cùng lúc.

### 4. Cài LAN Agent trên máy thật trong LAN

Clone repo:

```bash
git clone https://github.com/hyu276/HyuProxyRegFromLAN.git
cd HyuProxyRegFromLAN
```

Kiểm tra Python:

```bash
python --version
```

Nếu Windows chỉ nhận lệnh `py`, có thể thay `python` bằng `py` trong các ví dụ.

> Không chạy LAN Agent trong GitHub Codespaces để quét mạng nhà/văn phòng. Codespace nằm trên hạ tầng cloud nên không nhìn thấy LAN vật lý của bạn.

### 5. Pair máy LAN với tài khoản

Trên website, bấm **Generate key**, ví dụ nhận được:

```text
ABCD1234EF56
```

Trên máy LAN chạy:

```bash
python agent/agent.py pair --key ABCD1234EF56 --name PC-HUY-01
```

Sau khi thành công:

- Agent ID và token cục bộ được lưu tại `~/.hyu-proxy-agent/config.json`.
- Server chỉ lưu SHA-256 của token, không lưu raw token.
- Pairing key không thể dùng lại.

Nếu máy đã từng pair và bạn thực sự muốn thay credential:

```bash
python agent/agent.py pair --key NEW_PAIRING_KEY --name PC-HUY-01 --force
```

Thông thường nên **Remove** agent cũ trên dashboard trước để tránh để lại thiết bị orphan.

### 6. Quét proxy một lần để kiểm tra

Trước khi chạy daemon, có thể test discovery:

```bash
python agent/agent.py scan
```

Xuất JSON:

```bash
python agent/agent.py scan --json
```

Ví dụ kết quả:

```text
192.168.1.15:7890 HTTP 18ms
192.168.1.15:7891 SOCKS5 12ms
```

Nếu không có kết quả, xem mục **Xử lý sự cố** bên dưới.

### 7. Chạy Agent liên tục

```bash
python agent/agent.py run
```

Agent sẽ:

- quét ban đầu;
- gửi heartbeat theo `heartbeat_seconds`;
- tự quét lại theo `rescan_seconds`;
- cập nhật round-trip latency của heartbeat;
- tự reconnect với exponential backoff khi mạng/backend tạm thời lỗi;
- nhận command từ dashboard;
- không crash toàn bộ chỉ vì một lần scan LAN thất bại.

Nếu muốn khởi động heartbeat trước mà bỏ qua scan ban đầu:

```bash
python agent/agent.py run --no-scan
```

Trong chế độ này backend không coi danh sách proxy rỗng là một snapshot hoàn chỉnh, vì vậy proxy cũ không bị xóa nhầm chỉ vì scan chưa chạy xong.

### 8. Kiểm tra trạng thái cấu hình cục bộ

```bash
python agent/agent.py status
```

Lệnh này hiển thị thông tin chẩn đoán nhưng không in raw agent token.

### 9. Các chỉ số trên dashboard

Mỗi agent có thể hiển thị:

- **Status**: ONLINE/OFFLINE dựa vào heartbeat gần nhất.
- **LAN IP**: địa chỉ RFC1918 của máy chạy agent.
- **Public IP**: IP mà Supabase nhìn thấy ở request.
- **Tailscale IP**: IP `100.64.0.0/10` nếu máy có Tailscale và lệnh `tailscale ip -4` hoạt động.
- **Heartbeat RTT**: độ trễ request/response agent ↔ backend.
- **Last heartbeat**: thời gian từ heartbeat gần nhất.
- Danh sách endpoint proxy, protocol, health, proxy latency và registry state.

Chỉ số **Healthy + online** không tính proxy của agent đang offline để tránh dashboard báo xanh cho endpoint thực tế đã mất kết nối.

### 10. Các thao tác từ dashboard

**Rescan LAN**: yêu cầu agent quét lại mạng.

**Validate**: kiểm tra lại handshake và latency của một proxy đã biết.

**Registry toggle**: bật/tắt endpoint trong registry. Đây **không phải** nút bật/tắt ứng dụng proxy thật trên máy LAN.

**Rename**: đổi tên agent.

**Remove**: xóa agent khỏi tài khoản và cascade xóa credential/proxy/command/event của agent đó. Sau khi Remove, token cũ không thể heartbeat nữa.

Dashboard ngăn enqueue các thao tác mới khi agent offline và chống spam nhiều command `rescan` đang pending cùng lúc.

### 11. Cấu hình nâng cao

File cấu hình nằm tại:

```text
~/.hyu-proxy-agent/config.json
```

Các trường chính:

| Trường | Ý nghĩa | Mặc định |
| --- | --- | --- |
| `api_base` | Supabase Edge Function endpoint | project hiện tại |
| `name` | Tên agent | hostname |
| `lan_ip_override` | Ép dùng một IPv4 RFC1918 cụ thể khi máy có nhiều NIC | rỗng |
| `scan_cidr` | CIDR private cần scan; `auto` dùng `/24` quanh LAN IP | `auto` |
| `ports` | Danh sách port cần kiểm tra | `7890,7891,1080,8080,3128,8888,9050` |
| `heartbeat_seconds` | Chu kỳ heartbeat | `10` |
| `rescan_seconds` | Chu kỳ auto-rescan; `0` để tắt | `300` |
| `scan_timeout_seconds` | Timeout mỗi probe | `0.3` |
| `scan_workers` | Số worker song song | `64` |
| `disabled` | Danh sách endpoint bị disable trong registry | tự quản lý |

Agent từ chối scan public IP, loopback, link-local, CGNAT và network lớn hơn `/24`. Mục tiêu là giảm nguy cơ biến tool thành network scanner tổng quát.

### 12. Máy có nhiều card mạng / chọn sai LAN IP

Nếu máy có Wi-Fi, Ethernet, VPN và Tailscale cùng lúc, auto detection có thể chọn interface không mong muốn.

Chạy:

```bash
python agent/agent.py status
```

Sau đó sửa:

```json
"lan_ip_override": "192.168.1.15"
```

Giá trị override bắt buộc phải là IPv4 RFC1918 hợp lệ.

### 13. Tự khởi động trên Windows

Sau khi pair thành công, mở PowerShell và chạy:

```powershell
powershell -ExecutionPolicy Bypass -File .\agent\install_windows.ps1
```

Script tạo Scheduled Task chạy agent lúc người dùng logon và cấu hình restart khi task lỗi.

Để test ngay trước khi chờ lần logon tiếp theo:

```powershell
python .\agent\agent.py run
```

### 14. Dùng với Tailscale

Tailscale trong repo chỉ đóng vai trò **private network overlay**.

Khi Tailscale đã đăng nhập trên máy LAN, agent sẽ thử:

```bash
tailscale ip -4
```

và gửi IP đó lên dashboard.

Nếu muốn một máy khác truy cập proxy qua Tailscale, chính proxy application trên máy LAN phải listen trên interface/địa chỉ phù hợp và firewall phải cho phép kết nối từ tailnet. Repo này không tự động thay đổi firewall hoặc expose proxy port.

Không nên publish trực tiếp `7890`, `7891`, `1080`... ra Internet nếu không có lớp authentication và policy phù hợp.

### 15. Reset / pair lại từ đầu

Xóa credential cục bộ:

```bash
python agent/agent.py reset --yes
```

Sau đó:

1. Remove agent cũ trên dashboard nếu nó còn tồn tại.
2. Generate pairing key mới.
3. Chạy lại `pair`.
4. Chạy `run`.

Nếu backend trả HTTP `401`, agent sẽ báo rõ credential không còn hợp lệ và yêu cầu pair lại thay vì retry vô hạn như một lỗi mạng thông thường.

### 16. Xử lý sự cố

#### Dashboard báo OFFLINE

Kiểm tra agent có đang chạy không:

```bash
python agent/agent.py run
```

Kiểm tra Internet outbound, DNS, thời gian hệ thống và endpoint trong `api_base`.

#### Pairing key không dùng được

Các nguyên nhân thường gặp:

- key đã quá 10 phút;
- key đã được dùng;
- bạn vừa Generate một key khác, làm key cũ chưa dùng bị vô hiệu hóa;
- copy thừa ký tự.

Generate key mới và pair lại.

#### Scan không tìm thấy proxy

Kiểm tra:

- proxy thật có đang chạy không;
- proxy có listen trên IP LAN hay chỉ `127.0.0.1`;
- port có nằm trong `ports` không;
- Windows Firewall/Linux firewall có chặn không;
- `scan_cidr` có đúng subnet không;
- máy có nhiều NIC và cần `lan_ip_override` hay không.

Nếu proxy chỉ listen trên `127.0.0.1`, agent sẽ không coi loopback là target LAN. Hãy cấu hình proxy application theo đúng mục tiêu mạng của bạn thay vì mở rộng scanner sang loopback/public network.

#### Tailscale IP trống

Kiểm tra:

```bash
tailscale status
tailscale ip -4
```

Nếu lệnh không tồn tại hoặc Tailscale chưa đăng nhập, dashboard sẽ để trống trường này.

#### Command không chạy

Command dùng cơ chế lease/retry. Nếu agent nhận command rồi crash trước khi báo kết quả, backend sẽ phát lại command sau khi lease hết hạn, tối đa 3 lần trước khi đánh dấu failed. Vì vậy một lần mất mạng không còn làm command kẹt `acknowledged` vĩnh viễn.

#### Agent báo credential bị từ chối

Có thể agent đã bị Remove, token không còn hợp lệ hoặc config bị thay. Reset và pair lại:

```bash
python agent/agent.py reset --yes
python agent/agent.py pair --key NEW_KEY --name PC-HUY-01
```

### 17. Phát triển bằng Codespaces/local

Mở Codespace từ chính repo này, sau đó:

```bash
npm run check
npm run dev
```

`npm run check` chạy:

- syntax check cho `app.js`;
- compile check cho `agent.py`;
- unit tests cho các safety/regression case chính.

GitHub Actions cũng chạy cùng check trên push và pull request.

Một lần nữa: Codespaces phù hợp để sửa/test code và preview dashboard, **không phải nơi chạy LAN discovery cho mạng vật lý của bạn**.

### 18. Supabase, Vercel, Railway và Cloudflare trong kiến trúc hiện tại

**Supabase** là backend chính: Auth, PostgreSQL, RLS, Realtime, pairing registry và Edge Function của agent.

**Vercel** host dashboard và `/api/health`.

**Railway** hiện không nằm trên critical path và không cần để LAN Agent hoạt động. Nếu sau này thêm relay/worker dài hạn thì mới nên cân nhắc Railway.

**Cloudflare** hiện không bắt buộc trong runtime. Có thể bổ sung DNS/WAF/custom-domain layer sau nếu cần, nhưng không nên dùng Cloudflare/Tunnel để biến các local proxy port thành open proxy công khai.

**Tailscale** là lựa chọn phù hợp nếu cần private access tới endpoint từ xa mà không expose port ra Internet.

### 19. Nguyên tắc an toàn của repo

- Không remote shell.
- Không arbitrary command execution.
- Không scan public IP.
- Không scan network lớn hơn `/24`.
- Agent chỉ kết nối outbound tới backend.
- Pairing key dùng một lần và TTL ngắn.
- Server lưu hash của agent token.
- Browser chỉ dùng publishable key + RLS.
- Credential table không được cấp Data API access cho `anon/authenticated`.
- Các command có retry giới hạn để tránh loop vô hạn.
