// Scoped stylesheet for the storefront renderer. Everything is under `.sf` and driven by the CSS variables from
// themeVars(), so a validated theme (AA contrast) is the only thing that controls colour. No text is ever drawn over
// an image, targets are >= 44px, and there is no motion. Layout responds to the renderer's own width (container
// queries), not the window, so the Studio's mobile preview and scaled thumbnails lay out exactly like a real phone/desktop.
export const STOREFRONT_CSS = `
.sf{container:sf/inline-size;background:var(--sf-bg);color:var(--sf-text);font-family:var(--sf-font);line-height:1.55;font-size:16px}
.sf *,.sf *::before,.sf *::after{box-sizing:border-box}
.sf a{color:var(--sf-primary);text-underline-offset:3px}
.sf :focus-visible{outline:3px solid var(--sf-primary);outline-offset:2px}
.sf-tone-brand :focus-visible{outline-color:var(--sf-on-primary)}
.sf-wrap{max-width:1120px;margin:0 auto;padding:0 16px}
.sf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sf h1,.sf h2,.sf h3,.sf p,.sf ul,.sf ol,.sf figure,.sf dl,.sf dd{margin:0}
.sf h1{font-size:clamp(1.9rem,5vw,3rem);line-height:1.1;font-weight:800;letter-spacing:-.02em}
.sf h2{font-size:clamp(1.35rem,3vw,1.75rem);line-height:1.2;font-weight:700;margin-bottom:20px}
.sf h3{font-size:1.05rem;line-height:1.3;font-weight:650}
.sf-muted{color:var(--sf-muted)}
.sf-header{border-bottom:1px solid var(--sf-line);background:var(--sf-bg)}
.sf-header .sf-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;min-height:64px;padding-top:8px;padding-bottom:8px}
.sf-brand{display:inline-flex;align-items:center;gap:10px;min-height:44px;color:var(--sf-text)!important;font-weight:800;font-size:1.125rem;text-decoration:none}
.sf .sf-logo{height:40px;width:auto;max-width:160px;aspect-ratio:auto;object-fit:contain;border-radius:calc(var(--sf-r)/2);border:0}
.sf-nav{display:flex;flex-wrap:wrap;gap:4px 8px;margin-left:auto}
.sf-nav a{display:inline-flex;align-items:center;min-height:44px;padding:0 10px;color:var(--sf-text);text-decoration:none;font-weight:500;border-radius:var(--sf-r)}
.sf-nav a:hover{text-decoration:underline}
.sf-nav a[aria-current="page"]{color:var(--sf-primary);font-weight:700;text-decoration:underline}
.sf-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 22px;border-radius:calc(var(--sf-r) + 4px);background:var(--sf-primary);color:var(--sf-on-primary)!important;font-weight:700;text-decoration:none;border:2px solid var(--sf-primary)}
.sf-btn:hover{filter:brightness(.94)}
.sf-btn-ghost{background:transparent;color:var(--sf-primary)!important}
.sf-tone-brand .sf-btn{background:var(--sf-on-primary);color:var(--sf-primary)!important;border-color:var(--sf-on-primary)}
.sf-sec{padding:40px 0}
.sf-tone-surface{background:var(--sf-surface)}
.sf-tone-brand{background:var(--sf-primary);color:var(--sf-on-primary)}
.sf-tone-brand a:not(.sf-btn){color:var(--sf-on-primary)}
.sf-tone-brand .sf-muted{color:var(--sf-on-primary)}
.sf .sf-card .sf-muted,.sf .sf-quote .sf-muted,.sf .sf-list .sf-muted{color:var(--sf-muted)}
.sf-trust{padding:10px 0;border-bottom:1px solid var(--sf-line);background:var(--sf-surface)}
.sf-trust ul{display:flex;flex-wrap:wrap;gap:8px 12px;list-style:none;padding:0;font-size:.9rem}
.sf-chip{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:2px 12px;border:1px solid var(--sf-accent);border-radius:999px;background:var(--sf-bg);font-weight:600}
.sf-hero-grid{display:grid;gap:24px;align-items:center}
.sf-hero p.sf-sub{font-size:1.125rem;margin-top:14px;max-width:60ch}
.sf-hero .sf-actions{margin-top:22px;display:flex;flex-wrap:wrap;gap:12px}
.sf-hero-centered{text-align:center}.sf-hero-centered .sf-sub{margin-left:auto;margin-right:auto}.sf-hero-centered .sf-actions{justify-content:center}
.sf-img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:var(--sf-r);background:var(--sf-surface)}
.sf-ph{display:block;width:100%;aspect-ratio:4/3;border-radius:var(--sf-r);background-color:var(--sf-surface);border:1px solid var(--sf-line)}
.sf-banner-img .sf-img,.sf-banner-img .sf-ph{aspect-ratio:21/9;margin-bottom:24px}
.sf-grid{display:grid;gap:16px;grid-template-columns:repeat(2,minmax(0,1fr))}
.sf-card{display:flex;flex-direction:column;border:1px solid var(--sf-line);border-radius:var(--sf-r);background:var(--sf-bg);overflow:hidden;color:var(--sf-text)}
.sf-tone-surface .sf-card{background:var(--sf-bg)}
.sf-tone-brand .sf-card{color:var(--sf-text)}
.sf-tone-brand .sf-card a{color:var(--sf-primary)}
.sf-card .sf-img,.sf-card .sf-ph{border-radius:0;aspect-ratio:1/1;border:0}
.sf-card-body{padding:12px 14px 16px;display:flex;flex-direction:column;gap:4px}
.sf-card a.sf-title{color:var(--sf-text);text-decoration:none;font-weight:650;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sf-card a.sf-title:hover{text-decoration:underline}
.sf-price{font-weight:700}
.sf-stats{display:grid;gap:16px;grid-template-columns:repeat(2,minmax(0,1fr));list-style:none;padding:0}
.sf-stat dt{font-size:clamp(1.6rem,4vw,2.4rem);font-weight:800;line-height:1.1;color:inherit}
.sf-stat dd{margin-top:4px}
.sf-rich p+p,.sf-rich p+ul,.sf-rich ul+p,.sf-rich p+ol,.sf-rich ol+p{margin-top:12px}
.sf-rich ul,.sf-rich ol{padding-left:22px}
.sf-two{display:grid;gap:24px;align-items:start}
.sf-list{list-style:none;padding:0;display:grid;gap:12px}
.sf-list li{padding:14px 16px;border:1px solid var(--sf-line);border-radius:var(--sf-r);background:var(--sf-bg);color:var(--sf-text)}
.sf-faq details{border:1px solid var(--sf-line);border-radius:var(--sf-r);background:var(--sf-bg);color:var(--sf-text);margin-bottom:10px}
.sf-faq summary{cursor:pointer;min-height:44px;display:flex;align-items:center;padding:8px 16px;font-weight:650}
.sf-faq details p{padding:0 16px 14px}
.sf-quote{padding:18px;border:1px solid var(--sf-line);border-radius:var(--sf-r);background:var(--sf-bg);color:var(--sf-text)}
.sf-quote blockquote{margin:8px 0 0}
.sf-gallery{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
.sf-divider{border:0;border-top:1px solid var(--sf-line);margin:0 auto;max-width:1088px}
.sf-note{padding:12px 14px;border:1px dashed var(--sf-line);border-radius:var(--sf-r);font-size:.9rem}
.sf-footer{border-top:1px solid var(--sf-line);padding:28px 0;font-size:.9rem;background:var(--sf-surface)}
@container sf (min-width:768px){
.sf-hero-grid.sf-split{grid-template-columns:1.1fr .9fr}
.sf-grid{grid-template-columns:repeat(var(--sf-cols,3),minmax(0,1fr))}
.sf-stats{grid-template-columns:repeat(var(--sf-n,4),minmax(0,1fr))}
.sf-two{grid-template-columns:1fr 1fr}
.sf-gallery{grid-template-columns:repeat(3,minmax(0,1fr))}
.sf-sec{padding:56px 0}
}
`;
