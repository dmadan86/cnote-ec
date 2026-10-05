// A tiny software WebAuthn authenticator (ES256, "none" attestation) for tests: produces the same JSON a browser's
// navigator.credentials.create()/get() would, so the real @simplewebauthn/server verification code is exercised.
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | Buffer | string) => createHash("sha256").update(b).digest();

export interface SoftwareAuthenticatorOpts {
  origin: string;
  rpID: string;
  /** Start value of the signature counter (default 0; most platform authenticators send 0 forever). */
  counter?: number;
  /** Flip off to model an authenticator that does not verify the user. */
  userVerified?: boolean;
}

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  counter: number;
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  constructor(public opts: SoftwareAuthenticatorOpts) {
    this.counter = opts.counter ?? 0;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x!, "base64url");
    this.y = Buffer.from(jwk.y!, "base64url");
  }

  private flags(extra: number) {
    return 0x01 | (this.opts.userVerified === false ? 0 : 0x04) | extra; // UP | UV?
  }
  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin = this.opts.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Response for options returned by generateRegistrationOptions (challenge is the base64url string in the options). */
  register(challenge: string, o: { rpID?: string; origin?: string } = {}) {
    const rpID = o.rpID ?? this.opts.rpID;
    const coseKey = isoCBOR.encode(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(this.x)], [-3, new Uint8Array(this.y)]]) as never);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(rpID), Buffer.from([this.flags(0x40)]), ctr, Buffer.alloc(16), idLen, this.credentialId, Buffer.from(coseKey)]);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]) as never);
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key" as const,
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", challenge, o.origin)),
        attestationObject: b64u(attestationObject),
        transports: ["internal" as const],
      },
    };
  }

  /** Response for options returned by generateAuthenticationOptions. `counter` overrides the next counter value. */
  assert(challenge: string, o: { counter?: number; rpID?: string; origin?: string; tamper?: boolean } = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(o.rpID ?? this.opts.rpID), Buffer.from([this.flags(0)]), ctr]);
    const clientDataJSON = this.clientData("webauthn.get", challenge, o.origin);
    const sig = createSign("sha256").update(Buffer.concat([authData, sha256(clientDataJSON)])).sign(this.privateKey);
    if (o.tamper) sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 0xff;
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: undefined },
    };
  }
}
