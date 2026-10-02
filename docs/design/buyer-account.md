# Buyer business profile, GSTIN and delivery addresses

Page: `/account/business` (apps/web). Business is one entity for buyer and seller roles (ADR-007), so everything here is
the same `Business` row the seller app uses.

## GSTIN (ADR-003, T1)

- `verifyGstin(businessId, gstin)` in `@cnote/identity` runs the structure + checksum test, then the GST provider port
  (`GST_PROVIDER`, mock in dev and e2e). On success it applies tier 1, stores `legalName` (when empty), `gstStatus`,
  `gstVerifiedAt`, and returns `{ passed, tier, legalName, state }`. A provider outage returns `passed: false` and writes
  no failed `VerificationRecord`.
- `getBuyerBusinessProfile(businessId)` is the read model for the page (GSTIN, legal name, state from the GSTIN prefix, GST
  status, tier).
- Storage mirrors sellers: GSTIN is a plain, unique column on `Business` (it is a public tax identifier, not field-encrypted).
- Lookups are rate limited to 10 per hour per person in the web action.

## Saved delivery addresses

Model `BusinessAddress` (identity schema). Functions in `@cnote/identity`: `listAddresses`, `addAddress`, `updateAddress`,
`setDefaultAddress`, `deleteAddress` (max 10 per business; the first address is the default; deleting the default promotes
the newest remaining one). The pincode is validated (`^[1-9]\d{5}$`); the **state is derived from the pincode in the web
action** (`@cnote/prices` India Post PIN table, which identity may not depend on) and validated against the GST state table
inside identity, so a forged state is never stored.

### Prefilling the RFQ delivery pincode (for the RFQ form owner)

```ts
import { getDefaultDeliveryPincode, listAddresses } from "@cnote/identity";
const pincode = await getDefaultDeliveryPincode(session.business.id); // string | null
```

`listAddresses(businessId)` returns `DeliveryAddress[]` (default first) if the form wants a chooser.

### Header "Deliver to" picker

When signed in, the popover fetches `GET /api/account/addresses` (private, no-store; `{ addresses: [{ id, label, city,
pincode, isDefault }] }`) and offers them above the manual pincode field. Choosing one writes the existing `cnote_pincode`
cookie. Signed-out users never trigger the request and the static header HTML contains nothing personal.

## DPDP

- `exportPersonalData` includes `deliveryAddresses` (and the GSTIN / legal name inside `businesses[]`).
- `erasePerson` deletes the saved addresses of businesses the person alone belongs to, and clears GSTIN, Udyam, PAN, legal
  name and registered address on those that are not sellers (tier reset to 0). Seller businesses keep their tax identifiers:
  invoice and trust-record retention outranks erasure (DPDP s.8(7), ADR-010). Businesses shared with other members are untouched.
