export const KEY = "ck_live_testsecret";
export const P = { keyId: "k1", personId: "p1", businessId: "b1" as string | null, scopes: ["search:read", "enquiries:write", "catalogue:read"] as string[] };
export const state = { principal: { ...P } as typeof P | null, verifyThrows: null as unknown };

export const auth = (secret = KEY) => ({ headers: { authorization: `Bearer ${secret}` } });
export const jsonReq = (body: unknown, secret = KEY) => ({
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify(body),
});
export const resetPrincipal = (scopes: string[], businessId: string | null = "b1") => {
  state.principal = { ...P, scopes, businessId };
  state.verifyThrows = null;
};
