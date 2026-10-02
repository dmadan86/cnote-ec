// Contact link builders (pure; unit-tested in test/contact-links.test.ts). The inputs come from GET /api/contact/<listing>,
// i.e. only after the buyer unlocked the supplier. E.164 phone numbers only.

const E164 = /^\+[1-9]\d{7,14}$/;

/** `tel:` link, or null when the number is not valid E.164. */
export function telHref(phone: string | null | undefined): string | null {
  return phone && E164.test(phone) ? `tel:${phone}` : null;
}

/** `https://wa.me/<digits>?text=<message>`; wa.me takes the E.164 number without "+". */
export function whatsappHref(phone: string | null | undefined, message: string): string | null {
  if (!phone || !E164.test(phone)) return null;
  return `https://wa.me/${phone.slice(1)}?text=${encodeURIComponent(message.slice(0, 1000))}`;
}

/** `mailto:` link with subject and body, or null for an address that is clearly not one. */
export function mailtoHref(email: string | null | undefined, subject: string, body: string): string | null {
  if (!email || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)) return null;
  return `mailto:${email}?subject=${encodeURIComponent(subject.slice(0, 200))}&body=${encodeURIComponent(body.slice(0, 1000))}`;
}
