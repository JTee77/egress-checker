//! WebRTC 泄漏检测：浏览器 STUN 收集 ICE 候选，与代理出口比对判泄漏。
import { classifyWebRtc, candidateScope } from "../leakMatrix";
import type { WebRtcCandidateType } from "../leakMatrix";
import type { CheckCard, ExitIpInfo } from "../types";

type IceCand = {
  type: string;
  address: string;
  protocol: string;
  raw: string;
  scope: "private" | "public" | "unknown";
};

/**
 * A3: Browser STUN gather — 用已知代理出口比对候选（确定性改造）。
 * 真正的泄漏信号是"公网候选 ≠ 代理出口"，据此把三类明确分开而非统统 warn。
 */
export async function checkWebRtcLeak(
  exit?: ExitIpInfo | null,
): Promise<CheckCard> {
  const RTCPeer =
    typeof window !== "undefined"
      ? (window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection })
          .RTCPeerConnection
      : undefined;

  const proxyExitIps = [exit?.ip].filter((x): x is string => !!x);

  if (!RTCPeer) {
    const v = classifyWebRtc({ apiAvailable: false, gatherFailed: false, candidates: [] });
    return {
      id: "webrtc",
      title: "WebRTC",
      level: v.level,
      conclusion: v.conclusion,
      process:
        "嵌入式 WebView 可能禁用 WebRTC。这不等于「无泄漏」，只是本环境测不了。\n测了什么：无（API 缺失）。\n没测：完整 BrowserLeaks / 系统级 WebRTC 策略。",
      suggestion: v.suggestion,
    };
  }

  const candidates: IceCand[] = [];
  let failMsg: string | null = null;

  try {
    const pc = new RTCPeer({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    const gatherDone = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2800);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const c = ev.candidate;
        const candStr = c.candidate || "";
        // candidate: foundation component protocol priority ip port typ type …
        const parts = candStr.split(" ");
        const typIdx = parts.indexOf("typ");
        const typ = typIdx >= 0 ? parts[typIdx + 1] ?? "unknown" : "unknown";
        const address = (c as RTCIceCandidate & { address?: string }).address
          || (parts.length > 4 ? parts[4] : "")
          || "";
        const protocol = (c as RTCIceCandidate & { protocol?: string }).protocol
          || (parts.length > 2 ? parts[2] : "")
          || "";
        if (!address) return;
        const scope = candidateScope(address);
        candidates.push({
          type: typ,
          address,
          protocol,
          raw: candStr,
          scope,
        });
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      };
    });

    pc.createDataChannel("egress-check");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gatherDone;
    pc.close();
  } catch (e) {
    failMsg = e instanceof Error ? e.message : String(e);
  }

  const uniq = new Map<string, IceCand>();
  for (const c of candidates) {
    const key = `${c.type}|${c.address}|${c.protocol}`;
    if (!uniq.has(key)) uniq.set(key, c);
  }
  const list = [...uniq.values()];

  const verdict = classifyWebRtc({
    apiAvailable: true,
    gatherFailed: !!failMsg,
    proxyExitIps,
    candidates: list.map((c) => ({
      type: normalizeIceType(c.type),
      address: c.address,
      scope: c.scope,
    })),
  });

  const detailLines = [
    ...list.map((c) => `${c.type} ${c.scope} ${c.protocol} ${c.address}`),
    `代理出口 IP：${proxyExitIps.join(", ") || "无（先做环境检查/出口 IP 才能精确比对）"}`,
    failMsg ? `收集报错：${failMsg}` : "",
    "测了什么：浏览器 RTCPeerConnection + Google STUN，约 2.8s 收集，公网候选与代理出口比对。",
    "没测：完整泄漏矩阵、mdns 隐藏策略细节、非 WebView 进程。",
    "边界：有候选≠一定泄漏到目标站点；无候选≠一定安全。",
  ].filter(Boolean);

  return {
    id: "webrtc",
    title: "WebRTC",
    level: verdict.level,
    conclusion: verdict.conclusion,
    process: detailLines.join("\n"),
    suggestion: verdict.suggestion,
  };
}

/** 归一 ICE 候选类型到 leakMatrix 的联合；未知一律 unknown。 */
function normalizeIceType(t: string): WebRtcCandidateType {
  const k = t.toLowerCase();
  if (k === "host" || k === "srflx" || k === "prflx" || k === "relay") return k;
  return "unknown";
}

/** Sync placeholder kept for type imports; prefer checkWebRtcLeak(). */
export function webrtcCard(): CheckCard {
  return {
    id: "webrtc",
    title: "WebRTC",
    level: "unknown",
    conclusion: "请调用异步 checkWebRtcLeak()",
  };
}
