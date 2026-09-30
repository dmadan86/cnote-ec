// Structured quote terms shown in the quote form and quote list (mirrors @cnote/enquiry's enums; kept local so client components don't import the module).
export const DELIVERY_TERMS = ["ex_works", "fob", "door_delivery", "buyer_pickup", "other"] as const;
export const PAYMENT_TERMS = ["advance", "on_delivery", "net_7", "net_15", "net_30", "escrow", "other"] as const;
