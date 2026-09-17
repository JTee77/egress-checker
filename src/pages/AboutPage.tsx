export function AboutPage() {
  return (
    <div className="about-block">
      <div className="page-header">
        <div>
          <h1>关于</h1>
          <p>Egress Checker v0.2.0</p>
        </div>
      </div>

      <h2>产品定位</h2>
      <p>
        Egress Checker 用于诊断代理<strong>出口质量</strong>（DNS / IP 属性 / AI
        解锁 / 延迟），面向已自备 Mihomo / Clash Meta 兼容客户端的用户。默认适配
        Clash Verge Rev。
      </p>

      <h2>非目标</h2>
      <ul>
        <li>不提供、不销售任何代理节点或 VPN 服务</li>
        <li>不声称突破防火墙或「翻墙」</li>
        <li>不支持 Shadowrocket / Surge / 商业封闭客户端（v1）</li>
        <li>仅支持 macOS Apple Silicon（arm64）</li>
      </ul>

      <h2>流量提示</h2>
      <p className="muted">
        「快速延迟」几乎不消耗流量。未来的深度 / 优选测速会下载测速文件并切换节点，请注意流量与费用。
      </p>

      
      <h2>v0.2 说明</h2>
      <p className="muted">
        v0.2 起开始做更贴近真实环境的 DNS（macOS scutil 解析器列表）、IPv6 直连/代理对照、以及 WebView 内 WebRTC STUN 候选收集。仍有 WebView / 超时边界，结果用于换节点对照，不是完整泄漏鉴定报告。
      </p>

      <h2>许可证</h2>
      <p>MIT License</p>

      <h2>隐私</h2>
      <p className="muted">
        Secret 仅保存在本地内存/设置中用于访问本机 API，不会上传。请勿在 issue
        或日志中粘贴 secret。
      </p>
    </div>
  );
}
