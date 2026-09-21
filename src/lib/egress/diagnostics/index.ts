/**
 * Universal egress diagnostics — public surface.
 *
 * The implementation is split into cohesive submodules under `diagnostics/`:
 *   probe (base fetch / reachability / retry / deadline / pool),
 *   exitIp, dns, ipv6, webrtc, aiUnlock, streamingUnlock,
 *   performance (latency + bandwidth), routing (split + bare), orchestrator.
 *
 * This barrel re-exports exactly the public API consumed by nodeRun / envRun /
 * gate and by `lib/egress/index.ts`. Internal helpers stay module-private.
 * Prefer Rust mixed-port proxy fetch (same path as Gemini/IP) so probes follow
 * Clash Verge Rev even when the Tauri WebView does not use system proxy/TUN.
 */

export type { ReachabilityOptions } from "./probe";
export { checkReachability, withFailRetry, withFailRetryUnlock } from "./probe";
export { inferHosting, fetchExitIp, exitIpCard } from "./exitIp";
export { checkDnsResolvers, checkDnsLeakApproach } from "./dns";
export { checkIpv6Leak } from "./ipv6";
export { checkWebRtcLeak, webrtcCard } from "./webrtc";
export { probeGeminiUnlock, probeChatgptUnlock } from "./aiUnlock";
export type { BandwidthSampleOptions } from "./performance";
export { sampleLatency, sampleBandwidth } from "./performance";
export { checkSplitRouting, checkBareEgress } from "./routing";
export {
  checkNetflixUnlock,
  checkDisneyUnlock,
  checkYoutubeUnlock,
  checkAppStoreUnlock,
  checkGooglePlayUnlock,
} from "./streamingUnlock";
export { runEgressDiagnostics } from "./orchestrator";
