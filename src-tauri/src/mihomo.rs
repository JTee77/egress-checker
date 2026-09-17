//! Clash Verge Rev / Mihomo controller discovery + HTTP (TCP / Unix socket).
//! Secrets are returned to the frontend for local API use only; never log secret values.

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

pub const VERGE_REL_CONFIG: &str =
    "Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml";
pub const DEFAULT_SOCK: &str = "/tmp/verge/verge-mihomo.sock";
pub const DEFAULT_PORT: u16 = 9097;
pub const DEFAULT_MIXED: u16 = 7897;

/// Cap /proxies (and similar) IPC bodies so huge delay-history payloads cannot kill the webview.
pub const MAX_BODY_BYTES: usize = 6 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResult {
    pub host: String,
    pub port: u16,
    pub secret: String,
    pub mixed_port: u16,
    pub source: String,
    pub sock_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnixHttpResult {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlimNode {
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListNodesResult {
    pub nodes: Vec<SlimNode>,
    pub current_proxy: Option<String>,
    pub status: u16,
    pub error: Option<String>,
    pub unauthorized: bool,
    /// Which transport produced this result: "tcp" | "unix"
    pub transport: Option<String>,
}

const IGNORE_PROXY_TYPES: &[&str] = &[
    "Selector",
    "URLTest",
    "Fallback",
    "LoadBalance",
    "Relay",
    "Direct",
    "Reject",
    "Compatible",
    "Pass",
];

const JUNK_NAME_KEYWORDS: &[&str] = &["剩余", "到期", "官网"];

pub fn verge_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(VERGE_REL_CONFIG)
}

pub fn read_verge_config() -> Result<String, String> {
    let path = verge_config_path();
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))
}

fn parse_config(content: &str) -> (u16, String, u16) {
    let mut port = DEFAULT_PORT;
    let mut secret = String::new();
    let mut mixed = DEFAULT_MIXED;

    if let Ok(re) = Regex::new(r#"external-controller:\s*['"]?([^:'"\s]+):(\d+)['"]?"#) {
        if let Some(c) = re.captures(content) {
            if let Ok(p) = c[2].parse() {
                port = p;
            }
        }
    }
    if let Ok(re) = Regex::new(r#"(?m)^secret:\s*['"]?([^\s'"]+)['"]?"#) {
        if let Some(c) = re.captures(content) {
            secret = c[1].to_string();
        }
    }
    if let Ok(re) = Regex::new(r"mixed-port:\s*(\d+)") {
        if let Some(c) = re.captures(content) {
            if let Ok(p) = c[1].parse() {
                mixed = p;
            }
        }
    }
    (port, secret, mixed)
}

pub fn discover_controller() -> DiscoverResult {
    let path = verge_config_path();
    let sock_exists = std::path::Path::new(DEFAULT_SOCK).exists();
    let sock_path = if sock_exists {
        Some(DEFAULT_SOCK.to_string())
    } else {
        None
    };

    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            let (port, secret, mixed) = parse_config(&content);
            return DiscoverResult {
                host: "127.0.0.1".into(),
                port,
                secret,
                mixed_port: mixed,
                source: format!("verge-config:{}", path.display()),
                sock_path,
            };
        }
    }

    DiscoverResult {
        host: "127.0.0.1".into(),
        port: DEFAULT_PORT,
        secret: String::new(),
        mixed_port: DEFAULT_MIXED,
        source: if sock_exists {
            "defaults+unix-socket".into()
        } else {
            "defaults".into()
        },
        sock_path,
    }
}

async fn read_body_capped(res: reqwest::Response) -> Result<(u16, String), String> {
    let status = res.status().as_u16();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!(
            "response body too large ({} bytes > {} max) — refusing to ship to webview",
            bytes.len(),
            MAX_BODY_BYTES
        ));
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Ok((status, body))
}

/// Async HTTP to Mihomo controller over TCP (preferred path from Tauri commands).
pub async fn http_via_tcp_async(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    secret: &str,
    timeout_ms: u64,
) -> Result<UnixHttpResult, String> {
    let url = format!("http://{host}:{port}{path}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .no_proxy()
        .build()
        .map_err(|e| format!("client: {e}"))?;

    let mut builder = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "PUT" => client.put(&url),
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        other => return Err(format!("unsupported method: {other}")),
    };

    builder = builder.header("Content-Type", "application/json");
    if !secret.is_empty() {
        builder = builder.header("Authorization", format!("Bearer {secret}"));
    }
    if let Some(b) = body {
        builder = builder.body(b.to_string());
    }

    let res = builder.send().await.map_err(|e| format!("request: {e}"))?;
    let (status, body) = read_body_capped(res).await?;
    Ok(UnixHttpResult { status, body })
}

pub fn http_via_unix(
    method: &str,
    path: &str,
    body: Option<&str>,
    secret: &str,
    sock_path: Option<&str>,
    timeout_ms: u64,
) -> Result<UnixHttpResult, String> {
    let sock = sock_path.unwrap_or(DEFAULT_SOCK);
    if !std::path::Path::new(sock).exists() {
        return Err(format!("unix socket not found: {sock}"));
    }

    let timeout = Duration::from_millis(timeout_ms);
    let mut stream = UnixStream::connect(sock).map_err(|e| format!("connect {sock}: {e}"))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let body_bytes = body.unwrap_or("").as_bytes();
    let auth = if secret.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {secret}\r\n")
    };

    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    );

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write headers: {e}"))?;
    if !body_bytes.is_empty() {
        stream
            .write_all(body_bytes)
            .map_err(|e| format!("write body: {e}"))?;
    }

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("read: {e}"))?;

    if raw.len() > MAX_BODY_BYTES {
        return Err(format!(
            "unix response too large ({} bytes > {} max)",
            raw.len(),
            MAX_BODY_BYTES
        ));
    }

    let text = String::from_utf8_lossy(&raw);
    let (header, body_part) = text
        .split_once("\r\n\r\n")
        .or_else(|| text.split_once("\n\n"))
        .unwrap_or((text.as_ref(), ""));

    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    let body_out = if header.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        decode_chunked(body_part)
    } else {
        body_part.to_string()
    };

    Ok(UnixHttpResult {
        status,
        body: body_out,
    })
}

fn decode_chunked(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while !rest.is_empty() {
        let Some((size_line, after)) = rest.split_once('\n') else {
            out.push_str(rest);
            break;
        };
        let size_hex = size_line.trim().trim_end_matches('\r');
        let size = usize::from_str_radix(size_hex, 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        let chars: Vec<char> = after.chars().collect();
        if chars.len() < size {
            out.extend(chars.iter());
            break;
        }
        out.extend(chars.iter().take(size));
        let mut idx = size;
        if idx < chars.len() && chars[idx] == '\r' {
            idx += 1;
        }
        if idx < chars.len() && chars[idx] == '\n' {
            idx += 1;
        }
        rest = after
            .char_indices()
            .nth(idx)
            .map(|(i, _)| &after[i..])
            .unwrap_or("");
    }
    out
}

/// Async fetch a URL optionally via local mixed-port HTTP proxy.
pub async fn proxy_fetch_async(
    url: &str,
    mixed_port: Option<u16>,
    user_agent: Option<&str>,
    timeout_ms: u64,
) -> Result<UnixHttpResult, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(10))
        .danger_accept_invalid_certs(false);

    if let Some(port) = mixed_port {
        let proxy_url = format!("http://127.0.0.1:{port}");
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("proxy: {e}"))?;
        builder = builder.proxy(proxy);
    } else {
        builder = builder.no_proxy();
    }

    let client = builder.build().map_err(|e| format!("client: {e}"))?;
    let mut req = client.get(url);
    if let Some(ua) = user_agent {
        req = req.header("User-Agent", ua);
    }
    let res = req.send().await.map_err(|e| format!("request: {e}"))?;
    let (status, body) = read_body_capped(res).await?;
    Ok(UnixHttpResult { status, body })
}

fn is_junk_name(name: &str) -> bool {
    if name.starts_with("PASS") || name.starts_with("REJECT") {
        return true;
    }
    JUNK_NAME_KEYWORDS.iter().any(|k| name.contains(k))
}

fn ignore_type(t: &str) -> bool {
    IGNORE_PROXY_TYPES.iter().any(|x| *x == t)
}

/// Parse /proxies JSON into a slim node list (no history arrays).
pub fn slim_nodes_from_proxies_json(body: &str) -> Result<ListNodesResult, String> {
    let root: Value = serde_json::from_str(body).map_err(|e| format!("json: {e}"))?;
    let proxies = root
        .get("proxies")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "missing proxies object".to_string())?;

    let current_proxy = ["Proxy", "GLOBAL", "proxy"]
        .iter()
        .find_map(|g| {
            proxies
                .get(*g)
                .and_then(|p| p.get("now"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
        });

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
        nodes.push(SlimNode {
            name: name.clone(),
            node_type,
        });
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
                Some(SlimNode { name, node_type })
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
            let mut slim = slim_nodes_from_proxies_json(&res.body)?;
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
        Ok(_) | Err(_) => {
            // Fall through to unix: connect failure or non-2xx (except 401/403 above).
        }
    }

    let sock = sock_path
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT_SOCK.to_string());
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
            let mut slim = slim_nodes_from_proxies_json(&res.body)?;
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
    fn smoke_http_via_tcp_invalid_port_no_panic() {
        let result = std::panic::catch_unwind(|| {
            tauri::async_runtime::block_on(http_via_tcp_async(
                "127.0.0.1",
                1,
                "GET",
                "/",
                None,
                "",
                500,
            ))
        });
        assert!(result.is_ok(), "http_via_tcp_async panicked");
        let inner = result.unwrap();
        assert!(inner.is_err(), "expected Err to closed port, got {inner:?}");
    }

    #[test]
    fn smoke_proxy_fetch_invalid_port_no_panic() {
        let result = std::panic::catch_unwind(|| {
            tauri::async_runtime::block_on(proxy_fetch_async(
                "https://www.gstatic.com/generate_204",
                Some(1),
                None,
                800,
            ))
        });
        assert!(result.is_ok(), "proxy_fetch_async panicked");
        let inner = result.unwrap();
        assert!(inner.is_err(), "expected Err via dead proxy, got {inner:?}");
    }

    #[test]
    fn smoke_proxy_fetch_no_proxy_client_builds() {
        // Ensures Client::builder + no_proxy path does not panic.
        // May Err on network (sandbox / offline) — that is fine; must not panic.
        let result = std::panic::catch_unwind(|| {
            tauri::async_runtime::block_on(proxy_fetch_async(
                "https://www.gstatic.com/generate_204",
                None,
                None,
                3000,
            ))
        });
        assert!(result.is_ok(), "proxy_fetch_async (no_proxy) panicked");
        // Ok or Err both acceptable; panic is not.
        let _ = result.unwrap();
    }

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
}
