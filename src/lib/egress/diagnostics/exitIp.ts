//! 出口 IP：TLS 多源取映射、机房关键词推断、出口 IP 卡片。
import { fetchTextViaProxy } from "../fetchVia";
import type { CheckCard, CheckLevel, ExitIpInfo } from "../types";

/** 统一的「获取失败」空结果（三次重复的字面量收敛为一个本地 helper）。 */
function emptyExitIp(): ExitIpInfo {
  return {
    ip: null,
    country: null,
    countryCode: null,
    org: null,
    isp: null,
    hosting: null,
    ipTypeLabel: "--",
  };
}

/**
 * 由组织名/ISP 关键词推断是否机房（datacenter）IP。
 * TLS IP 源（ipwho.is / ip.sb / geojs.io）不像 ip-api 那样提供 hosting 布尔字段，只能推断。
 */
export function inferHosting(...fields: (string | null | undefined)[]): boolean {
  const blob = fields.filter(Boolean).join(" ").toLowerCase();
  if (!blob) return false;
  const keywords = [
    "hosting",
    "cloud",
    "datacenter",
    "data center",
    "colo",
    "vps",
    "dedicated",
    "server",
    "ovh",
    "hetzner",
    "digitalocean",
    "linode",
    "vultr",
    "leaseweb",
    "amazon",
    "aws",
    "azure",
    "oracle",
    "alibaba",
    "tencent",
    "m247",
    "datacamp",
    "packethub",
    "xtom",
    "ipxo",
    "choopa",
    "contabo",
  ];
  return keywords.some((k) => blob.includes(k));
}

/** 单个源解析出的映射字段（null 表示该源失败，尝试下一个）。 */
type ExitIpSourceFields = {
  ip: string;
  country: string | null;
  countryCode: string | null;
  org: string | null;
  isp: string | null;
};

/**
 * TLS-only 出口 IP 源（ip-api 免费层无 HTTPS，明文 HTTP 不适合泄漏检查工具）。
 * 顺序尝试，先成功者胜出。
 */
const EXIT_IP_SOURCES: {
  url: string;
  parse: (data: unknown) => ExitIpSourceFields | null;
}[] = [
  {
    url: "https://ipwho.is/",
    parse: (data) => {
      const d = data as {
        success?: boolean;
        ip?: string;
        country?: string;
        country_code?: string;
        connection?: { org?: string; isp?: string };
      };
      if (d.success !== true || !d.ip) return null;
      return {
        ip: d.ip,
        country: d.country ?? null,
        countryCode: d.country_code ?? null,
        org: d.connection?.org ?? null,
        isp: d.connection?.isp ?? null,
      };
    },
  },
  {
    url: "https://api.ip.sb/geoip",
    parse: (data) => {
      const d = data as {
        ip?: string;
        country?: string;
        country_code?: string;
        organization?: string;
        isp?: string;
      };
      // 无 success 标志；有 ip 即视为成功
      if (!d.ip) return null;
      return {
        ip: d.ip,
        country: d.country ?? null,
        countryCode: d.country_code ?? null,
        org: d.organization ?? null,
        isp: d.isp ?? null,
      };
    },
  },
  {
    // 第三冗余源（v0.1.9）：geojs.io HTTPS 无鉴权、当前不打 429，用来兜住
    // ipwho.is→ip.sb 双双限流/失败时"整体取不到出口 IP"。它同样不提供 hosting
    // 权威字段，机房判定仍走上面的关键词推断（UI 老实标「疑似」，不做确认级升级——
    // 经实测，可在此工具代理出口下稳定访问且带权威机房字段的免费 HTTPS 源不存在）。
    url: "https://get.geojs.io/v1/ip/geo.json",
    parse: (data) => {
      const d = data as {
        ip?: string;
        country?: string;
        country_code?: string;
        organization?: string;
      };
      if (!d.ip) return null;
      return {
        ip: d.ip,
        country: d.country ?? null,
        countryCode: d.country_code ?? null,
        org: d.organization ?? null,
        isp: d.organization ?? null,
      };
    },
  },
];

export async function fetchExitIp(
  mixedPort?: number | null,
): Promise<ExitIpInfo> {
  // 顺序尝试（house convention：避免同时打满 Rust spawn_blocking 池）
  for (const source of EXIT_IP_SOURCES) {
    const r = await fetchTextViaProxy(source.url, {
      mixedPort: mixedPort ?? null,
      timeoutMs: 4000,
    });
    if (!r.ok || !r.text) continue;
    try {
      const data = JSON.parse(r.text) as unknown;
      const fields = source.parse(data);
      if (!fields) continue;
      const hosting = inferHosting(fields.org, fields.isp);
      return {
        ip: fields.ip,
        country: fields.country,
        countryCode: fields.countryCode,
        org: fields.org ?? fields.isp ?? null,
        isp: fields.isp ?? null,
        hosting,
        hostingInferred: true,
        ipTypeLabel: hosting ? "疑似机房(DCH)" : "住宅(ISP)",
      };
    } catch {
      // 解析失败 → 尝试下一个源
    }
  }
  return emptyExitIp();
}

export function exitIpCard(info: ExitIpInfo): CheckCard {
  if (!info.ip) {
    return {
      id: "exit-ip",
      title: "出口 IP",
      level: "fail",
      conclusion: "无法获取出口 IP",
      suggestion: "检查网络或临时关闭拦截局域网流量的规则。",
    };
  }
  const level: CheckLevel = info.hosting ? "warn" : "pass";
  const processLines = [
    `组织 ${info.org ?? "--"} · ISP ${info.isp ?? "--"} · 国家 ${info.country ?? "--"}`,
  ];
  if (info.hostingInferred) {
    processLines.push("机房判定：由组织名关键词推断（当前 IP 源未提供该字段）");
  }
  return {
    id: "exit-ip",
    title: "出口 IP",
    level,
    conclusion: `${info.ip} · ${info.countryCode ?? "?"} · ${info.ipTypeLabel}`,
    process: processLines.join("\n"),
    suggestion: info.hosting
      ? "机房 IP 可能导致部分 AI / 流媒体风控；可尝试住宅/家宽节点。"
      : undefined,
  };
}
