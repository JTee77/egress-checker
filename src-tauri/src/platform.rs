//! Platform seam — every OS-specific path, socket, and per-client location
//! table lives here so the rest of the backend stays platform-neutral.
//!
//! macOS behavior is byte-identical to the pre-seam code:
//! - Verge config: `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml`
//!   (`dirs::config_dir()` on macOS resolves to exactly that directory, and it
//!   also unifies Windows `%APPDATA%` for free).
//! - Sockets: `/tmp/verge/verge-mihomo.sock`, `/tmp/mihomo-party.sock` (unix only).
//!
//! Non-macOS entries are deliberately conservative placeholders: Verge's config
//! resolves through `dirs::config_dir()`; other clients fall back to TCP
//! defaults until a real Windows/Linux port tunes their paths.

use std::path::PathBuf;

/// Clash Verge Rev config, relative to the OS config dir.
pub const VERGE_REL_CONFIG: &str = "io.github.clash-verge-rev.clash-verge-rev/config.yaml";

/// Verge's mihomo controller Unix socket (unix targets only).
pub const VERGE_SOCK_PATH: &str = "/tmp/verge/verge-mihomo.sock";

/// Mihomo Party controller sock (unix only) — consumed via the client table.
pub const PARTY_SOCK_PATH: &str = "/tmp/mihomo-party.sock";

pub fn verge_config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
        .join(VERGE_REL_CONFIG)
}

/// Verge controller sock — only where Unix sockets exist. (A Windows port
/// would use a named pipe; not implemented yet, so None there.)
pub fn default_controller_sock() -> Option<&'static str> {
    if cfg!(unix) {
        Some(VERGE_SOCK_PATH)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn app_log_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Library/Logs/EgressChecker"))
}

#[cfg(not(target_os = "macos"))]
pub fn app_log_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("logs").join("EgressChecker"))
}

/// Per-client controller discovery inputs. `yaml_paths` may use `~` and may be
/// directories (scanned for *.yaml / *.yml by `read_controller_yaml`).
pub struct ClientDiscovery {
    pub yaml_paths: Vec<String>,
    pub default_port: u16,
    pub default_mixed: u16,
    pub sock_candidates: Vec<String>,
    pub source_prefix: &'static str,
}

/// macOS table — must stay identical to the historical hardcoded paths.
/// Verge is NOT here: it goes through `discover_controller()` in `mihomo`.
#[cfg(target_os = "macos")]
pub fn client_discovery(client_id: &str) -> Option<ClientDiscovery> {
    let spec = match client_id {
        "clashx_meta" => ClientDiscovery {
            yaml_paths: vec!["~/.config/clash/config.yaml".into()],
            default_port: 9090,
            default_mixed: 7890,
            sock_candidates: vec![], // no fixed public sock
            source_prefix: "clashx_meta",
        },
        "flclash" => ClientDiscovery {
            yaml_paths: vec![
                "~/Library/Application Support/com.follow.clash".into(),
                "~/Library/Application Support/FlClash".into(),
            ],
            default_port: 9090,
            default_mixed: 7890,
            // internal IPC is not Mihomo REST — never inject Verge/Party sock
            sock_candidates: vec![],
            source_prefix: "flclash",
        },
        "mihomo_party" => ClientDiscovery {
            yaml_paths: vec!["~/Library/Application Support/mihomo-party".into()],
            default_port: 9090, // TCP EC often empty; sock is primary
            default_mixed: 7890,
            sock_candidates: vec![PARTY_SOCK_PATH.into()],
            source_prefix: "mihomo_party",
        },
        "nyanpasu" => ClientDiscovery {
            yaml_paths: vec![
                "~/Library/Application Support/Clash Nyanpasu/clash-runtime.yaml".into(),
                "~/Library/Application Support/Clash Nyanpasu/clash.yaml".into(),
                "~/Library/Application Support/clash-nyanpasu/clash-runtime.yaml".into(),
                "~/Library/Application Support/clash-nyanpasu/clash.yaml".into(),
                "~/Library/Application Support/Clash Nyanpasu".into(),
                "~/Library/Application Support/clash-nyanpasu".into(),
            ],
            default_port: 17650, // default EC; debug builds may use 9872
            default_mixed: 7890,
            sock_candidates: vec![],
            source_prefix: "nyanpasu",
        },
        _ => return None,
    };
    Some(spec)
}

/// Non-macOS placeholder table. Only `clashx_meta`'s Linux-style path is kept
/// (it is valid on Linux); other clients get TCP defaults only until a real
/// Windows/Linux port tunes their locations.
#[cfg(not(target_os = "macos"))]
pub fn client_discovery(client_id: &str) -> Option<ClientDiscovery> {
    let spec = match client_id {
        "clashx_meta" => ClientDiscovery {
            yaml_paths: vec!["~/.config/clash/config.yaml".into()],
            default_port: 9090,
            default_mixed: 7890,
            sock_candidates: vec![],
            source_prefix: "clashx_meta",
        },
        "flclash" | "mihomo_party" | "nyanpasu" => ClientDiscovery {
            yaml_paths: vec![],
            default_port: 9090,
            default_mixed: 7890,
            sock_candidates: vec![],
            source_prefix: "placeholder",
        },
        _ => return None,
    };
    Some(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verge_config_path_unifies_via_config_dir() {
        let p = verge_config_path();
        assert!(
            p.to_string_lossy().ends_with(VERGE_REL_CONFIG),
            "unexpected path: {p:?}"
        );
        // macOS must keep the exact historical location.
        #[cfg(target_os = "macos")]
        {
            let home = dirs::home_dir().expect("home dir");
            assert_eq!(
                p,
                home.join("Library/Application Support").join(VERGE_REL_CONFIG),
                "macOS Verge config path must be byte-identical to pre-seam code"
            );
        }
    }

    #[test]
    fn unix_socks_only_on_unix_targets() {
        assert_eq!(default_controller_sock().is_some(), cfg!(unix));
        if cfg!(unix) {
            assert_eq!(default_controller_sock(), Some(VERGE_SOCK_PATH));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_client_table_preserves_historical_values() {
        let cx = client_discovery("clashx_meta").expect("clashx_meta");
        assert_eq!(cx.yaml_paths, vec!["~/.config/clash/config.yaml".to_string()]);
        assert_eq!(cx.default_port, 9090);
        assert_eq!(cx.default_mixed, 7890);
        assert!(cx.sock_candidates.is_empty());

        let fl = client_discovery("flclash").expect("flclash");
        assert_eq!(
            fl.yaml_paths,
            vec![
                "~/Library/Application Support/com.follow.clash".to_string(),
                "~/Library/Application Support/FlClash".to_string(),
            ]
        );
        assert!(fl.sock_candidates.is_empty());

        let party = client_discovery("mihomo_party").expect("mihomo_party");
        assert_eq!(party.sock_candidates, vec![PARTY_SOCK_PATH.to_string()]);

        let ny = client_discovery("nyanpasu").expect("nyanpasu");
        assert_eq!(ny.default_port, 17650);
        assert_eq!(ny.yaml_paths.len(), 6);

        // Verge is handled by discover_controller, not the table.
        assert!(client_discovery("verge").is_none());
        assert!(client_discovery("nope").is_none());
    }
}
