// Display labels for variant facet keys (lower-cased "axis:value"). Axis and value text is seller/category data in one language, so it is
// shown as given with simple casing; there is deliberately no translation table (categories define their own axes).
export const variantAxisLabel = (axis: string): string => axis.replace(/_/g, " ").replace(/^\p{L}/u, (c) => c.toUpperCase());
export const variantValueLabel = (value: string): string => value.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
