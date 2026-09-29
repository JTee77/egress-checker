import { describe, it, expect } from "vitest";
import {
  classifyTikTokStatus,
  extractTikTokRegion,
  extractSpotifyRegion,
  extractPrimeVideoRegion,
} from "./streamingUnlock";

describe("TikTok unlock heuristics (Verge-aligned)", () => {
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
});
