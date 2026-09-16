mod mihomo;

use mihomo::{
    discover_controller, http_via_tcp, http_via_unix, proxy_fetch, DiscoverResult, UnixHttpResult,
};
use serde::{Deserialize, Serialize};
#[cfg(debug_assertions)]
use std::time::Duration;
#[cfg(debug_assertions)]
use tauri::{Manager, Url};

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

#[cfg(debug_assertions)]
fn vite_dev_unreachable() -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(_) => return true,
    };
    // Any HTTP response means something is listening on :1420.
    client.get("http://localhost:1420").send().is_err()
}

#[cfg(debug_assertions)]
fn boot_hint_data_url() -> Result<Url, String> {
    let html = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>前端未启动</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
         margin: 0; padding: 48px 32px; background: #0f1419; color: #e7ecf3; line-height: 1.6; }
  h1 { font-size: 22px; margin: 0 0 16px; color: #ffb454; }
  p { margin: 0 0 12px; font-size: 15px; }
  code { background: #1c2430; padding: 2px 8px; border-radius: 4px; font-size: 13px; }
  ol { margin: 12px 0; padding-left: 22px; }
  li { margin-bottom: 8px; }
</style>
</head>
<body>
  <h1>前端没起来，所以白屏</h1>
  <p>请不要直接双击/运行 <code>target/debug/egress-checker</code>。</p>
  <p>正确做法：</p>
  <ol>
    <li>只开一个终端</li>
    <li>在项目目录运行 <code>pnpm tauri dev</code></li>
    <li>若已开多个窗口或进程，请全部退出后再只开一个</li>
  </ol>
  <p>这样会同时启动 Vite（localhost:1420）和本应用，界面才能正常显示。</p>
</body>
</html>"#;

    let mut encoded = String::with_capacity(html.len() * 3);
    for b in html.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*b as char);
            }
            b' ' => encoded.push_str("%20"),
            _ => encoded.push_str(&format!("%{b:02X}")),
        }
    }
    Url::parse(&format!("data:text/html;charset=utf-8,{encoded}"))
        .map_err(|e| format!("data url: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tauri::async_runtime::spawn_blocking(|| {
                        std::thread::sleep(Duration::from_secs(1));
                    })
                    .await;

                    let unreachable = tauri::async_runtime::spawn_blocking(vite_dev_unreachable)
                        .await
                        .unwrap_or(true);

                    if unreachable {
                        if let Ok(url) = boot_hint_data_url() {
                            if let Some(win) = handle.get_webview_window("main") {
                                let _ = win.navigate(url);
                            }
                        }
                    }
                });
            }
            #[cfg(not(debug_assertions))]
            {
                let _ = app;
            }
            Ok(())
        })
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
