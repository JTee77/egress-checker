//! Clash Verge Rev / Mihomo controller discovery + HTTP (TCP / Unix socket).
//! Secrets are returned to the frontend for local API use only; never log secret values.

use regex::Regex;
use serde::Serialize;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

pub const VERGE_REL_CONFIG: &str =
    "Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml";
pub const DEFAULT_SOCK: &str = "/tmp/verge/verge-mihomo.sock";
pub const DEFAULT_PORT: u16 = 9097;
pub const DEFAULT_MIXED: u16 = 7897;

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

/// HTTP to Mihomo controller over TCP (preferred path from Tauri commands).
pub fn http_via_tcp(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    secret: &str,
    timeout_ms: u64,
) -> Result<UnixHttpResult, String> {
    let url = format!("http://{host}:{port}{path}");
    let client = reqwest::blocking::Client::builder()
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

    let res = builder.send().map_err(|e| format!("request: {e}"))?;
    let status = res.status().as_u16();
    let body = res.text().map_err(|e| format!("read body: {e}"))?;
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

/// Fetch a URL optionally via local mixed-port HTTP proxy (for Gemini / IP probes).
pub fn proxy_fetch(
    url: &str,
    mixed_port: Option<u16>,
    user_agent: Option<&str>,
    timeout_ms: u64,
) -> Result<UnixHttpResult, String> {
    let mut builder = reqwest::blocking::Client::builder()
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
    let res = req.send().map_err(|e| format!("request: {e}"))?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    Ok(UnixHttpResult { status, body })
}
