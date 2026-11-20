// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A pretend internet: "sneaky.test" is a public-looking name that points at
// this machine, the trick a hostile website would use.
vi.mock("node:dns", async (original) => {
  const real = await original<typeof import("node:dns")>();
  const lookup = (
    hostname: string,
    options: unknown,
    callback: (err: Error | null, addresses: { address: string; family: number }[]) => void,
  ) => {
    if (hostname === "sneaky.test") return callback(null, [{ address: "127.0.0.1", family: 4 }]);
    return (real.lookup as unknown as (...args: unknown[]) => void)(hostname, options, callback);
  };
  return { ...real, default: { ...real, lookup }, lookup };
});

import { download, isPrivateAddress } from "./web";

let server: Server;
let port = 0;
let hits = 0;
beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.end("secret from inside the server");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe("isPrivateAddress", () => {
  it("refuses this machine, private networks and cloud metadata", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1", // IPv4 written as IPv6
      "::ffff:7f00:1", // the same, in hex
      "::ffff:a9fe:a9fe", // 169.254.169.254 in hex
      "64:ff9b::7f00:1", // NAT64 form of 127.0.0.1
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "104.18.2.3", "2606:4700::1111", "41.33.1.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("download", () => {
  it("never reaches this machine, however the address is written", async () => {
    for (const address of [
      `http://127.0.0.1:${port}/`,
      `http://localhost:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      `http://sneaky.test:${port}/`, // a public-looking name pointing at this machine
      `file:///etc/passwd`,
    ]) {
      const err = await download(address, { accept: "*/*" }).then(
        () => null,
        (e: Error & { cause?: Error }) => e,
      );
      // Refused by the protection, not failing for some other reason.
      const reason = `${err?.message} ${err?.cause?.message ?? ""}`;
      expect(reason, address).toMatch(/refused/);
    }
    expect(hits).toBe(0);
  });
});
