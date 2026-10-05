import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClamdAttachmentScanner, EICAR_TEST_STRING, MockAttachmentScanner, ScanUnavailableError, getAttachmentScanner, parseClamdReply, scannerKind, setAttachmentScannerForTests,
} from "../src/index";

afterEach(() => setAttachmentScannerForTests(null));

describe("MockAttachmentScanner", () => {
  const s = new MockAttachmentScanner();
  it("flags EICAR, also when embedded in other bytes", async () => {
    expect(await s.scan(Buffer.from(EICAR_TEST_STRING))).toEqual({ status: "infected", signature: "Eicar-Test-Signature" });
    expect(await s.scan(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(EICAR_TEST_STRING), Buffer.from("\n%%EOF")]))).toMatchObject({ status: "infected" });
  });
  it("passes ordinary files", async () => {
    expect(await s.scan(Buffer.from("%PDF-1.4 hello"))).toEqual({ status: "clean" });
    expect(await s.scan(new Uint8Array(0))).toEqual({ status: "clean" });
  });
});

describe("parseClamdReply", () => {
  it("parses OK, FOUND and errors", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ status: "clean" });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1" });
    expect(() => parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toThrow(ScanUnavailableError);
    expect(() => parseClamdReply("")).toThrow(ScanUnavailableError);
  });
});

/** A fake clamd: reads zINSTREAM + length-prefixed chunks until the zero chunk, then answers with `reply(bytesReceived)`. */
function fakeClamd(reply: (received: Buffer) => string | null, onCommand?: (cmd: string) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let sawCommand = false;
      const received: Buffer[] = [];
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (!sawCommand) {
          const nul = buf.indexOf(0);
          if (nul < 0) return;
          onCommand?.(buf.subarray(0, nul).toString());
          buf = buf.subarray(nul + 1);
          sawCommand = true;
        }
        for (;;) {
          if (buf.length < 4) return;
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            const r = reply(Buffer.concat(received));
            if (r !== null) sock.end(r);
            return;
          }
          if (buf.length < 4 + len) return;
          received.push(buf.subarray(4, 4 + len));
          buf = buf.subarray(4 + len);
        }
      });
      sock.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

describe("ClamdAttachmentScanner (fake clamd over TCP)", () => {
  it("speaks INSTREAM: command, chunked payload, terminator; returns clean", async () => {
    let cmd = "";
    let got: Buffer = Buffer.alloc(0);
    const clamd = await fakeClamd((b) => { got = b; return "stream: OK\0"; }, (c) => { cmd = c; });
    const payload = Buffer.alloc(200_000, 7);
    const s = new ClamdAttachmentScanner({ host: "127.0.0.1", port: clamd.port, chunkBytes: 65_536 });
    expect(await s.scan(payload)).toEqual({ status: "clean" });
    expect(cmd).toBe("zINSTREAM");
    expect(got.equals(payload)).toBe(true);
    await clamd.close();
  });

  it("reports an infection with its signature", async () => {
    const clamd = await fakeClamd(() => "stream: Eicar-Signature FOUND\0");
    const s = new ClamdAttachmentScanner({ host: "127.0.0.1", port: clamd.port });
    expect(await s.scan(Buffer.from(EICAR_TEST_STRING))).toEqual({ status: "infected", signature: "Eicar-Signature" });
    await clamd.close();
  });

  it("scans an empty file", async () => {
    const clamd = await fakeClamd(() => "stream: OK\0");
    expect(await new ClamdAttachmentScanner({ host: "127.0.0.1", port: clamd.port }).scan(new Uint8Array(0))).toEqual({ status: "clean" });
    await clamd.close();
  });

  it("fails closed on a clamd error reply, a silent close, a refused connection and a timeout", async () => {
    const err = await fakeClamd(() => "INSTREAM size limit exceeded. ERROR\0");
    await expect(new ClamdAttachmentScanner({ host: "127.0.0.1", port: err.port }).scan(Buffer.from("x"))).rejects.toBeInstanceOf(ScanUnavailableError);
    await err.close();

    const silent = await fakeClamd(() => "");
    await expect(new ClamdAttachmentScanner({ host: "127.0.0.1", port: silent.port }).scan(Buffer.from("x"))).rejects.toThrow(/without a reply/);
    await silent.close();

    const closed = await fakeClamd(() => "stream: OK\0");
    const port = closed.port;
    await closed.close();
    await expect(new ClamdAttachmentScanner({ host: "127.0.0.1", port }).scan(Buffer.from("x"))).rejects.toThrow(/connection error/);

    const hang = await fakeClamd(() => null);
    await expect(new ClamdAttachmentScanner({ host: "127.0.0.1", port: hang.port, timeoutMs: 150 }).scan(Buffer.from("x"))).rejects.toThrow(/timed out/);
    await hang.close();
  });
});

describe("getAttachmentScanner", () => {
  it("defaults to the mock, builds clamav from env, and refuses clamav without a host", () => {
    expect(scannerKind({})).toBe("mock");
    expect(scannerKind({ ATTACHMENT_SCANNER: " ClamAV " })).toBe("clamav");
    expect(scannerKind({ ATTACHMENT_SCANNER: "off" })).toBe("mock");
    expect(getAttachmentScanner({}).name).toBe("mock");
    expect(getAttachmentScanner({ ATTACHMENT_SCANNER: "clamav", CLAMAV_HOST: "clam.internal", CLAMAV_PORT: "3311" }).name).toBe("clamav");
    expect(() => getAttachmentScanner({ ATTACHMENT_SCANNER: "clamav" })).toThrow(ScanUnavailableError);
  });
  it("honours the test override", async () => {
    setAttachmentScannerForTests({ name: "stub", scan: async () => ({ status: "infected", signature: "X" }) });
    expect(await getAttachmentScanner().scan(new Uint8Array(1))).toEqual({ status: "infected", signature: "X" });
  });
});
