import { describe, it, expect } from "vitest";
import type { CheckCard, CheckLevel } from "./types";
import {
  summarizeServiceCards,
  formatMemberUnlockLine,
  extractUnlockRegion,
  isServiceSummaryId,
} from "./serviceSummary";

function card(
  id: string,
  title: string,
  level: CheckLevel,
  conclusion: string,
  metrics?: CheckCard["metrics"],
): CheckCard {
  return { id, title, level, conclusion, metrics };
}

describe("summarizeServiceCards", () => {
  it("合成流媒体 / AI / 商店三张汇总，去掉单项", () => {
    const cards: CheckCard[] = [
      card("reachability", "连通性", "pass", "通"),
      card("gemini", "Gemini", "pass", "可用（US）", {
        unlockSupported: true,
        unlockRegion: "US",
      }),
      card("chatgpt", "ChatGPT", "fail", "不可用", { unlockSupported: false }),
      card("netflix", "Netflix", "pass", "可用（JP）"),
      card("disney", "Disney+", "fail", "不可用（地区限制）"),
      card("youtube", "YouTube Premium", "pass", "可用"),
      card("app-store", "App Store", "pass", "可用"),
      card("google-play", "Google Play", "pass", "可用"),
    ];
    const out = summarizeServiceCards(cards);
    expect(out.map((c) => c.id)).toEqual([
      "reachability",
      "svc-streaming",
      "svc-ai",
      "svc-store",
    ]);
    const ai = out.find((c) => c.id === "svc-ai")!;
    expect(ai.title).toBe("AI");
    expect(ai.level).toBe("warn");
    expect(ai.conclusion).toContain("Gemini：通 · US");
    expect(ai.conclusion).toContain("ChatGPT：不通");
    expect(ai.process).toBeUndefined();

    const stream = out.find((c) => c.id === "svc-streaming")!;
    expect(stream.level).toBe("warn");
    expect(stream.conclusion).toContain("Netflix：通 · JP");
    expect(stream.conclusion).toContain("Disney+：不通");

    const store = out.find((c) => c.id === "svc-store")!;
    expect(store.level).toBe("pass");
    expect(store.conclusion).toContain("App Store：通");
    expect(store.conclusion).not.toContain("App Store：通 ·");
  });

  it("全通 / 全不通 / 检测中", () => {
    expect(
      summarizeServiceCards([
        card("gemini", "Gemini", "pass", "可用"),
        card("chatgpt", "ChatGPT", "pass", "可用"),
      ])[0].level,
    ).toBe("pass");
    expect(
      summarizeServiceCards([
        card("gemini", "Gemini", "fail", "不可用"),
        card("chatgpt", "ChatGPT", "fail", "不可用"),
      ])[0].level,
    ).toBe("fail");
    expect(
      summarizeServiceCards([
        card("gemini", "Gemini", "running", "检测中…"),
        card("chatgpt", "ChatGPT", "pass", "可用"),
      ])[0].level,
    ).toBe("running");
    const untested = summarizeServiceCards([
      card("gemini", "Gemini", "unknown", "尚未检测"),
      card("chatgpt", "ChatGPT", "unknown", "尚未检测"),
    ])[0];
    expect(untested.level).toBe("unknown");
    expect(untested.metrics?.unlockLevel).toBe("未测");
  });

  it("仅部分成员时仍合成对应组", () => {
    const out = summarizeServiceCards([
      card("netflix", "Netflix", "pass", "可用"),
      card("youtube", "YouTube Premium", "pass", "可用"),
      card("spotify", "Spotify", "pass", "可用（US）"),
      card("chatgpt", "ChatGPT", "pass", "可用"),
      card("gemini", "Gemini", "pass", "可用"),
    ]);
    expect(out.map((c) => c.id)).toEqual(["svc-streaming", "svc-ai"]);
    expect(out.find((c) => c.id === "svc-store")).toBeUndefined();
    expect(out.find((c) => c.id === "svc-streaming")!.conclusion).toContain(
      "Spotify：通 · US",
    );
  });

  it("流媒体汇总纳入 TikTok / Spotify / Prime Video", () => {
    const out = summarizeServiceCards([
      card("netflix", "Netflix", "pass", "可用"),
      card("tiktok", "TikTok", "pass", "可用（JP）"),
      card("spotify", "Spotify", "fail", "不可用（地区限制）"),
      card("prime-video", "Prime Video", "pass", "可用（US）"),
    ]);
    const stream = out.find((c) => c.id === "svc-streaming")!;
    expect(stream.level).toBe("warn");
    expect(stream.conclusion).toContain("TikTok：通 · JP");
    expect(stream.conclusion).toContain("Spotify：不通");
    expect(stream.conclusion).toContain("Prime Video：通 · US");
  });

  it("幂等：已是汇总卡不再拆", () => {
    const once = summarizeServiceCards([
      card("netflix", "Netflix", "pass", "可用"),
      card("disney", "Disney+", "pass", "可用"),
    ]);
    expect(summarizeServiceCards(once)).toEqual(once);
    expect(isServiceSummaryId("svc-streaming")).toBe(true);
  });
});

describe("formatMemberUnlockLine / extractUnlockRegion", () => {
  it("优先 metrics.region，其次 conclusion 括号", () => {
    expect(
      extractUnlockRegion(
        card("chatgpt", "ChatGPT", "pass", "可用（US）", {
          unlockRegion: "JP",
        }),
      ),
    ).toBe("JP");
    expect(extractUnlockRegion(card("netflix", "Netflix", "pass", "可用（TW）"))).toBe(
      "TW",
    );
    expect(formatMemberUnlockLine(card("gemini", "Gemini", "warn", "可用"))).toBe(
      "Gemini：通",
    );
  });
});
