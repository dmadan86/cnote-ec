const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

/** Integer paise as plain text for message parameters, e.g. 117882 -> "₹1,178.82", 99900 -> "₹999". */
export const formatPaise = (paise: number): string => (paise % 100 === 0 ? inr.format(paise / 100).replace(/\.00$/, "") : inr.format(paise / 100));
