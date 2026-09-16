mod mihomo;

use mihomo::{
    discover_controller, http_via_tcp_async, http_via_unix, list_nodes_async, proxy_fetch_async,
    DiscoverResult, ListNodesResult, UnixHttpResult,
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

fn join_err(e: impl std::fmt::Display) -> String {
    format!("task join: {e}")
}

fn catch_disk<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + std::panic::UnwindSafe,
{
    match std::panic::catch_unwind(f) {
        Ok(r) => r,
        Err(_) => Err("native panic caught (disk/unix path)".into()),
    }
}

#[tauri::command]
async fn discover_mihomo() -> Result<ControllerConfig, String> {
    tauri::async_runtime::spawn_blocking(|| {
        catch_disk(|| {
            let d: DiscoverResult = discover_controller();
            Ok(ControllerConfig {
                host: d.host,
                port: d.port,
                secret: d.secret,
                mixed_port: d.mixed_port,
                source: d.source,
                sock_path: d.sock_path,
            })
        })
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
async fn read_verge_config_raw() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        catch_disk(|| mihomo::read_verge_config().map_err(|e| e.to_string()))
    })
    .await
    .map_err(join_err)?
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
    http_via_tcp_async(
        &req.host,
        req.port,
        &req.method,
        &req.path,
        req.body.as_deref(),
        &req.secret,
        req.timeout_ms.unwrap_or(3000),
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListNodesRequest {
    host: String,
    port: u16,
    secret: String,
    timeout_ms: Option<u64>,
}

#[tauri::command]
async fn mihomo_list_nodes(req: ListNodesRequest) -> Result<ListNodesResult, String> {
    list_nodes_async(
        &req.host,
        req.port,
        &req.secret,
        req.timeout_ms.unwrap_or(18000),
    )
    .await
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
        catch_disk(|| {
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
    })
    .await
    .map_err(join_err)?
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
    proxy_fetch_async(
        &req.url,
        req.mixed_port,
        req.user_agent.as_deref(),
        req.timeout_ms.unwrap_or(5000),
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            discover_mihomo,
            read_verge_config_raw,
            mihomo_http,
            mihomo_list_nodes,
            mihomo_unix_http,
            egress_proxy_fetch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
