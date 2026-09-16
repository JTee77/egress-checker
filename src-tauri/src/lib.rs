mod mihomo;

use mihomo::{
    discover_controller, http_via_tcp, http_via_unix, proxy_fetch, DiscoverResult, UnixHttpResult,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerConfig {
    pub host: String,
    pub port: u16,
    pub secret: String,
    pub mixed_port: u16,
    pub source: String,
    pub sock_path: Option<String>,
}

#[tauri::command]
async fn discover_mihomo() -> Result<ControllerConfig, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let d: DiscoverResult = discover_controller();
        ControllerConfig {
            host: d.host,
            port: d.port,
            secret: d.secret,
            mixed_port: d.mixed_port,
            source: d.source,
            sock_path: d.sock_path,
        }
    })
    .await
    .map_err(|e| format!("task join: {e}"))
}

#[tauri::command]
async fn read_verge_config_raw() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        mihomo::read_verge_config().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TcpHttpRequest {
    host: String,
    port: u16,
    method: String,
    path: String,
    body: Option<String>,
    secret: String,
    timeout_ms: Option<u64>,
}

#[tauri::command]
async fn mihomo_http(req: TcpHttpRequest) -> Result<UnixHttpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        http_via_tcp(
            &req.host,
            req.port,
            &req.method,
            &req.path,
            req.body.as_deref(),
            &req.secret,
            req.timeout_ms.unwrap_or(3000),
        )
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnixHttpRequest {
    method: String,
    path: String,
    body: Option<String>,
    secret: String,
    sock_path: Option<String>,
    timeout_ms: Option<u64>,
}

#[tauri::command]
async fn mihomo_unix_http(req: UnixHttpRequest) -> Result<UnixHttpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        http_via_unix(
            &req.method,
            &req.path,
            req.body.as_deref(),
            &req.secret,
            req.sock_path.as_deref(),
            req.timeout_ms.unwrap_or(3000),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyFetchRequest {
    url: String,
    mixed_port: Option<u16>,
    user_agent: Option<String>,
    timeout_ms: Option<u64>,
}

#[tauri::command]
async fn egress_proxy_fetch(req: ProxyFetchRequest) -> Result<UnixHttpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        proxy_fetch(
            &req.url,
            req.mixed_port,
            req.user_agent.as_deref(),
            req.timeout_ms.unwrap_or(5000),
        )
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            discover_mihomo,
            read_verge_config_raw,
            mihomo_http,
            mihomo_unix_http,
            egress_proxy_fetch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
