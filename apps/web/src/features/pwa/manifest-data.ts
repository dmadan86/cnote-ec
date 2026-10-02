/** Brand colours of the web app manifest, taken from the design tokens (packages/ui/src/styles.css). */
export const PWA_THEME_COLOR = "#6d3ff0"; // --color-brand-600 (also the <meta name="theme-color"> in the root layout)
export const PWA_BACKGROUND_COLOR = "#f8f9fc"; // --color-canvas

export interface PwaIcon {
  /** File name under /icons/. */
  file: string;
  size: number;
  maskable: boolean;
}

export const PWA_ICONS: readonly PwaIcon[] = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
  { file: "apple-touch-icon.png", size: 180, maskable: false },
];
