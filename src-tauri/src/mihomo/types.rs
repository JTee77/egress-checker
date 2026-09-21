//! Shared data types + constants for the mihomo controller layer.
//! These are the plain structs returned to the frontend and the tuning knobs
//! (default ports, body caps, proxy-type/name filters) reused across transport,
//! discovery and nodes modules.

use serde::Serialize;

pub const DEFAULT_PORT: u16 = 9097;
pub const DEFAULT_MIXED: u16 = 7897;

/// Cap /proxies (and similar) IPC bodies so huge delay-history payloads cannot kill the webview.
pub const MAX_BODY_BYTES: usize = 6 * 1024 * 1024;

/// Cap for bandwidth-sample transfers (separate from controller IPC cap).
pub(crate) const MAX_TIMED_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Proxy group types that are not real leaf nodes.
pub(crate) const IGNORE_PROXY_TYPES: &[&str] = &[
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

/// Node-name substrings that indicate marketing/junk entries rather than a real proxy.
pub(crate) const JUNK_NAME_KEYWORDS: &[&str] = &["剩余", "到期", "官网"];

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedTransferResult {
    pub ok: bool,
    pub status: u16,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}
