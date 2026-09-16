# Egress Checker — Product One-Pager (v1)

## Positioning
**Egress Checker** is a macOS desktop app that diagnoses the *quality* of your proxy egress — not whether you can merely open a foreign site.

One-line pitch: **Check whether your proxy leaks DNS, unlocks the services you care about, and is actually fast.**

It does **not** provide any proxy nodes or VPN service. Users bring their own Mihomo / Clash Meta compatible client (e.g. Clash Verge Rev).

## Audience
- People already using Clash Verge Rev / FlClash / Clash Party / similar Mihomo GUIs on Mac
- Want deeper checks than “can open Google”
- Zero / low technical background OK for using the app; advanced users can still use node speed tables

## Platform (v1)
- **macOS only, Apple Silicon (arm64) only** — no Intel Mac builds in v1
- Windows later
- No iOS / Android in v1
- Distribute via GitHub Releases (Apple Silicon `.dmg` / zip). App Store not required for v1.

## Architecture
Two layers:

1. **Universal egress diagnostics** — test the *current* system exit (works whenever a Mihomo client is connected / system proxy or TUN is on).
2. **Mihomo adapter** — talk to local Clash-compatible REST API (`external-controller` + `secret`, or known Unix socket paths such as Verge’s) for node list, delay, switch, deep speed.

Product copy should say: **“Mihomo / Clash Meta compatible clients”**, with Clash Verge Rev as the default tested target. Same adapter aims to cover FlClash, Clash Party, Clash Nyanpasu, etc., via auto-discovery of controller port/secret.

## Explicit non-goals (v1)
- Shadowrocket / Surge / Quantumult / closed commercial VPNs
- Providing or selling nodes / subscriptions
- Account system, cloud sync, telemetry that identifies users
- Fake “full node sweep” for clients without an open API
- Auto-fixing GFW or claiming to “break firewalls”

## v1 Feature list

### A. Home — One-click health check
Single primary button: **Run check**.

Summary cards (pass / warn / fail):
- Reachability (basic foreign HTTPS)
- DNS leak (resolvers geography / ISP vs exit)
- WebRTC leak (local / public IP exposure)
- Exit IP + org + country + hosting vs residential hint
- Gemini unlock status
- ChatGPT unlock status (web / app / blocked as available)
- Current latency / optional light bandwidth sample

### B. Details panels
Expand each card for raw evidence (resolver IPs, IP org, status strings, timestamps). Link-style “how to fix” tips (e.g. set Wi-Fi DNS to 1.1.1.1/8.8.8.8 through tunnel — educational, not auto-mutating network settings without clear user action).

### C. Nodes (Mihomo connected)
When API reachable:
- List nodes (filter junk names: 剩余/到期/官网, ignore Selector/URLTest/etc. meta types)
- Region grouping (reuse rules from reference `clash_speedtest.py`)
- Modes (port from existing tool):
  - Quick latency / jitter / loss (low traffic)
  - Top-N real download + TTFB + AI/IP probes
  - Full deep test (warn about traffic)
  - AI/IP-only batch
  - Region-scoped test
- Results table + recommendation
- Switch active node via API; restore previous node after batch probes when appropriate

### D. Connection settings
- Auto-detect Mihomo API (common ports, Verge config path, unix socket)
- Manual override: host, port, secret
- Show connection status: connected client hint / API OK / secret wrong

### E. About / disclaimer
- No nodes provided
- Open source license (MIT recommended unless user chooses otherwise)
- Traffic warning for deep tests

## UI sketch (macOS native feel)
- Left sidebar: Home | Nodes | Settings | About
- Home: big status hero + Run check + card grid
- Nodes: toolbar (mode select, Start) + table + bottom recommendation bar
- Dark/light follows system
- Language: **Simplified Chinese UI first** (product name stays English). Optional English later.

## Technical direction (for implementers)
- Prefer **Tauri 2 + TypeScript/React (or Solid)** for a small native Mac app; alternative Electron if Tauri friction is high.
- Port diagnostic logic from reference Python `clash_speedtest.py` into TypeScript (or keep a local Python sidecar only if needed — prefer single binary UX).
- Do not ship user secrets; read Clash Verge config from standard macOS Application Support path when present.
- GitHub repo name: `egress-checker`
- README: install, enable external controller, screenshots, disclaimer

## Success criteria for v1 ship
1. On a Mac with Clash Verge Rev running and API reachable, one-click check produces DNS / IP / Gemini / ChatGPT results without Terminal.
2. Node quick test + switch works against Verge.
3. GitHub Release has a downloadable Mac build and clear README.
4. App never claims to supply VPN service.

## Reference seed
Existing engine: user Mac `~/.local/share/clash_speedtest.py` (also attached as `reference/clash_speedtest.py`). Desktop launcher `~/Desktop/Clash节点测速.command` only invokes that engine.
