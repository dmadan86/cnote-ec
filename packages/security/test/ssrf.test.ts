import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a: unknown[]) => lookup(...a) }));

const { assertPublicHttpUrl, isPrivateAddress, setSecurityEventSink } = await import("../src");

const events: { type: string; data: Record<string, unknown> }[] = [];
beforeEach(() => {
  lookup.mockReset();
  events.length = 0;
  setSecurityEventSink((e) => events.push(e));
});

describe("isPrivateAddress: IPv4", () => {
  const priv = [
    "0.0.0.0", "0.1.2.3", "10.0.0.0", "10.255.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1",
    "172.16.0.0", "172.31.255.255", "192.168.0.1", "192.168.255.255", "100.64.0.1", "100.127.255.255", "192.0.0.8", "192.0.2.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  ];
  const pub = ["8.8.8.8", "1.1.1.1", "9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "169.253.1.1", "100.63.255.255", "100.128.0.0", "192.169.0.1", "198.17.0.1", "198.20.0.1", "223.255.255.255", "126.255.255.255", "128.0.0.1"];
  it.each(priv)("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(pub)("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("isPrivateAddress: IPv6", () => {
  const priv = [
    "::", "::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::0",
    "fc00::", "fd12:3456::1", "fdff:ffff::1", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "ff02::1", "ff00::",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:101",
    "::127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::169.254.169.254", "2002:7f00:1::", "2002:a9fe:a9fe::1",
  ];
  const pub = ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1", "fbff::1", "fe00::1"];
  it.each(priv)("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(pub)("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("isPrivateAddress: non-canonical / garbage input fails closed", () => {
  it.each(["2130706433", "0177.0.0.1", "0x7f.0.0.1", "127.1", "localhost", "", "not-an-ip", "1.2.3", "1.2.3.4.5", "256.1.1.1", "::g", "[::1]", "127.0.0.1 ", " 8.8.8.8"])("%j is treated as private", (x) => expect(isPrivateAddress(x)).toBe(true));
});

describe("assertPublicHttpUrl", () => {
  const blocked = [
    // schemes
    "http://example.com", "ftp://example.com/x", "file:///etc/passwd", "gopher://example.com", "javascript:alert(1)", "data:text/html,x", "nonsense", "", "//example.com",
    // credentials
    "https://user@example.com", "https://user:pw@example.com", "https://:pw@example.com",
    // local names
    "https://localhost", "https://LOCALHOST/x", "https://localhost./x", "https://foo.localhost", "https://metadata.google.internal/computeMetadata/v1/", "https://svc.internal", "https://printer.local", "https://foo.internal./x",
    // IPv4 in every notation (WHATWG URL normalises these to dotted quads)
    "https://127.0.0.1", "https://2130706433", "https://0x7f000001", "https://0177.0.0.1", "https://0x7f.1", "https://127.1", "https://017700000001", "https://0", "https://0.0.0.0",
    "https://169.254.169.254/latest/meta-data/", "https://2852039166/", "https://0xa9fea9fe/", "https://10.0.0.1", "https://192.168.1.1:8443", "https://100.100.100.200/",
    // IPv6
    "https://[::1]/", "https://[0:0:0:0:0:0:0:1]/", "https://[::]/", "https://[fd00::1]/", "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/",
    "https://[::ffff:169.254.169.254]/", "https://[64:ff9b::a9fe:a9fe]/", "https://[2002:a9fe:a9fe::]/", "https://[ff02::1]/",
  ];
  it.each(blocked)("blocks %j", async (u) => {
    lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]); // a public DNS answer must not rescue an IP-literal / forbidden name
    await expect(assertPublicHttpUrl(u, { allowHttp: false })).rejects.toMatchObject({ code: "validation", message: "That URL is not allowed." });
    expect(events.at(-1)?.type).toBe("ssrf.blocked");
  });

  it("http is only allowed with allowHttp, and only for public hosts", async () => {
    await expect(assertPublicHttpUrl("http://8.8.8.8/x")).rejects.toThrow("not allowed");
    expect((await assertPublicHttpUrl("http://8.8.8.8/x", { allowHttp: true })).href).toBe("http://8.8.8.8/x");
    await expect(assertPublicHttpUrl("http://127.0.0.1/x", { allowHttp: true })).rejects.toThrow("not allowed");
  });

  it("allows public IP literals (v4 and v6) without DNS", async () => {
    expect((await assertPublicHttpUrl("https://8.8.8.8/x")).hostname).toBe("8.8.8.8");
    expect((await assertPublicHttpUrl("https://[2606:4700:4700::1111]/")).hostname).toBe("[2606:4700:4700::1111]");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves hostnames and blocks when ANY answer is private (DNS rebinding / mixed A records)", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    expect((await assertPublicHttpUrl("https://example.com/path?q=1")).pathname).toBe("/path");
    expect(lookup).toHaveBeenCalledWith("example.com", { all: true });

    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    await expect(assertPublicHttpUrl("https://rebind.example.com")).rejects.toThrow("not allowed");
    lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(assertPublicHttpUrl("https://169-254-169-254.nip.io")).rejects.toThrow("not allowed");
    lookup.mockResolvedValue([{ address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(assertPublicHttpUrl("https://evil.example.com")).rejects.toThrow("not allowed");
    lookup.mockResolvedValue([{ address: "::ffff:7f00:1", family: 6 }]);
    await expect(assertPublicHttpUrl("https://evil2.example.com")).rejects.toThrow("not allowed");
  });

  it("unresolvable hostnames and resolver failures are blocked (fail closed)", async () => {
    lookup.mockResolvedValue([]);
    await expect(assertPublicHttpUrl("https://nx.example.com")).rejects.toThrow("not allowed");
    lookup.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(assertPublicHttpUrl("https://nx2.example.com")).rejects.toThrow("not allowed");
  });

  it("logs a reason and truncates the URL in the event; never leaks credentials in the message", async () => {
    await expect(assertPublicHttpUrl("https://user:hunter2@example.com/" + "a".repeat(500))).rejects.toThrow("not allowed");
    const e = events.at(-1)!;
    expect(e.data.why).toBe("credentials");
    expect((e.data.url as string).length).toBeLessThanOrEqual(200);
  });

  it("returns the parsed URL unchanged for a good target (query, port, path preserved)", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const u = await assertPublicHttpUrl("https://hooks.example.com:8443/a/b?x=1#f");
    expect(u.port).toBe("8443");
    expect(u.search).toBe("?x=1");
  });
});
