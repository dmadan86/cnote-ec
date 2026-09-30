import { describe, expect, it } from "vitest";
import { VideoFrameError, checkVideoFile, frameCount, frameTimes } from "../src/features/quality/video-frames";

const L = { minFrames: 3, maxFrames: 6, maxSeconds: 30, maxBytes: 25 * 1024 * 1024 };

describe("video frame sampling", () => {
  it("picks 3 to 6 frames, one per ~5 s", () => {
    expect([1, 5, 10, 15, 16, 25, 30, 45].map((d) => frameCount(d, L))).toEqual([3, 3, 3, 3, 4, 5, 6, 6]);
    for (let d = 0.1; d <= 30; d += 0.37) {
      expect(frameCount(d, L)).toBeGreaterThanOrEqual(3);
      expect(frameCount(d, L)).toBeLessThanOrEqual(6);
    }
  });

  it("samples strictly increasing, evenly spaced times inside the clip", () => {
    for (const d of [0.5, 3.3, 10, 17.9, 30]) for (const n of [3, 4, 5, 6]) {
      const t = frameTimes(d, n);
      expect(t).toHaveLength(n);
      for (let i = 0; i < n; i++) { expect(t[i]).toBeGreaterThan(0); expect(t[i]).toBeLessThan(d); if (i) expect(t[i]).toBeGreaterThan(t[i - 1]!); }
      const gaps = t.slice(1).map((x, i) => x - t[i]!);
      for (const g of gaps) expect(g).toBeCloseTo(d / n, 6);
    }
    expect(frameTimes(30, 6)).toEqual([2.5, 7.5, 12.5, 17.5, 22.5, 27.5]);
  });

  it("rejects non-video and over-size files before decoding", () => {
    expect(() => checkVideoFile({ type: "image/png", size: 10 }, L)).toThrowError(expect.objectContaining({ code: "format" }));
    expect(() => checkVideoFile({ type: "video/mp4", size: L.maxBytes + 1 }, L)).toThrowError(expect.objectContaining({ code: "tooLarge" }));
    expect(() => checkVideoFile({ type: "video/mp4", size: L.maxBytes }, L)).not.toThrow();
    expect(new VideoFrameError("tooLong").code).toBe("tooLong");
  });
});
