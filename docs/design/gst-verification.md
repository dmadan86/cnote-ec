# GST verification and company profile

Implements ADR-003 (T1 verification, continuous trust) and ADR-010 (PAN is sensitive: encrypted at rest, masked in every read).
Code: `packages/identity/src/gst/**`.

## Research summary

- **There is no open public GSTN API.** Taxpayer search on the GST portal is captcha-gated and not licensed for automation. Programmatic access goes through a GST Suvidha Provider (GSP) or a KYC/KYB vendor that wraps GSTN data.
- **Cashfree Verification Suite, GSTIN API.** `POST https://api.cashfree.com/verification/gstin` (sandbox: `sandbox.cashfree.com`), headers `x-client-id`, `x-client-secret`, body `{ GSTIN, business_name? }`. Response: `valid`, `legal_name_of_business`, `trade_name_of_business`, `gst_in_status`, `date_of_registration`, `taxpayer_type`, `constitution_of_business`, `center_jurisdiction`, `state_jurisdiction`, `principal_place_address`, `principal_place_split_address{city,state,pincode,...}`, `nature_of_business_activities`. Errors: 400 invalid GSTIN, 401/403 auth or IP allow-list, 422 `insufficient_balance`, 429 `too_many_requests_per_operation`. Prepaid balance model, charged per successful call. No return-filing data in this endpoint.
- **Surepass.** Bearer-token REST at `kyc-api.surepass.io` (GST verification, "GST return status", "GST monitoring", mobile-to-GST, GST certificate). Filing status is a separate paid product. Public pages do not publish schemas or prices; they are shared after signup. The adapter's field names (`data.legal_name`, `business_name`, `gstin_status`, `constitution_of_business`, `address`) follow their documented `data` object and must be confirmed against the account's docs before go-live (`parseSurepass` is the single place to adjust).
- **Others.** Signzy, Karza/Perfios, Masters India, ClearTax/Cygnet (GSPs) offer equivalent taxpayer-search and return-status APIs, contract-priced. Any of them fits the `GstnProvider` port.
- **Pricing/limits.** All are per-call, prepaid or contract; none publish rate limits openly beyond a 429. We therefore cache nothing sensitive, rely on one check at verification plus one monthly re-check per business (spread across the month), and use a Redis circuit breaker.
- **PAN linkage.** GSTIN = 2-digit state code + 10-char PAN + entity number + `Z` + checksum, so chars 3-12 are the holder's PAN. We enforce equality when both are known.
- **MCA / CIN.** CIN is 21 chars, regex `^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$` (listing, NIC industry, state, year, ownership, serial). Lookup options: MCA master data (gated), vendors (Surepass MCA Data API v3, Signzy, Karza, Tofler), open-government-data mirrors. Phase 1 validates the format only; a vendor CIN lookup can be added as a second adapter.

## Design

`GstnProvider.lookup(gstin, { businessName? }) -> GstnRecord | null` (null = not found; infrastructure failures throw `GstnProviderError`).
Adapters: `mock` (dev/CI, default), `cashfree`, `surepass`. Env: `GST_PROVIDER`, `GST_PROVIDER_KEY` (Cashfree client id / Surepass token), `GST_PROVIDER_SECRET`, `GST_PROVIDER_BASE_URL`, `GST_PROVIDER_TIMEOUT_MS` (8000), `GST_PROVIDER_FILINGS=1` (Surepass return status). HTTP: timeout, 2 retries with jittered backoff on timeout/5xx, Redis circuit breaker (5 failures in 60 s opens it for 60 s; Redis outage never blocks).

Mock behaviour is keyed on the 13th GSTIN character: `C` cancelled, `S` suspended, `M` name mismatch, `N` not found, `U` provider unavailable, `F` poor filing; otherwise Active, echoing the declared name. `createMockGstnProvider().setFixture()` pins exact records in tests.

### Checks (`evaluateGstChecks`, pure)

| check | weight | rule |
|---|---|---|
| status | 30 | Active, else hard fail |
| name | 30 | token-set similarity after normalising M/S, PVT LTD / PRIVATE LIMITED / LLP, punctuation. >= 0.85 pass; 0.6-0.85 review; < 0.6 fail. Best of legalName / tradeName / Business.name vs provider legal and trade name |
| state | 10 | GSTIN state code == registered-address state code; mismatch or missing goes to review |
| pan | 15 | declared PAN == GSTIN chars 3-12; mismatch is a hard fail; skipped if PAN not declared |
| filing | 10 | GSTR-3B for the last 6 periods when the provider returns it (>=5 pass, >=3 warn, else fail); evidence only, never gates |
| hsn | 5 | listing HSN 4-digit prefixes vs registration HSNs; hint only |

Decision: any hard fail -> `failed`; else name/state warning -> `review`; else `passed`. Score = weighted share of the checks that ran (0-100).
Outcomes: passed -> tier >= 1, `gstStatus/gstVerifiedAt/gstLastCheckedAt`, `VerificationRecord(passed, details = snapshot + checks)`, `BusinessVerified`. Review -> `VerificationRecord(pending)`, resolved by `resolveGstReview(id, approved|rejected, staffId)` (admin: `businesses.verify`, audited). Failed -> record with reasons. Provider outage -> `unavailable`, nothing written.

### Continuous verification

Daily worker job `identity.gst-recheck`: a business is due when the last check is >= 30 days old and its stable hash bucket (0-29) equals today's day-of-cycle (or it is >= 40 days overdue). Cancelled/Suspended/not found: tier -> 0, `gstVerifiedAt` cleared, `BusinessVerified{tier:0, kind:"gstin_revoked"}`, then trust recompute (badge off, `TrustScoreChanged`).

### PAN at rest

`business.pan` holds `encryptField(pan, "business.pan:<businessId>")` (@cnote/security envelope encryption). Reads return `XXXXX1234F` only.
