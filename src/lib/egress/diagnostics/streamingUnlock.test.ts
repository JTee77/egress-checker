import { describe, it, expect } from "vitest";
import {
  classifyTikTokStatus,
  extractTikTokRegion,
  extractSpotifyRegion,
  extractPrimeVideoRegion,
  tikTokVerdict,
  primeVideoVerdict,
} from "./streamingUnlock";

describe("TikTok unlock heuristics（连通/可见，非硬解锁）", () => {
  it("403/451 → no；非 2xx → failed；拦截文案 → no；否则 yes", () => {
    expect(classifyTikTokStatus(403, "ok")).toBe("no");
    expect(classifyTikTokStatus(451, "")).toBe("no");
    expect(classifyTikTokStatus(500, "x")).toBe("failed");
    expect(classifyTikTokStatus(200, "Access Denied")).toBe("no");
    expect(classifyTikTokStatus(200, "not available in your region")).toBe("no");
    expect(classifyTikTokStatus(200, "TikTok is not available here")).toBe("no");
    expect(classifyTikTokStatus(200, "welcome")).toBe("yes");
  });

  it("解析 region JSON 与 loc= trace", () => {
    expect(extractTikTokRegion('"region":"us-east"')).toBe("US");
    expect(extractTikTokRegion('"region" : "JP"')).toBe("JP");
    expect(
      extractTikTokRegion("fl=1\nh=www.tiktok.com\nloc=TW\ntls=TLSv1.3\n"),
    ).toBe("TW");
    expect(extractTikTokRegion("loc=XX\n")).toBeNull();
  });

  it("yes+区 → 警告角标，行内仍写可见；yes 无区 → warn；no → fail", () => {
    const withRegion = tikTokVerdict("yes", "JP");
    expect(withRegion?.level).toBe("warn");
    expect(withRegion?.conclusion).toBe("可见（JP）");
    expect(withRegion?.conclusion).not.toMatch(/已解锁/);
    expect(withRegion?.processNote).toMatch(/启发式|可见/);

    const noRegion = tikTokVerdict("yes", null);
    expect(noRegion?.level).toBe("warn");
    expect(noRegion?.conclusion).toMatch(/启发式/);

    const blocked = tikTokVerdict("no", "CN");
    expect(blocked?.level).toBe("fail");
    expect(blocked?.conclusion).toContain("不可用");

    expect(tikTokVerdict("failed", null)).toBeNull();
  });
});

describe("Spotify / Prime Video region extract", () => {
  it("Spotify countryCode", () => {
    expect(extractSpotifyRegion('{"countryCode":"hk"}')).toBe("HK");
    expect(extractSpotifyRegion('{"country":"DE"}')).toBe("DE");
    expect(extractSpotifyRegion("{}")).toBeNull();
  });

  it("Prime currentTerritory；无则 null", () => {
    expect(
      extractPrimeVideoRegion('window.__DATA__={"currentTerritory":"us"};'),
    ).toBe("US");
    expect(extractPrimeVideoRegion("isServiceRestricted")).toBeNull();
  });

  it("Prime：restricted→fail；有 territory→可见警告；可达无区→warn（启发式）", () => {
    expect(
      primeVideoVerdict({
        restricted: true,
        region: null,
        pageReachable: true,
      })?.level,
    ).toBe("fail");

    const visible = primeVideoVerdict({
      restricted: false,
      region: "US",
      pageReachable: true,
    });
    expect(visible?.level).toBe("warn");
    expect(visible?.conclusion).toBe("可见（US）");

    const weak = primeVideoVerdict({
      restricted: false,
      region: null,
      pageReachable: true,
    });
    expect(weak?.level).toBe("warn");
    expect(weak?.conclusion).toMatch(/无法确认区域|启发式/);
    expect(weak?.processNote).toMatch(/启发式/);

    expect(
      primeVideoVerdict({
        restricted: false,
        region: null,
        pageReachable: false,
      }),
    ).toBeNull();
  });
});
