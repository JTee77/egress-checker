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
    sock_path: Option<String>,
}

#[tauri::command]
async fn mihomo_list_nodes(req: ListNodesRequest) -> Result<ListNodesResult, String> {
    list_nodes_async(
        &req.host,
        req.port,
        &req.secret,
        req.timeout_ms.unwrap_or(18000),
        req.sock_path.as_deref(),
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

/// Append a line to ~/Library/Logs/EgressChecker/app.log (macOS). Best-effort.
fn append_app_log(msg: &str) {
    use std::io::Write;

    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home.join("Library/Logs/EgressChecker");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("app.log");
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(f, "ts_unix={secs} {msg}");
}

#[cfg(debug_assertions)]
async fn vite_dev_reachable(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(600))
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // Any HTTP response (incl. 4xx) means something is listening on the devUrl.
    client.get(url).send().await.is_ok()
}

/// Inject a full-page Chinese error into the live WebView. Never uses data: navigate
/// (that path crashed WKWebView on macOS).
#[cfg(debug_assertions)]
fn show_vite_dead_page(win: &tauri::WebviewWindow, reason: &str) {
    let _ = win.set_title("Egress Checker — Vite 已退出");
    // Build DOM via JS literals; avoid navigating away from the webview origin.
    let js = format!(
        r#"(function(){{
  if (window.__egressViteDeadShown) return;
  window.__egressViteDeadShown = true;
  try {{
    document.documentElement.style.background = '#0f1419';
    document.body.style.margin = '0';
    document.body.style.background = '#0f1419';
    document.body.style.color = '#e7ecf3';
    document.body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.setAttribute('id', 'vite-dead');
    wrap.style.cssText = 'font-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"Helvetica Neue\",sans-serif;max-width:560px;margin:64px auto;padding:24px;line-height:1.6;color:#e7ecf3;background:#0f1419';
    wrap.innerHTML = '<h1 style="font-size:22px;color:#ffb454;margin:0 0 12px">Vite 已退出，前端不可用</h1>'
      + '<p>开发服务器（127.0.0.1:1420）已停止或无法连接，所以只剩空白窗口。</p>'
      + '<p>请<strong>关掉本窗口</strong>，然后只开一个终端重新运行：</p>'
      + '<p><code style="background:#1c2430;padding:2px 8px;border-radius:4px">pnpm tauri dev</code></p>'
      + '<p style="opacity:.75;font-size:13px">不要直接打开 target/debug/egress-checker（会留下无前端的空壳）。</p>'
      + '<pre style="white-space:pre-wrap;font-size:12px;opacity:.7;margin-top:16px"></pre>';
    document.body.appendChild(wrap);
    var pre = wrap.querySelector('pre');
    if (pre) pre.textContent = {reason_json};
  }} catch (e) {{}}
}})();"#,
        reason_json = serde_json::to_string(reason).unwrap_or_else(|_| "\"vite unreachable\"".into())
    );
    let _ = win.eval(&js);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;

            let frontend_url = app
                .config()
                .build
                .dev_url
                .as_ref()
                .map(|u| u.to_string())
                .unwrap_or_else(|| "http://127.0.0.1:1420".into());
            append_app_log(&format!(
                "startup frontend_url={frontend_url} (no data-url navigate)"
            ));

            #[cfg(debug_assertions)]
            {
                let handle = app.handle().clone();
                let probe_url = frontend_url.clone();
                tauri::async_runtime::spawn(async move {
                    // Grace: Vite/beforeDevCommand needs time to bind.
                    let _ = tauri::async_runtime::spawn_blocking(|| {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                    })
                    .await;

                    let mut ever_ok = false;
                    let mut dead_notified = false;
                    let mut consecutive_fail: u32 = 0;
                    loop {
                        let ok = vite_dev_reachable(&probe_url).await;
                        if ok {
                            ever_ok = true;
                            consecutive_fail = 0;
                        } else {
                            consecutive_fail = consecutive_fail.saturating_add(1);
                            // Require a few misses to avoid race flapping; if never came up,
                            // notify after ~6s of fails (3 probes); if it died after OK, after 2 probes.
                            let threshold = if ever_ok { 2 } else { 3 };
                            if consecutive_fail >= threshold && !dead_notified {
                                dead_notified = true;
                                let reason = if ever_ok {
                                    format!(
                                        "Vite was up then became unreachable at {probe_url}. beforeDevCommand child likely exited; WebView left empty."
                                    )
                                } else {
                                    format!(
                                        "Vite never became reachable at {probe_url}. Do not open bare target/debug; use pnpm tauri dev."
                                    )
                                };
                                append_app_log(&format!("vite_dead {reason}"));
                                if let Some(win) = handle.get_webview_window("main") {
                                    show_vite_dead_page(&win, &reason);
                                }
                            }
                        }
                        let _ = tauri::async_runtime::spawn_blocking(|| {
                            std::thread::sleep(std::time::Duration::from_secs(2));
                        })
                        .await;
                    }
                });
            }

            Ok(())
        })
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
