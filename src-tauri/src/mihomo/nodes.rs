//! `/proxies` handling: slim the controller's proxy JSON down to real leaf
//! nodes (dropping selector/urltest groups, junk names; keeping only the
//! client's last delay result instead of full history arrays) and the
//! TCP→Unix fallback that fetches it for the node list.

use serde_json::Value;

use super::transport::{http_via_tcp_async, http_via_unix};
use super::types::{ListNodesResult, SlimNode, IGNORE_PROXY_TYPES, JUNK_NAME_KEYWORDS};

fn is_junk_name(name: &str) -> bool {
    if name.starts_with("PASS") || name.starts_with("REJECT") {
        return true;
    }
    JUNK_NAME_KEYWORDS.iter().any(|k| name.contains(k))
}

fn ignore_type(t: &str) -> bool {
    IGNORE_PROXY_TYPES.iter().any(|x| *x == t)
}

/// A per-node capability flag from a proxy object; absent → false.
fn read_bool(p: &Value, key: &str) -> bool {
    p.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Client-side health from a proxy object: `alive` flag (None when absent).
fn read_alive(p: &Value) -> Option<bool> {
    p.get("alive").and_then(|v| v.as_bool())
}

/// Client's most recent delay-test result: last `history` entry's delay (ms),
/// 0 = that test failed. Returns (delay, time) — time is the ISO-8601 stamp
/// of that test, needed to tell "failed just now" from "failed hours ago".
fn read_last_delay(p: &Value) -> (Option<u32>, Option<String>) {
    let Some(last) = p.get("history").and_then(|v| v.as_array()).and_then(|a| a.last())
    else {
        return (None, None);
    };
    let delay = last.get("delay").and_then(|d| d.as_u64());
    let time = last
        .get("time")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let delay = delay.map(|d| u32::try_from(d).unwrap_or(u32::MAX));
    (delay, time)
}

/// Build a slim node from a proxy object, reading the full six-flag mihomo
/// capability vocabulary in one place. Adding a future flag only means touching
/// this function + the `SlimNode` struct — no call-site churn.
fn slim_node(name: String, node_type: String, p: &Value) -> SlimNode {
    let (last_delay, last_delay_at) = read_last_delay(p);
    SlimNode {
        name,
        node_type,
        udp: read_bool(p, "udp"),
        xudp: read_bool(p, "xudp"),
        uot: read_bool(p, "uot"),
        tfo: read_bool(p, "tfo"),
        smux: read_bool(p, "smux"),
        mptcp: read_bool(p, "mptcp"),
        alive: read_alive(p),
        last_delay,
        last_delay_at,
    }
}

/// Group types that route to a member via their `now` field.
const GROUP_TYPES: &[&str] = &["Selector", "URLTest", "Fallback", "LoadBalance"];

/// User-facing selector groups, most authoritative first. `GLOBAL` is the
/// global-mode pseudo-group and often sits at `DIRECT` while the client is in
/// rule mode, so it must not be trusted blindly — hence the ordered scan below
/// that only accepts a group whose `now` resolves to a real leaf node.
const PREFER_GROUP_NAMES: &[&str] = &[
    "Proxy",
    "GLOBAL",
    "proxy",
    "SELECT",
    "节点选择",
    "手动选择",
    "自动选择",
];

/// A name is a real leaf proxy iff it exists, is not a group/pseudo type
/// (Direct/Reject/Pass/Selector… — i.e. not DIRECT), and is not a junk entry.
fn is_real_leaf(proxies: &serde_json::Map<String, Value>, name: &str) -> bool {
    let Some(p) = proxies.get(name) else {
        return false;
    };
    let t = p.get("type").and_then(|x| x.as_str()).unwrap_or("");
    if ignore_type(t) {
        return false;
    }
    !is_junk_name(name)
}

/// If group `g` exists and its `now` points at a real leaf node, return it.
fn group_now_leaf(proxies: &serde_json::Map<String, Value>, g: &str) -> Option<String> {
    let now = proxies.get(g)?.get("now").and_then(|n| n.as_str())?;
    if is_real_leaf(proxies, now) {
        Some(now.to_string())
    } else {
        None
    }
}

/// Resolve the node the user is actually on. Never surfaces DIRECT/PASS/REJECT
/// or a group name. Falls back to a single unambiguous selector group; returns
/// None when several groups disagree (rule mode) so the UI shows "—" honestly.
pub fn resolve_current_proxy(proxies: &serde_json::Map<String, Value>) -> Option<String> {
    for g in PREFER_GROUP_NAMES {
        if let Some(n) = group_now_leaf(proxies, g) {
            return Some(n);
        }
    }
    let mut distinct: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (_name, p) in proxies {
        let t = p.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if !GROUP_TYPES.contains(&t) {
            continue;
        }
        if let Some(now) = p.get("now").and_then(|x| x.as_str()) {
            if is_real_leaf(proxies, now) {
                distinct.insert(now.to_string());
            }
        }
    }
    if distinct.len() == 1 {
        distinct.into_iter().next()
    } else {
        None
    }
}

/// Parse /proxies JSON into a slim node list (no history arrays; only the
/// last delay result + alive flag are kept).
pub fn slim_nodes_from_proxies_json(body: &str) -> Result<ListNodesResult, String> {
    let root: Value = serde_json::from_str(body).map_err(|e| format!("json: {e}"))?;
    let proxies = root
        .get("proxies")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "missing proxies object".to_string())?;

    let current_proxy = resolve_current_proxy(proxies);

    let mut nodes: Vec<SlimNode> = Vec::new();
    for (name, p) in proxies {
        let node_type = p
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        if ignore_type(&node_type) || is_junk_name(name) {
            continue;
        }
        nodes.push(slim_node(name.clone(), node_type, p));
    }

    if nodes.is_empty() {
        // Resolve leaf names from Selector / URLTest / Fallback `all` arrays.
        let mut leaf_names = std::collections::BTreeSet::new();
        let consider_all = |all: Option<&Value>, set: &mut std::collections::BTreeSet<String>| {
            let Some(arr) = all.and_then(|v| v.as_array()) else {
                return;
            };
            for item in arr {
                let Some(name) = item.as_str() else { continue };
                let Some(p) = proxies.get(name) else { continue };
                let t = p.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if ignore_type(t) || is_junk_name(name) {
                    continue;
                }
                set.insert(name.to_string());
            }
        };

        for g in ["Proxy", "GLOBAL", "proxy"] {
            if let Some(p) = proxies.get(g) {
                consider_all(p.get("all"), &mut leaf_names);
            }
        }
        for (_name, p) in proxies {
            let t = p.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if matches!(t, "Selector" | "URLTest" | "Fallback") {
                consider_all(p.get("all"), &mut leaf_names);
            }
        }

        nodes = leaf_names
            .into_iter()
            .filter_map(|name| {
                let p = proxies.get(&name)?;
                let node_type = p
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(slim_node(name, node_type, p))
            })
            .collect();
    }

    Ok(ListNodesResult {
        nodes,
        current_proxy,
        status: 200,
        error: None,
        unauthorized: false,
        transport: None,
    })
}

/// Fetch /proxies: try TCP briefly, then Unix socket fallback.
/// Prefer unix when TCP is dead (Clash Verge Rev often exposes only the sock).
pub async fn list_nodes_async(
    host: &str,
    port: u16,
    secret: &str,
    timeout_ms: u64,
    sock_path: Option<&str>,
) -> Result<ListNodesResult, String> {
    let tcp_timeout = timeout_ms.min(2000).max(400);
    let tcp_attempt =
        http_via_tcp_async(host, port, "GET", "/proxies", None, secret, tcp_timeout).await;

    match tcp_attempt {
        Ok(res) if res.status == 401 || res.status == 403 => {
            return Ok(ListNodesResult {
                nodes: vec![],
                current_proxy: None,
                status: res.status,
                error: Some("API 返回未授权（401/403），请到设置检查 Secret".into()),
                unauthorized: true,
                transport: Some("tcp".into()),
            });
        }
        Ok(res) if (200..300).contains(&res.status) => {
            match slim_nodes_from_proxies_json(&res.body) {
                Ok(mut slim) => {
                    slim.status = res.status;
                    slim.transport = Some("tcp".into());
                    if slim.nodes.is_empty() {
                        slim.error = Some(
                            "已连接但未解析到可用节点，请到设置检查 Secret / 刷新，或确认订阅已加载"
                                .into(),
                        );
                    }
                    return Ok(slim);
                }
                Err(e) => {
                    return Ok(ListNodesResult {
                        nodes: vec![],
                        current_proxy: None,
                        status: res.status,
                        error: Some(format!(
                            "解析 /proxies JSON 失败（TCP）: {e}；body {} 字节",
                            res.body.len()
                        )),
                        unauthorized: false,
                        transport: Some("tcp".into()),
                    });
                }
            }
        }
        Ok(_) | Err(_) => {
            // Fall through to unix: connect failure or non-2xx (except 401/403 above).
        }
    }

    let Some(sock) = sock_path.map(|s| s.to_string()).filter(|s| !s.is_empty()) else {
        return Err(format!(
            "TCP {host}:{port} 不可用，且未配置 Unix 套接字（不会回退到 Verge 默认 sock）"
        ));
    };
    let secret_owned = secret.to_string();
    let sock_for_err = sock.clone();
    let unix_timeout = timeout_ms.max(tcp_timeout);

    let unix_attempt = tauri::async_runtime::spawn_blocking(move || {
        http_via_unix(
            "GET",
            "/proxies",
            None,
            &secret_owned,
            Some(sock.as_str()),
            unix_timeout,
        )
    })
    .await
    .map_err(|e| format!("unix task join: {e}"))?;

    match unix_attempt {
        Ok(res) if res.status == 401 || res.status == 403 => Ok(ListNodesResult {
            nodes: vec![],
            current_proxy: None,
            status: res.status,
            error: Some("API 返回未授权（401/403），请到设置检查 Secret".into()),
            unauthorized: true,
            transport: Some("unix".into()),
        }),
        Ok(res) if (200..300).contains(&res.status) => {
            match slim_nodes_from_proxies_json(&res.body) {
                Ok(mut slim) => {
                    slim.status = res.status;
                    slim.transport = Some("unix".into());
                    if slim.nodes.is_empty() {
                        slim.error = Some(
                            "已连接但未解析到可用节点，请到设置检查 Secret / 刷新，或确认订阅已加载"
                                .into(),
                        );
                    }
                    Ok(slim)
                }
                Err(e) => Ok(ListNodesResult {
                    nodes: vec![],
                    current_proxy: None,
                    status: res.status,
                    error: Some(format!(
                        "解析 /proxies JSON 失败（Unix）: {e}；body {} 字节",
                        res.body.len()
                    )),
                    unauthorized: false,
                    transport: Some("unix".into()),
                }),
            }
        }
        Ok(res) => Ok(ListNodesResult {
            nodes: vec![],
            current_proxy: None,
            status: res.status,
            error: Some(format!(
                "TCP 与 Unix（{sock_for_err}）均失败：Unix HTTP {}",
                res.status
            )),
            unauthorized: false,
            transport: Some("unix".into()),
        }),
        Err(e) => Err(format!(
            "TCP {host}:{port} 不可用，Unix {sock_for_err} 也失败：{e}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_spawn_blocking_catch_unwind_maps_panic() {
        let join = tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn_blocking(|| {
                std::panic::catch_unwind(|| {
                    panic!("intentional smoke panic");
                })
                .map_err(|_| "caught panic".to_string())
                .and_then(|()| Ok::<(), String>(()))
            })
            .await
        });
        assert!(join.is_ok());
        let inner = join.unwrap();
        assert!(inner.is_err());
        assert!(inner.unwrap_err().contains("panic"));
    }

    #[test]
    fn slim_nodes_strips_groups_and_history_shape() {
        let body = r#"{
          "proxies": {
            "Proxy": {"type":"Selector","now":"hk-1","all":["hk-1","jp-1"]},
            "hk-1": {"type":"Shadowsocks","history":[{"time":"t","delay":12}]},
            "jp-1": {"type":"Vmess","history":[{"time":"t","delay":99}]},
            "DIRECT": {"type":"Direct"}
          }
        }"#;
        let slim = slim_nodes_from_proxies_json(body).unwrap();
        assert_eq!(slim.current_proxy.as_deref(), Some("hk-1"));
        let names: Vec<_> = slim.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hk-1"));
        assert!(names.contains(&"jp-1"));
        assert!(!names.iter().any(|n| *n == "Proxy" || *n == "DIRECT"));
    }

    #[test]
    fn slim_nodes_keeps_client_health() {
        // alive + last delay survive slimming: dead (delay 0), alive, and
        // never-tested (no history at all) must be distinguishable, and the
        // failure time must come through for freshness checks.
        let body = r#"{
          "proxies": {
            "Proxy": {"type":"Selector","now":"dead","all":["dead","ok","fresh"]},
            "dead": {"type":"Shadowsocks","alive":false,"history":[{"time":"t","delay":120},{"time":"t2","delay":0}]},
            "ok": {"type":"Vmess","alive":true,"history":[{"time":"t","delay":88}]},
            "fresh": {"type":"Trojan"}
          }
        }"#;
        let slim = slim_nodes_from_proxies_json(body).unwrap();
        let get = |n: &str| slim.nodes.iter().find(|x| x.name == n).unwrap();
        let dead = get("dead");
        assert_eq!(dead.alive, Some(false));
        assert_eq!(dead.last_delay, Some(0));
        assert_eq!(dead.last_delay_at.as_deref(), Some("t2"));
        let ok = get("ok");
        assert_eq!(ok.alive, Some(true));
        assert_eq!(ok.last_delay, Some(88));
        assert_eq!(ok.last_delay_at.as_deref(), Some("t"));
        let fresh = get("fresh");
        assert_eq!(fresh.alive, None);
        assert_eq!(fresh.last_delay, None);
        assert_eq!(fresh.last_delay_at, None);
    }

    #[test]
    fn slim_nodes_reads_all_six_capability_flags() {
        // A node with no flags (udp must NOT be assumed true), and a node with
        // the full set lit — proves each flag is read independently.
        let body = r#"{
          "proxies": {
            "Proxy": {"type":"Selector","now":"plain","all":["plain","rich"]},
            "plain": {"type":"Shadowsocks"},
            "rich": {"type":"Vless","udp":true,"xudp":true,"uot":true,"tfo":true,"smux":true,"mptcp":true}
          }
        }"#;
        let slim = slim_nodes_from_proxies_json(body).unwrap();
        let get = |n: &str| slim.nodes.iter().find(|x| x.name == n).unwrap();
        let p = get("plain");
        assert!(!p.udp && !p.xudp && !p.uot && !p.tfo && !p.smux && !p.mptcp);
        let r = get("rich");
        assert!(r.udp && r.xudp && r.uot && r.tfo && r.smux && r.mptcp);
    }

    #[test]
    fn slim_nodes_partial_flags_independent() {
        // Mirrors the real-world concern: some nodes have udp, some don't; a
        // node can have udp but lack xudp, etc. Flags must not cross-contaminate.
        let body = r#"{
          "proxies": {
            "Proxy": {"type":"Selector","now":"a","all":["a","b"]},
            "a": {"type":"Hysteria2","udp":true},
            "b": {"type":"Trojan","uot":true}
          }
        }"#;
        let slim = slim_nodes_from_proxies_json(body).unwrap();
        let a = slim.nodes.iter().find(|x| x.name == "a").unwrap();
        let b = slim.nodes.iter().find(|x| x.name == "b").unwrap();
        assert!(a.udp && !a.xudp && !a.uot);
        assert!(!b.udp && b.uot);
    }

    #[test]
    fn current_proxy_rule_mode_skips_direct_global_picks_节点选择() {
        // Clash Verge in rule mode: GLOBAL pseudo-group sits at DIRECT while the
        // user's real pick lives in the "节点选择" group. Must show HK17, not DIRECT.
        let body = r#"{
          "proxies": {
            "GLOBAL": {"type":"Selector","now":"DIRECT","all":["DIRECT","HK17"]},
            "节点选择": {"type":"Selector","now":"HK17","all":["HK17","SG2"]},
            "NETFLIX": {"type":"Selector","now":"SG2","all":["HK17","SG2"]},
            "HK17": {"type":"Hysteria2"},
            "SG2": {"type":"Vmess"},
            "DIRECT": {"type":"Direct"},
            "REJECT": {"type":"Reject"}
          }
        }"#;
        let slim = slim_nodes_from_proxies_json(body).unwrap();
        assert_eq!(slim.current_proxy.as_deref(), Some("HK17"));
    }

    #[test]
    fn current_proxy_global_mode_uses_global_real_leaf() {
        let body = r#"{
          "proxies": {
            "GLOBAL": {"type":"Selector","now":"jp-2","all":["jp-2","hk-1"]},
            "节点选择": {"type":"Selector","now":"hk-1","all":["jp-2","hk-1"]},
            "jp-2": {"type":"Shadowsocks"},
            "hk-1": {"type":"Vmess"},
            "DIRECT": {"type":"Direct"}
          }
        }"#;
        let slim = slim_nodes_from_proxies_json(body).unwrap();
        // Proxy absent, GLOBAL present with a real leaf → GLOBAL wins first.
        assert_eq!(slim.current_proxy.as_deref(), Some("jp-2"));
    }

    #[test]
    fn current_proxy_ambiguous_rule_groups_returns_none() {
        // No preferred group name matches and several sub-groups disagree →
        // honest None (UI shows "—") rather than guessing a random group.
        let body = r#"{
          "proxies": {
            "人工智能": {"type":"Selector","now":"us-1","all":["us-1"]},
            "NETFLIX": {"type":"Selector","now":"sg-9","all":["sg-9"]},
            "us-1": {"type":"Vmess"},
            "sg-9": {"type":"Trojan"},
            "DIRECT": {"type":"Direct"}
          }
        }"#;
        let slim = slim_nodes_from_proxies_json(body).unwrap();
        assert_eq!(slim.current_proxy, None);
    }

    #[test]
    fn current_proxy_pure_direct_mode_returns_none() {
        let body = r#"{
          "proxies": {
            "GLOBAL": {"type":"Selector","now":"DIRECT","all":["DIRECT"]},
            "DIRECT": {"type":"Direct"}
          }
        }"#;
        let slim = slim_nodes_from_proxies_json(body).unwrap();
        assert_eq!(slim.current_proxy, None);
    }

    #[test]
    fn smoke_list_nodes_dead_tcp_missing_sock_no_panic() {
        let missing = "/tmp/egress-checker-no-such-mihomo.sock";
        let _ = std::fs::remove_file(missing);
        let result = std::panic::catch_unwind(|| {
            tauri::async_runtime::block_on(list_nodes_async(
                "127.0.0.1",
                1,
                "",
                800,
                Some(missing),
            ))
        });
        assert!(result.is_ok(), "list_nodes_async panicked");
        let inner = result.unwrap();
        assert!(
            inner.is_err(),
            "expected Err when TCP dead and sock missing, got {inner:?}"
        );
    }

    /// TCP dead + live Unix sock → leaf nodes > 0, transport unix, no app demo names.
    #[test]
    fn smoke_list_nodes_dead_tcp_live_sock_real_leaves() {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        let sock = format!(
            "/tmp/egress-checker-list-nodes-smoke-{}.sock",
            std::process::id()
        );
        let _ = std::fs::remove_file(&sock);

        let body = concat!(
            r#"{"proxies":{"Proxy":{"type":"Selector","now":"香港 HK-2-AT","all":["香港 HK-2-AT","日本 TY-4-HY2"]},"GLOBAL":{"type":"Selector","now":"香港 HK-2-AT","all":["香港 HK-2-AT","日本 TY-4-HY2"]},"香港 HK-2-AT":{"type":"Hysteria2","history":[{"time":"t","delay":40}]},"日本 TY-4-HY2":{"type":"Hysteria2","history":[{"time":"t","delay":55}]},"DIRECT":{"type":"Direct"}}}"#
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );

        let listener = UnixListener::bind(&sock).expect("bind unix smoke sock");
        let (ready_tx, ready_rx) = mpsc::channel();
        let sock_path = sock.clone();
        let server = thread::spawn(move || {
            ready_tx.send(()).ok();
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(resp.as_bytes());
            }
            let _ = std::fs::remove_file(&sock_path);
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("server ready");

        let result = std::panic::catch_unwind(|| {
            tauri::async_runtime::block_on(list_nodes_async(
                "127.0.0.1",
                1,
                "test-secret",
                2000,
                Some(&sock),
            ))
        });
        let _ = server.join();
        let _ = std::fs::remove_file(&sock);

        assert!(result.is_ok(), "list_nodes_async panicked");
        let inner = result.unwrap().expect("list_nodes should Ok via unix");
        assert_eq!(inner.transport.as_deref(), Some("unix"));
        assert!(
            inner.nodes.len() >= 2,
            "expected real leaves via unix, got {:?}",
            inner.nodes
        );
        let names: Vec<_> = inner.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"香港 HK-2-AT"));
        assert!(names.contains(&"日本 TY-4-HY2"));
        assert!(
            !names.iter().any(|n| n.contains("香港 01 | Hysteria2")
                || n.contains("东京 Premium")
                || n.contains("Singapore IEPL")),
            "demo mock names must not appear: {names:?}"
        );
        
        assert!(!inner.unauthorized);
    }

    /// TCP dead + live Unix sock returning **chunked** body with Chinese names.
    #[test]
    fn smoke_list_nodes_unix_chunked_chinese_names() {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        let sock = format!(
            "/tmp/egress-checker-list-nodes-chunked-{}.sock",
            std::process::id()
        );
        let _ = std::fs::remove_file(&sock);

        let json = concat!(
            r#"{"proxies":{"Proxy":{"type":"Selector","now":"香港 HK-2-AT","all":["香港 HK-2-AT","日本 TY-4-HY2"]},"香港 HK-2-AT":{"type":"Hysteria2"},"日本 TY-4-HY2":{"type":"Hysteria2"},"DIRECT":{"type":"Direct"}}}"#
        );
        let json_b = json.as_bytes();
        // Split inside multi-byte UTF-8 so char-based decode would corrupt.
        let split_at = (0..json_b.len())
            .find(|&i| !json.is_char_boundary(i))
            .expect("fixture must contain multi-byte UTF-8");
        let (a, b) = json_b.split_at(split_at);
        let mut chunked_body = Vec::new();
        chunked_body.extend_from_slice(format!("{:x}\r\n", a.len()).as_bytes());
        chunked_body.extend_from_slice(a);
        chunked_body.extend_from_slice(b"\r\n");
        chunked_body.extend_from_slice(format!("{:x}\r\n", b.len()).as_bytes());
        chunked_body.extend_from_slice(b);
        chunked_body.extend_from_slice(b"\r\n0\r\n\r\n");

        let mut resp = Vec::new();
        resp.extend_from_slice(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
        );
        resp.extend_from_slice(&chunked_body);

        let listener = UnixListener::bind(&sock).expect("bind");
        let (ready_tx, ready_rx) = mpsc::channel();
        let sock_path = sock.clone();
        let server = thread::spawn(move || {
            ready_tx.send(()).ok();
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                assert!(
                    req.to_ascii_lowercase().contains("accept-encoding: identity"),
                    "unix request must ask for identity encoding, got:\n{req}"
                );
                let _ = stream.write_all(&resp);
            }
            let _ = std::fs::remove_file(&sock_path);
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("server ready");

        let result = std::panic::catch_unwind(|| {
            tauri::async_runtime::block_on(list_nodes_async(
                "127.0.0.1",
                1,
                "test-secret",
                2000,
                Some(&sock),
            ))
        });
        let _ = server.join();
        let _ = std::fs::remove_file(&sock);

        assert!(result.is_ok(), "list_nodes_async panicked");
        let inner = result.unwrap().expect("list_nodes should Ok via unix chunked");
        assert_eq!(inner.transport.as_deref(), Some("unix"));
        assert!(
            inner.error.is_none(),
            "expected successful parse, got error {:?}",
            inner.error
        );
        let names: Vec<_> = inner.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"香港 HK-2-AT"), "{names:?}");
        assert!(names.contains(&"日本 TY-4-HY2"), "{names:?}");
    }

    #[test]
    fn slim_parse_fail_returns_ok_with_error_via_list_nodes_unix() {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        let sock = format!(
            "/tmp/egress-checker-list-nodes-badjson-{}.sock",
            std::process::id()
        );
        let _ = std::fs::remove_file(&sock);

        // Valid HTTP but invalid JSON body — should Ok with error, not Err.
        let body = "{not-json";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );

        let listener = UnixListener::bind(&sock).expect("bind");
        let (ready_tx, ready_rx) = mpsc::channel();
        let sock_path = sock.clone();
        let server = thread::spawn(move || {
            ready_tx.send(()).ok();
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(resp.as_bytes());
            }
            let _ = std::fs::remove_file(&sock_path);
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("server ready");

        let result = tauri::async_runtime::block_on(list_nodes_async(
            "127.0.0.1",
            1,
            "",
            2000,
            Some(&sock),
        ));
        let _ = server.join();
        let _ = std::fs::remove_file(&sock);

        let inner = result.expect("should Ok with parse error detail, not Err");
        assert_eq!(inner.status, 200);
        assert!(inner.nodes.is_empty());
        let err = inner.error.expect("error detail");
        assert!(
            err.contains("解析 /proxies JSON 失败"),
            "unexpected error: {err}"
        );
    }
}
