//! Clash Verge Rev / Mihomo controller + per-client discovery.
//!
//! Resolves the external-controller host/port/secret/mixed-port and the local
//! Unix-socket path for a given proxy client. Verge keeps its historical path;
//! other clients read the per-OS table in `crate::platform` and never receive
//! Verge's socket. macOS behavior is unchanged from the pre-split monolith.

use crate::platform;
use regex::Regex;
use std::path::PathBuf;

use super::types::{DiscoverResult, DEFAULT_MIXED, DEFAULT_PORT};

pub fn read_verge_config() -> Result<String, String> {
    let path = platform::verge_config_path();
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))
}

pub fn discover_controller() -> DiscoverResult {
    let path = platform::verge_config_path();
    let default_sock = platform::default_controller_sock();
    let sock_exists = default_sock
        .map(|s| std::path::Path::new(s).exists())
        .unwrap_or(false);
    let sock_path: Option<String> = if sock_exists {
        default_sock.map(|s| s.to_string())
    } else {
        None
    };

    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            let (port, secret, mixed) =
                parse_controller_yaml(&content, DEFAULT_PORT, DEFAULT_MIXED);
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

/// Client-scoped discovery. Verge goes through `discover_controller`; other
/// clients read the per-OS path table in `crate::platform` (macOS keeps the
/// historical hardcoded paths; non-Verge clients never get Verge's sock).
pub fn discover_for_client(client_id: &str) -> DiscoverResult {
    if client_id == "verge" {
        return discover_controller();
    }
    if let Some(spec) = platform::client_discovery(client_id) {
        return read_controller_yaml(
            &spec.yaml_paths,
            spec.default_port,
            spec.default_mixed,
            &spec.sock_candidates,
            spec.source_prefix,
        );
    }
    DiscoverResult {
        host: "127.0.0.1".into(),
        port: 9090,
        secret: String::new(),
        mixed_port: 7890,
        source: format!("unknown-client:{client_id}"),
        sock_path: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            assert_ne!(s, platform::VERGE_SOCK_PATH, "party must never use Verge sock");
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
        assert_ne!(r.sock_path.as_deref(), Some(platform::VERGE_SOCK_PATH));
    }
}
