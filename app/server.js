'use strict';

// Aurora Azure Platform Engineer interview task: status page.
//   /             human-readable status page
//   /api/status   the same checks as JSON
//   /healthz      liveness only: 200 while the process is serving requests

const http = require('node:http');
const { runAll } = require('./checks');

const PORT = Number(process.env.PORT) || 8080;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STATUS_TEXT = {
  pass: 'Pass',
  fail: 'Fail',
  warn: 'Pass, with a concern',
  info: 'For information',
  skip: 'Not checked',
};

function renderCheck(title, objective, check) {
  const details = (check.details || [])
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  return `
  <section class="check ${escapeHtml(check.status)}">
    <header>
      <span class="marker" aria-hidden="true"></span>
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="objective">${escapeHtml(objective)}</p>
      </div>
      <p class="state">${escapeHtml(STATUS_TEXT[check.status] || check.status)}</p>
    </header>
    <p class="summary">${escapeHtml(check.summary)}</p>
    ${details ? `<dl>${details}</dl>` : ''}
    ${check.hint ? `<p class="hint"><strong>Likely cause:</strong> ${escapeHtml(check.hint)}</p>` : ''}
    ${check.note ? `<p class="note">${escapeHtml(check.note)}</p>` : ''}
  </section>`;
}

function renderPage(report) {
  const env = report.environment;
  const identity = [
    ['App', env.siteName || 'not running on App Service'],
    ['Region', env.region],
    ['Plan SKU', env.sku],
    ['Instance', env.instance],
    ['Node.js', env.node],
    ['App version', report.appVersion],
  ].filter(([, v]) => v).map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');

  const c = report.checks;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(env.siteName || 'Local')} · interview task status</title>
<style>
  :root {
    --ink: #1f2328; --muted: #5b6470; --paper: #ffffff; --wash: #f5f6f7; --rule: #dde1e5;
    --sun: #ffc629; --pass: #1a7f37; --fail: #c62828; --warn: #b26a00; --info: #3d5a80;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif;
         color: var(--ink); background: var(--wash); }
  main { max-width: 52rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  .masthead { border-top: 6px solid var(--sun); background: var(--paper); padding: 1.5rem 1.5rem 1.25rem;
              margin-bottom: 1.5rem; }
  h1 { font-size: 1.6rem; line-height: 1.2; margin: 0 0 .25rem; font-weight: 600; }
  .lede { margin: 0 0 1.25rem; color: var(--muted); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem 1.5rem; margin: 0; }
  .facts dt { font-size: .8rem; color: var(--muted); }
  .facts dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .check { background: var(--paper); border-left: 6px solid var(--rule); padding: 1.25rem 1.5rem; margin-bottom: 1rem; }
  .check header { display: grid; grid-template-columns: auto 1fr auto; gap: .9rem; align-items: start; }
  .marker { width: 1.1rem; height: 1.1rem; border-radius: 50%; margin-top: .3rem; background: var(--rule); }
  h2 { font-size: 1.15rem; margin: 0; font-weight: 600; }
  .objective { margin: 0; font-size: .85rem; color: var(--muted); }
  .state { margin: .15rem 0 0; font-weight: 600; font-size: .9rem; white-space: nowrap; }
  .summary { margin: .75rem 0 0; font-size: 1.05rem; }
  .check dl { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr; gap: .3rem 1.25rem;
              margin: .9rem 0 0; font-size: .92rem; }
  .check dt { color: var(--muted); }
  .check dd { margin: 0; overflow-wrap: anywhere; }
  .hint { margin: .9rem 0 0; padding: .6rem .8rem; background: #fff4e0; font-size: .92rem; }
  .note { margin: .75rem 0 0; font-size: .85rem; color: var(--muted); }
  .pass { border-left-color: var(--pass); } .pass .marker { background: var(--pass); } .pass .state { color: var(--pass); }
  .fail { border-left-color: var(--fail); } .fail .marker { background: var(--fail); } .fail .state { color: var(--fail); }
  .warn { border-left-color: var(--warn); } .warn .marker { background: var(--warn); } .warn .state { color: var(--warn); }
  .info { border-left-color: var(--info); } .info .marker { background: var(--info); } .info .state { color: var(--info); }
  footer { margin-top: 2rem; font-size: .85rem; color: var(--muted); }
  a { color: var(--info); }
  @media (max-width: 34rem) {
    .check header { grid-template-columns: auto 1fr; }
    .state { grid-column: 2; margin-top: 0; }
    .check dl { grid-template-columns: 1fr; gap: 0; }
    .check dd { margin-bottom: .4rem; }
  }
</style>
</head>
<body>
<main>
  <div class="masthead">
    <h1>Azure Platform Engineer interview task</h1>
    <p class="lede">Checks run live each time this page loads. Generated ${escapeHtml(report.generatedAt)} (UTC).</p>
    <dl class="facts">${identity}</dl>
  </div>
  ${renderCheck('Secret from Key Vault', 'Objective 3: DEMO_SECRET resolved from a Key Vault reference', c.keyVault)}
  ${renderCheck('Credentials in configuration', 'Objective 4: no password in the SQL connection string', c.credentialsInConfig)}
  ${renderCheck('Azure SQL connection', 'Objective 4: connected using the app\'s managed identity', c.sql)}
  ${renderCheck('Name resolution', 'Objective 6: SQL and Key Vault resolving to private endpoints', c.dns)}
  <footer>
    The same checks are available as JSON at <a href="/api/status">/api/status</a>.
    <a href="/healthz">/healthz</a> reports only that the app is running.
  </footer>
</main>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  try {
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('ok');
    }
    if (path === '/api/status') {
      const report = await runAll();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(report, null, 2));
    }
    if (path === '/' || path === '/index.html') {
      const report = await runAll();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      });
      return res.end(renderPage(report));
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('The status checks failed unexpectedly. See the application log stream.');
  }
});

server.listen(PORT, () => {
  console.log(`Interview task status page listening on port ${PORT}`);
});
