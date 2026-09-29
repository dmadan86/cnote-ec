// Minimal self-contained docs page: no external scripts; renders the endpoint list from /openapi.json.
export function docsHtml(publicUrl: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cnote API</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e3e3e3;--code:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#2a2a2a;--code:#1c1c1c}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:60rem;margin:0 auto;padding:1.5rem 1rem}
code,pre{background:var(--code);border-radius:4px;padding:.1rem .3rem;font-size:.9em}pre{padding:.75rem;overflow:auto}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:.4rem .5rem;text-align:left;vertical-align:top}
.m{font-weight:700;font-size:.8em;text-transform:uppercase}.muted{color:var(--muted)}h2{margin-top:2rem}a{color:inherit}
</style></head><body>
<h1>cnote public API</h1>
<p class="muted" id="desc">Loading specification...</p>
<h2>Import into Apidog</h2>
<ol>
<li>In Apidog choose <b>Import &rarr; OpenAPI/Swagger &rarr; URL</b> and paste <code>${publicUrl}/openapi.json</code> (or upload the file).</li>
<li>Set an environment variable <code>token</code> with your <code>ck_live_&hellip;</code> key and use it as <b>Bearer</b> auth.</li>
</ol>
<p><a href="/openapi.json">Download openapi.json</a> &middot; MCP endpoint: <code>${publicUrl}/mcp</code></p>
<h2>Endpoints</h2>
<table id="ops"><thead><tr><th>Method</th><th>Path</th><th>Scope</th><th>Summary</th></tr></thead><tbody></tbody></table>
<script>
fetch("/openapi.json").then(r=>r.json()).then(function(spec){
  document.getElementById("desc").textContent=spec.info.title+" v"+spec.info.version;
  var tb=document.querySelector("#ops tbody");
  Object.keys(spec.paths).forEach(function(p){Object.keys(spec.paths[p]).forEach(function(m){
    var o=spec.paths[p][m],tr=document.createElement("tr");
    [["m",m],["",p],["",o["x-required-scope"]||""],["",o.summary||""]].forEach(function(c){
      var td=document.createElement("td");td.textContent=c[1];if(c[0])td.className=c[0];tr.appendChild(td)});
    tb.appendChild(tr)})});
}).catch(function(){document.getElementById("desc").textContent="Could not load /openapi.json"});
</script></body></html>`;
}
