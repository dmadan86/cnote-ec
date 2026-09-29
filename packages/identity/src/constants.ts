/** httpOnly cookies set by apps/web. Access = short-lived JWT; refresh = opaque, rotating. */
export const ACCESS_COOKIE = "cnote_at";
export const REFRESH_COOKIE = "cnote_rt";
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const JWT_ISSUER = "cnote";
