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


pub const PARTY_SOCK: &str = "/tmp/mihomo-party.sock";

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(rest);
    }
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    }
    PathBuf::from(path)
}

/// Parse external-controller / secret / mixed-port from yaml text with given defaults.
pub fn parse_controller_yaml(content: &str, default_port: u16, default_mixed: u16) -> (u16, String, u16) {
    let mut port = default_port;
    let mut secret = String::new();
    let mut mixed = default_mixed;

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

/// Read first readable yaml among `paths`; set sock_path only from sock_candidates that exist.
/// Never injects Verge DEFAULT_SOCK unless that path is explicitly in sock_candidates.
pub fn read_controller_yaml(
    paths: &[String],
    default_port: u16,
    default_mixed: u16,
    sock_candidates: &[String],
    source_prefix: &str,
) -> DiscoverResult {
    let mut sock_path: Option<String> = None;
    for cand in sock_candidates {
        let p = expand_home(cand);
        if p.exists() {
            sock_path = Some(p.to_string_lossy().into_owned());
            break;
        }
    }

    for raw in paths {
        let path = expand_home(raw);
        if !path.exists() {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            let (port, secret, mixed) = parse_controller_yaml(&content, default_port, default_mixed);
            return DiscoverResult {
                host: "127.0.0.1".into(),
                port,
                secret,
                mixed_port: mixed,
                source: format!("{source_prefix}:{}", path.display()),
                sock_path,
            };
        }
    }

    // Also try scanning directories for any *.yaml / *.yml (FlClash / Nyanpasu)
    for raw in paths {
        let path = expand_home(raw);
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                let mut yamls: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| {
                        p.extension()
                            .and_then(|x| x.to_str())
                            .map(|ext| ext == "yaml" || ext == "yml")
                            .unwrap_or(false)
                    })
                    .collect();
                yamls.sort();
                for y in yamls {
                    if let Ok(content) = std::fs::read_to_string(&y) {
                        let (port, secret, mixed) =
                            parse_controller_yaml(&content, default_port, default_mixed);
                        return DiscoverResult {
                            host: "127.0.0.1".into(),
                            port,
                            secret,
                            mixed_port: mixed,
                            source: format!("{source_prefix}:{}", y.display()),
                            sock_path: sock_path.clone(),
                        };
                    }
                }
            }
        }
    }

    DiscoverResult {
        host: "127.0.0.1".into(),
        port: default_port,
        secret: String::new(),
        mixed_port: default_mixed,
        source: format!("{source_prefix}:defaults"),
        sock_path,
    }
}

/// Client-scoped discovery. Non-Verge clients never get Verge DEFAULT_SOCK.
pub fn discover_for_client(client_id: &str) -> DiscoverResult {
    match client_id {
        "verge" => discover_controller(),
        "clashx_meta" => read_controller_yaml(
            &["~/.config/clash/config.yaml".into()],
            9090,
            7890,
            &[], // no fixed public sock
            "clashx_meta",
        ),
        "flclash" => read_controller_yaml(
            &[
                "~/Library/Application Support/com.follow.clash".into(),
                "~/Library/Application Support/FlClash".into(),
            ],
            9090,
            7890,
            &[], // internal IPC is not Mihomo REST — never inject Verge/Party sock
            "flclash",
        ),
        "mihomo_party" => read_controller_yaml(
            &[
                "~/Library/Application Support/mihomo-party".into(),
            ],
            9090, // TCP EC often empty; sock is primary
            7890,
            &[PARTY_SOCK.into()],
            "mihomo_party",
        ),
        "nyanpasu" => read_controller_yaml(
            &[
                "~/Library/Application Support/Clash Nyanpasu/clash-runtime.yaml".into(),
                "~/Library/Application Support/Clash Nyanpasu/clash.yaml".into(),
                "~/Library/Application Support/clash-nyanpasu/clash-runtime.yaml".into(),
                "~/Library/Application Support/clash-nyanpasu/clash.yaml".into(),
                "~/Library/Application Support/Clash Nyanpasu".into(),
                "~/Library/Application Support/clash-nyanpasu".into(),
            ],
            17650, // default EC; debug builds may use 9872
            7890,
            &[],
            "nyanpasu",
        ),
        _ => DiscoverResult {
            host: "127.0.0.1".into(),
            port: 9090,
            secret: String::new(),
            mixed_port: 7890,
            source: format!("unknown-client:{client_id}"),
            sock_path: None,
        },
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
    let sock = sock_path.ok_or_else(|| {
        "unix socket path not provided (refusing Verge default for non-Verge clients)".to_string()
    })?;
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

    // Accept-Encoding: identity — raw UnixStream does not auto-decode gzip like curl.
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{auth}Content-Type: application/json\r\nAccept-Encoding: identity\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

    parse_http_response_bytes(&raw)
}

/// Split HTTP response on bytes (headers/body), decode chunked by byte length, UTF-8 body.
fn parse_http_response_bytes(raw: &[u8]) -> Result<UnixHttpResult, String> {
    let (header_bytes, body_bytes) = split_headers_body(raw).ok_or_else(|| {
        "unix response missing header/body separator".to_string()
    })?;

    let header = String::from_utf8_lossy(header_bytes);
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    let header_lower = header.to_ascii_lowercase();
    if header_lower
        .lines()
        .any(|l| l.trim().starts_with("content-encoding:") && l.contains("gzip"))
    {
        return Err(format!(
            "unix response Content-Encoding: gzip (raw socket cannot decode); \
             request used Accept-Encoding: identity — body {} bytes",
            body_bytes.len()
        ));
    }

    let decoded = if header_lower
        .lines()
        .any(|l| l.trim().starts_with("transfer-encoding:") && l.contains("chunked"))
    {
        decode_chunked_bytes(body_bytes)?
    } else {
        body_bytes.to_vec()
    };

    if decoded.len() > MAX_BODY_BYTES {
        return Err(format!(
            "unix decoded body too large ({} bytes > {} max)",
            decoded.len(),
            MAX_BODY_BYTES
        ));
    }

    let body_out = String::from_utf8(decoded).map_err(|e| {
        format!(
            "unix response body is not valid UTF-8 after decode: {e} (raw {} bytes)",
            body_bytes.len()
        )
    })?;

    Ok(UnixHttpResult {
        status,
        body: body_out,
    })
}

fn split_headers_body(raw: &[u8]) -> Option<(&[u8], &[u8])> {
    if let Some(pos) = find_bytes(raw, b"\r\n\r\n") {
        return Some((&raw[..pos], &raw[pos + 4..]));
    }
    if let Some(pos) = find_bytes(raw, b"\n\n") {
        return Some((&raw[..pos], &raw[pos + 2..]));
    }
    None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// Decode HTTP/1.1 chunked transfer encoding using **byte** lengths (not chars).
/// Multi-byte UTF-8 (e.g. Chinese node names) must not be counted as one unit per char.
pub fn decode_chunked_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        let Some(nl) = rest.iter().position(|&b| b == b'\n') else {
            out.extend_from_slice(rest);
            break;
        };
        let size_line = &rest[..nl];
        let size_hex = trim_ascii_ws_and_cr(size_line);
        // Ignore chunk extensions after `;`
        let size_hex = size_hex
            .split(|&b| b == b';')
            .next()
            .unwrap_or(size_hex);
        let size_str = std::str::from_utf8(size_hex).map_err(|_| {
            format!("chunk size line is not ASCII hex: {size_hex:?}")
        })?;
        let size = usize::from_str_radix(size_str.trim(), 16).map_err(|e| {
            format!("invalid chunk size '{size_str}': {e}")
        })?;
        rest = &rest[nl + 1..];
        if size == 0 {
            break;
        }
        if rest.len() < size {
            return Err(format!(
                "chunked body truncated: need {size} bytes, have {}",
                rest.len()
            ));
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size..];
        // Trailing CRLF after chunk data
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        } else if rest.starts_with(b"\n") {
            rest = &rest[1..];
        } else if !rest.is_empty() {
            return Err("chunk missing CRLF trailer".into());
        }
    }
    Ok(out)
}

fn trim_ascii_ws_and_cr(s: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = s.len();
    while start < end && (s[start] == b' ' || s[start] == b'\t' || s[start] == b'\r') {
        start += 1;
    }
    while end > start && (s[end - 1] == b' ' || s[end - 1] == b'\t' || s[end - 1] == b'\r') {
        end -= 1;
    }
    &s[start..end]
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

/// Timed GET/POST via optional mixed-port; counts bytes and drops the body (for bandwidth samples).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedTransferResult {
    pub ok: bool,
    pub status: u16,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

const MAX_TIMED_BODY_BYTES: usize = 8 * 1024 * 1024;

pub async fn proxy_timed_transfer_async(
    url: &str,
    mixed_port: Option<u16>,
    method: &str,
    upload_bytes: Option<u64>,
    timeout_ms: u64,
) -> Result<TimedTransferResult, String> {
    use futures_util::StreamExt;
    use std::time::Instant;

    // Bandwidth samples must not auto-decompress: gzip/br decode failures through
    // mixed-port often surface as "error decoding response body" with 0 bytes.
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(5))
        .danger_accept_invalid_certs(false)
        .gzip(false);

    if let Some(port) = mixed_port {
        let proxy_url = format!("http://127.0.0.1:{port}");
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("proxy: {e}"))?;
        builder = builder.proxy(proxy);
    } else {
        builder = builder.no_proxy();
    }

    let client = builder.build().map_err(|e| format!("client: {e}"))?;
    let method_u = method.to_uppercase();
    let upload_len = upload_bytes.unwrap_or(0).min(MAX_TIMED_BODY_BYTES as u64) as usize;

    let t0 = Instant::now();
    let send_result = match method_u.as_str() {
        "POST" => {
            let body = vec![0u8; upload_len];
            client
                .post(url)
                .header("Content-Type", "application/octet-stream")
                .header("Accept-Encoding", "identity")
                .body(body)
                .send()
                .await
        }
        "GET" | "" => {
            client
                .get(url)
                .header("Accept-Encoding", "identity")
                .header("Cache-Control", "no-cache")
                .send()
                .await
        }
        other => {
            return Ok(TimedTransferResult {
                ok: false,
                status: 0,
                bytes: 0,
                elapsed_ms: 0,
                error: Some(format!("unsupported method: {other}")),
            });
        }
    };

    let res = match send_result {
        Ok(r) => r,
        Err(e) => {
            let elapsed_ms = t0.elapsed().as_millis() as u64;
            return Ok(TimedTransferResult {
                ok: false,
                status: 0,
                bytes: 0,
                elapsed_ms,
                error: Some(format!("request: {e}")),
            });
        }
    };

    let status = res.status().as_u16();
    // Stream + count: discard payload; partial bytes still usable if timeout mid-read.
    let mut stream = res.bytes_stream();
    let mut n: u64 = 0;
    let mut read_err: Option<String> = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                n = n.saturating_add(bytes.len() as u64);
                if n > MAX_TIMED_BODY_BYTES as u64 {
                    read_err = Some(format!(
                        "response too large ({} > {} max)",
                        n, MAX_TIMED_BODY_BYTES
                    ));
                    break;
                }
            }
            Err(e) => {
                read_err = Some(format!("read body: {e}"));
                break;
            }
        }
    }
    let elapsed_ms = t0.elapsed().as_millis() as u64;

    if method_u == "POST" {
        // Upload sample: count what we sent (response may be tiny / empty).
        let ok = (200..400).contains(&status) && read_err.is_none();
        return Ok(TimedTransferResult {
            ok,
            status,
            bytes: upload_len as u64,
            elapsed_ms,
            error: if ok {
                None
            } else {
                Some(read_err.unwrap_or_else(|| format!("HTTP {status}")))
            },
        });
    }

    // GET download: prefer full body; accept partial if we got meaningful bytes before timeout.
    let ok_full = (200..400).contains(&status) && read_err.is_none() && n > 0;
    let ok_partial = (200..400).contains(&status) && n >= 64 * 1024;
    let ok = ok_full || ok_partial;
    let error = if ok_full {
        None
    } else if ok_partial {
        Some(format!(
            "部分下载 {} B（{}）仍按已收字节估算",
            n,
            read_err.unwrap_or_else(|| "未完整读完".into())
        ))
    } else {
        Some(read_err.unwrap_or_else(|| {
            if n == 0 {
                format!("HTTP {status} · 0 B")
            } else {
                format!("HTTP {status}")
            }
        }))
    };

    Ok(TimedTransferResult {
        ok,
        status,
        bytes: n,
        elapsed_ms,
        error,
    })
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
    fn smoke_proxy_timed_transfer_dead_proxy_no_panic() {
        let result = std::panic::catch_unwind(|| {
            tauri::async_runtime::block_on(proxy_timed_transfer_async(
                "https://speed.cloudflare.com/__down?bytes=1024",
                Some(1),
                "GET",
                None,
                800,
            ))
        });
        assert!(result.is_ok(), "proxy_timed_transfer_async panicked");
        let inner = result.unwrap().expect("Result::Ok");
        assert!(!inner.ok, "dead proxy should not report ok: {inner:?}");
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

    #[test]
    fn decode_chunked_bytes_roundtrips_multibyte_utf8_chinese_names() {
        // Chunk sizes are in bytes. Chinese chars are 3 bytes each in UTF-8.
        // Old char-based decoder would slice mid-codepoint / corrupt JSON.
        let json = r#"{"proxies":{"香港 HK-2-AT":{"type":"Hysteria2"},"日本 TY-4-HY2":{"type":"Vmess"}}}"#;
        let json_bytes = json.as_bytes();
        assert!(json_bytes.len() > 40, "fixture should be multi-chunk sized");

        // Force a split that is NOT on a char boundary to prove byte lengths matter.
        let mid_bad = {
            let mut i = 0;
            while i < json_bytes.len() {
                let c = json[i..].chars().next().unwrap();
                let len = c.len_utf8();
                if len > 1 {
                    break;
                }
                i += len;
            }
            let c = json[i..].chars().next().unwrap();
            assert!(c.len_utf8() > 1);
            i + 1 // inside the multi-byte char
        };
        let (a, b) = json_bytes.split_at(mid_bad);
        assert!(!json.is_char_boundary(mid_bad));

        let mut chunked = Vec::new();
        chunked.extend_from_slice(format!("{:x}\r\n", a.len()).as_bytes());
        chunked.extend_from_slice(a);
        chunked.extend_from_slice(b"\r\n");
        chunked.extend_from_slice(format!("{:x}\r\n", b.len()).as_bytes());
        chunked.extend_from_slice(b);
        chunked.extend_from_slice(b"\r\n");
        chunked.extend_from_slice(b"0\r\n\r\n");

        let decoded = decode_chunked_bytes(&chunked).expect("decode_chunked_bytes");
        let decoded_str = String::from_utf8(decoded).expect("utf8");
        assert_eq!(decoded_str, json);

        let slim = slim_nodes_from_proxies_json(&decoded_str).unwrap();
        let names: Vec<_> = slim.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"香港 HK-2-AT"));
        assert!(names.contains(&"日本 TY-4-HY2"));
    }

    #[test]
    fn parse_http_response_chunked_preserves_chinese_json() {
        let json = r#"{"proxies":{"香港节点":{"type":"Shadowsocks"},"DIRECT":{"type":"Direct"}}}"#;
        let json_b = json.as_bytes();
        let mid = json_b.len() / 2;
        // Prefer split inside a multi-byte char if possible
        let split_at = (0..json_b.len())
            .find(|&i| !json.is_char_boundary(i) && i > 10)
            .unwrap_or(mid);
        let (a, b) = json_b.split_at(split_at);

        let mut body = Vec::new();
        body.extend_from_slice(format!("{:X}\r\n", a.len()).as_bytes());
        body.extend_from_slice(a);
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(format!("{:X}\r\n", b.len()).as_bytes());
        body.extend_from_slice(b);
        body.extend_from_slice(b"\r\n0\r\n\r\n");

        let mut raw = Vec::new();
        raw.extend_from_slice(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
        );
        raw.extend_from_slice(&body);

        let res = parse_http_response_bytes(&raw).expect("parse");
        assert_eq!(res.status, 200);
        assert_eq!(res.body, json);
        let slim = slim_nodes_from_proxies_json(&res.body).unwrap();
        assert!(slim.nodes.iter().any(|n| n.name == "香港节点"));
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

    #[test]
    fn parse_controller_yaml_reads_sample() {
        let sample = r#"
mixed-port: 7890
external-controller: 127.0.0.1:9090
secret: "test-secret"
"#;
        let (port, secret, mixed) = parse_controller_yaml(sample, 1, 2);
        assert_eq!(port, 9090);
        assert_eq!(secret, "test-secret");
        assert_eq!(mixed, 7890);
    }

    #[test]
    fn non_verge_discover_never_returns_verge_sock_when_absent() {
        // Ensure Verge DEFAULT_SOCK is not present or we still must not inject it for other clients.
        let clashx = discover_for_client("clashx_meta");
        assert!(
            clashx.sock_path.is_none(),
            "clashx_meta sock must be None (never Verge), got {:?}",
            clashx.sock_path
        );

        let fl = discover_for_client("flclash");
        assert!(fl.sock_path.is_none(), "flclash sock must be None, got {:?}", fl.sock_path);

        let ny = discover_for_client("nyanpasu");
        assert!(ny.sock_path.is_none(), "nyanpasu sock must be None, got {:?}", ny.sock_path);

        let party = discover_for_client("mihomo_party");
        if let Some(ref s) = party.sock_path {
            assert_ne!(s, DEFAULT_SOCK, "party must never use Verge sock");
            assert!(s.contains("mihomo-party"), "party sock unexpected: {s}");
        }
    }

    #[test]
    fn read_controller_yaml_only_sets_existing_sock_candidates() {
        let missing = format!("/tmp/egress-checker-no-sock-{}.sock", std::process::id());
        let _ = std::fs::remove_file(&missing);
        let r = read_controller_yaml(
            &[],
            9090,
            7890,
            &[missing],
            "test",
        );
        assert!(r.sock_path.is_none());
        assert_ne!(r.sock_path.as_deref(), Some(DEFAULT_SOCK));
    }

}
