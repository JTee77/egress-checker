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
        解锁 / 延迟 / 分流与裸奔粗检），面向已自备 Mihomo / Clash Meta 兼容客户端的用户。默认适配
        Clash Verge Rev。
      </p>

      <h2>非目标</h2>
      <ul>
        <li>不提供、不销售任何代理节点或 VPN 服务</li>
        <li>不声称突破防火墙或「翻墙」</li>
        <li>不支持 Shadowrocket / Surge / 商业封闭客户端（v1）</li>
        <li>仅支持 macOS Apple Silicon（arm64）</li>
      </ul>

      <h2>各检测卡测了什么 / 没测什么</h2>
      <p className="muted">
        首页卡片用于换节点时快速对照；下面是简要边界说明（详情也在各卡 tip/detail 里）。
      </p>
      <ul className="about-check-notes">
        <li>
          <strong>连通性</strong>：境外 HTTPS generate_204 是否可达（优先经 mixed-port）。
          不测：完整站点可用性、UDP、所有地区 CDN。
        </li>
        <li>
          <strong>DNS 解析器</strong>：macOS <code>scutil --dns</code> 列出本机 resolver，附带 Cloudflare loc 启发式。
          不测：BrowserLeaks 级完整 DNS 泄漏证明。
        </li>
        <li>
          <strong>IPv6 泄漏</strong>：直连 vs mixed-port 的 IPv6 出口对照（短超时）。
          不测：内核/全部应用 IPv6 路径。
        </li>
        <li>
          <strong>WebRTC</strong>：WebView 内 STUN/ICE 候选短时收集。
          不测：系统浏览器策略、完整泄漏矩阵；无 RTC API 时仅表示测不了。
        </li>
        <li>
          <strong>出口 IP</strong>：经代理查 ip-api（国家/ISP/机房粗标）。
          不测：所有出口、WebRTC 反射地址是否一致。
        </li>
        <li>
          <strong>Gemini / ChatGPT</strong>：网页相关路径粗检，换节点对照用。
          不测：官方手机 App 真机体验、Mac 桌面客户端（会标明未单独检测）。
        </li>
        <li>
          <strong>延迟采样</strong>：单次轻量 HTTPS RTT。
          不测：抖动/丢包统计（节点页「快速延迟」更合适）。
        </li>
        <li>
          <strong>抽样带宽</strong>：约 1MiB 下 + 512KiB 上经 mixed-port。
          不测：全网测速、面板延迟、多线程压测。
        </li>
        <li>
          <strong>分流抽检</strong>：少量国内/境外域名经代理可达性 + 可选 /rules 计数与延迟粗对照。
          不测：完整规则审计、GEOIP 库、全部域名匹配。
        </li>
        <li>
          <strong>裸奔粗检</strong>：境外探测「mixed-port vs 真直连」；代理失败且直连仍通 → 可能裸奔。
          不测：TUN 内核状态、系统代理开关、各 App 是否各自走代理。
        </li>
      </ul>

      <h2>流量提示</h2>
      <p className="muted">
        「快速延迟」几乎不消耗流量。抽样带宽与未来的深度 / 优选测速会下载测速文件并可能切换节点，请注意流量与费用。
      </p>

      <h2>v0.2 说明</h2>
      <p className="muted">
        v0.2 加强真实性：DNS（scutil）、IPv6 对照、WebRTC STUN、抽样带宽，以及分流抽检 / 裸奔粗检。
        仍有 WebView / 超时 / 无法窥视 TUN 等边界；结果用于换节点对照，不是完整安全鉴定报告。
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
