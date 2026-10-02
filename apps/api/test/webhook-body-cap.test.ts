import { describe, expect, it } from "vitest";
import { readBodyCapped } from "../src/lib/body";

// Regression (security audit): a chunked body with NO Content-Length used to be buffered whole by arrayBuffer() before the
// size check. The reader must abort as soon as the cap is crossed.
function streamOf(chunks: number, size: number, pulled: { n: number }): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(ctl) {
      if (i++ >= chunks) return ctl.close();
      pulled.n++;
      ctl.enqueue(new Uint8Array(size).fill(65));
    },
  });
}
const req = (body: ReadableStream<Uint8Array> | string, h: Record<string, string> = {}) =>
  new Request("http://x/webhooks/escrow/mock", { method: "POST", body, headers: h, ...(typeof body === "string" ? {} : { duplex: "half" }) } as RequestInit);

describe("readBodyCapped", () => {
  it("aborts a streamed body without Content-Length once the cap is crossed (does not read the rest)", async () => {
    const pulled = { n: 0 };
    const r = req(streamOf(1000, 1000, pulled));
    expect(await readBodyCapped(r, 5000)).toBeNull();
    expect(pulled.n).toBeLessThan(20);
  });
  it("rejects on a large declared Content-Length without reading", async () => {
    expect(await readBodyCapped(req("x", { "content-length": "999999" }), 1000)).toBeNull();
  });
  it("returns the bytes for an in-limit body and empty for no body", async () => {
    expect(Buffer.from((await readBodyCapped(req('{"a":1}'), 100))!).toString()).toBe('{"a":1}');
    expect((await readBodyCapped(new Request("http://x/", { method: "POST" }), 100))!.byteLength).toBe(0);
  });
});
