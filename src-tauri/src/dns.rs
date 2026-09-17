//! macOS DNS resolver listing via `scutil --dns`.
//! Prefer scoped tunnel/VPN resolvers when present; otherwise unique nameservers.

use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResolversResult {
    pub resolvers: Vec<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct ResolverBlock {
    nameservers: Vec<String>,
    if_index_line: Option<String>,
    scoped: bool,
}

fn looks_like_ip(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    if t.parse::<std::net::Ipv4Addr>().is_ok() {
        return true;
    }
    if t.parse::<std::net::Ipv6Addr>().is_ok() {
        return true;
    }
    false
}

fn is_tunnel_iface(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    // scutil: "if_index : 15 (utun4)" etc.
    ["utun", "ipsec", "ppp", "wg", "tun", "tap", "wireguard"]
        .iter()
        .any(|k| lower.contains(k))
}

/// Parse `scutil --dns` text into preferred resolver IP list.
///
/// Strategy:
/// 1. Split into resolver blocks (lines starting with `resolver #`).
/// 2. Collect nameserver[*] IPs per block; note scoped + if_index.
/// 3. If any block looks like tunnel/VPN (utun/ipsec/ppp/…), prefer those nameservers.
/// 4. Else if scoped resolvers exist, prefer those.
/// 5. Else return all unique nameservers (BTreeSet → stable sorted Vec).
pub fn parse_scutil_dns(raw: &str) -> (Vec<String>, String) {
    let mut blocks: Vec<ResolverBlock> = Vec::new();
    let mut current: Option<ResolverBlock> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("resolver #") {
            if let Some(b) = current.take() {
                blocks.push(b);
            }
            current = Some(ResolverBlock::default());
            continue;
        }
        let Some(block) = current.as_mut() else {
            continue;
        };
        if let Some(rest) = trimmed.strip_prefix("nameserver[") {
            // nameserver[0] : 1.1.1.1
            if let Some(colon) = rest.find(':') {
                let ip = rest[colon + 1..].trim();
                if looks_like_ip(ip) {
                    block.nameservers.push(ip.to_string());
                }
            }
        } else if trimmed.starts_with("if_index") {
            block.if_index_line = Some(trimmed.to_string());
        } else if trimmed.starts_with("flags") && trimmed.to_ascii_lowercase().contains("scoped") {
            block.scoped = true;
        }
    }
    if let Some(b) = current.take() {
        blocks.push(b);
    }

    let tunnel: Vec<&ResolverBlock> = blocks
        .iter()
        .filter(|b| {
            !b.nameservers.is_empty()
                && b.if_index_line
                    .as_deref()
                    .map(is_tunnel_iface)
                    .unwrap_or(false)
        })
        .collect();

    let preferred: Vec<&ResolverBlock> = if !tunnel.is_empty() {
        tunnel
    } else {
        let scoped: Vec<&ResolverBlock> = blocks
            .iter()
            .filter(|b| b.scoped && !b.nameservers.is_empty())
            .collect();
        if !scoped.is_empty() {
            scoped
        } else {
            blocks.iter().filter(|b| !b.nameservers.is_empty()).collect()
        }
    };

    let mut set = BTreeSet::new();
    for b in &preferred {
        for ns in &b.nameservers {
            set.insert(ns.clone());
        }
    }
    let resolvers: Vec<String> = set.into_iter().collect();

    let source = if preferred.iter().any(|b| {
        b.if_index_line
            .as_deref()
            .map(is_tunnel_iface)
            .unwrap_or(false)
    }) {
        "scutil-scoped-tunnel".to_string()
    } else if preferred.iter().any(|b| b.scoped) {
        "scutil-scoped".to_string()
    } else {
        "scutil-all".to_string()
    };

    (resolvers, source)
}

pub fn list_dns_resolvers_blocking() -> DnsResolversResult {
    #[cfg(not(target_os = "macos"))]
    {
        return DnsResolversResult {
            resolvers: vec![],
            source: "unsupported-platform".into(),
            raw_hint: None,
            error: Some(
                "DNS 解析器列表依赖 macOS `scutil --dns`；当前平台不可用。".into(),
            ),
        };
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let output = match Command::new("scutil").arg("--dns").output() {
            Ok(o) => o,
            Err(e) => {
                return DnsResolversResult {
                    resolvers: vec![],
                    source: "scutil".into(),
                    raw_hint: None,
                    error: Some(format!("执行 scutil --dns 失败: {e}")),
                };
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return DnsResolversResult {
                resolvers: vec![],
                source: "scutil".into(),
                raw_hint: None,
                error: Some(format!(
                    "scutil --dns 退出码 {:?}: {}",
                    output.status.code(),
                    stderr.trim()
                )),
            };
        }

        let raw = String::from_utf8_lossy(&output.stdout).into_owned();
        let (resolvers, source) = parse_scutil_dns(&raw);
        let hint = if raw.len() > 400 {
            format!("{}… ({} bytes)", &raw[..400], raw.len())
        } else {
            raw.clone()
        };

        if resolvers.is_empty() {
            return DnsResolversResult {
                resolvers,
                source,
                raw_hint: Some(hint),
                error: Some("scutil --dns 已执行但未解析到 nameserver".into()),
            };
        }

        DnsResolversResult {
            resolvers,
            source,
            raw_hint: Some(hint),
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"DNS configuration

resolver #1
  nameserver[0] : 192.168.1.1
  nameserver[1] : 8.8.8.8
  flags    : Request A records, Request AAAA records
  reach    : 0x00000002 (Reachable)

resolver #2
  domain   : local
  options  : mdns
  timeout  : 5
  flags    : Request A records
  reach    : 0x00000000 (Not Reachable)
  order    : 300000

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 10.64.0.1
  if_index : 15 (utun4)
  flags    : Scoped, Request A records, Request AAAA records
  reach    : 0x00000002 (Reachable)

resolver #2
  nameserver[0] : 192.168.1.1
  if_index : 6 (en0)
  flags    : Scoped, Request A records
  reach    : 0x00000002 (Reachable)
"#;

    #[test]
    fn parse_prefers_scoped_tunnel_nameservers() {
        let (resolvers, source) = parse_scutil_dns(FIXTURE);
        assert_eq!(resolvers, vec!["10.64.0.1".to_string()]);
        assert_eq!(source, "scutil-scoped-tunnel");
    }

    #[test]
    fn parse_all_unique_when_no_tunnel() {
        let raw = r#"DNS configuration

resolver #1
  nameserver[0] : 1.1.1.1
  nameserver[1] : 8.8.8.8
  flags    : Request A records

resolver #2
  nameserver[0] : 1.1.1.1
  domain   : lan
"#;
        let (resolvers, source) = parse_scutil_dns(raw);
        assert_eq!(
            resolvers,
            vec!["1.1.1.1".to_string(), "8.8.8.8".to_string()]
        );
        assert_eq!(source, "scutil-all");
    }

    #[test]
    fn parse_scoped_without_tunnel() {
        let raw = r#"
DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 192.168.0.1
  if_index : 6 (en0)
  flags    : Scoped, Request A records
"#;
        let (resolvers, source) = parse_scutil_dns(raw);
        assert_eq!(resolvers, vec!["192.168.0.1".to_string()]);
        assert_eq!(source, "scutil-scoped");
    }

    #[test]
    fn parse_ipv6_nameserver() {
        let raw = r#"
resolver #1
  nameserver[0] : 2001:4860:4860::8888
  flags    : Request AAAA records
"#;
        let (resolvers, source) = parse_scutil_dns(raw);
        assert_eq!(resolvers, vec!["2001:4860:4860::8888".to_string()]);
        assert_eq!(source, "scutil-all");
    }

    #[test]
    fn parse_empty_fixture() {
        let (resolvers, _) = parse_scutil_dns("DNS configuration\n");
        assert!(resolvers.is_empty());
    }
}
