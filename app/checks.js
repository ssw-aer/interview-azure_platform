'use strict';

// All the checks the status page reports on. Each check returns
// { status: 'pass' | 'fail' | 'warn' | 'skip', summary, details: [[label, value], ...], hint? }
// Nothing secret is ever returned: the secret value is reduced to a hash and
// the connection string is never echoed, only its non-sensitive parts.

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { Connection, Request } = require('tedious');
const { ManagedIdentityCredential, DefaultAzureCredential } = require('@azure/identity');

const SQL_TOKEN_SCOPE = 'https://database.windows.net/.default';
const KV_REFERENCE_PREFIX = '@Microsoft.KeyVault(';

// ---------------------------------------------------------------- environment

function environment() {
  const env = process.env;
  return {
    siteName: env.WEBSITE_SITE_NAME || null,
    hostname: env.WEBSITE_HOSTNAME || null,
    region: env.REGION_NAME || null,
    sku: env.WEBSITE_SKU || null,
    instance: env.WEBSITE_INSTANCE_ID ? env.WEBSITE_INSTANCE_ID.slice(0, 12) : null,
    runningOnAppService: Boolean(env.WEBSITE_SITE_NAME),
    node: process.version,
  };
}

// ------------------------------------------------------- configuration lookup

// The SQL connection string can be supplied as an app setting or as an
// App Service connection string of any type (which App Service exposes to the
// app with a type prefix).
function sqlConnectionString() {
  const env = process.env;
  const candidates = [
    ['SQL_CONNECTION_STRING', 'app setting'],
    ['SQLAZURECONNSTR_SQL_CONNECTION_STRING', 'connection string (SQLAzure)'],
    ['SQLCONNSTR_SQL_CONNECTION_STRING', 'connection string (SQLServer)'],
    ['CUSTOMCONNSTR_SQL_CONNECTION_STRING', 'connection string (Custom)'],
  ];
  for (const [name, source] of candidates) {
    if (env[name]) return { value: env[name], source };
  }
  return null;
}

// Parse an ADO.NET-style connection string into lower-cased keys.
function parseConnectionString(raw) {
  const result = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase().replace(/\s+/g, ' ');
    let value = part.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('{') && value.endsWith('}'))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  const pick = (...keys) => {
    for (const k of keys) if (result[k] !== undefined && result[k] !== '') return result[k];
    return null;
  };

  let server = pick('server', 'data source', 'address', 'addr', 'network address');
  let port = 1433;
  if (server) {
    server = server.replace(/^tcp:/i, '');
    const comma = server.lastIndexOf(',');
    if (comma !== -1) {
      const p = parseInt(server.slice(comma + 1), 10);
      if (!Number.isNaN(p)) port = p;
      server = server.slice(0, comma);
    }
  }

  return {
    server,
    port,
    database: pick('database', 'initial catalog'),
    authentication: pick('authentication'),
    userId: pick('user id', 'uid', 'user', 'username'),
    hasPassword: pick('password', 'pwd') !== null,
    password: pick('password', 'pwd'),
  };
}

function authMode(authentication) {
  const a = (authentication || '').toLowerCase().replace(/[\s_-]/g, '');
  if (a === 'activedirectorymanagedidentity' || a === 'activedirectorymsi') return 'managed-identity';
  if (a === 'activedirectorydefault') return 'default-credential';
  if (a === '' || a === 'sqlpassword') return 'sql';
  return 'unsupported';
}

// ------------------------------------------------------------ helpers

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower.startsWith('fd') || lower.startsWith('fc');
  }
  return false;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not complete within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeError(err) {
  if (!err) return 'Unknown error';
  const parts = [];
  if (err.name && err.name !== 'Error') parts.push(err.name);
  if (err.code) parts.push(err.code);
  const head = parts.length ? `[${parts.join(' / ')}] ` : '';
  let message = err.message || String(err);
  if (Array.isArray(err.errors) && err.errors.length) {
    message += ' | ' + err.errors.map((e) => e.message || String(e)).join(' | ');
  }
  return head + message;
}

// ------------------------------------------------------------ Key Vault check

function keyVaultHostFromReference(value) {
  // @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)
  // @Microsoft.KeyVault(VaultName=<vault>;SecretName=<name>)
  const uri = value.match(/SecretUri=([^;)]+)/i);
  if (uri) {
    try { return new URL(uri[1]).hostname; } catch { /* fall through */ }
  }
  const vault = value.match(/VaultName=([^;)]+)/i);
  if (vault) return `${vault[1].trim()}.vault.azure.net`;
  return null;
}

function keyVaultHost() {
  const configured = process.env.KEY_VAULT_URI;
  if (configured) {
    try { return new URL(configured).hostname; } catch { return null; }
  }
  const secret = process.env.DEMO_SECRET || '';
  if (secret.startsWith(KV_REFERENCE_PREFIX)) return keyVaultHostFromReference(secret);
  return null;
}

function checkSecret() {
  const value = process.env.DEMO_SECRET;
  if (value === undefined || value === '') {
    return {
      status: 'fail',
      summary: 'DEMO_SECRET is not set',
      details: [],
      hint: 'Add an app setting named DEMO_SECRET. See the README for the expected format.',
    };
  }
  if (value.startsWith(KV_REFERENCE_PREFIX)) {
    return {
      status: 'fail',
      summary: 'DEMO_SECRET is a Key Vault reference that App Service has not resolved',
      details: [['Vault host in reference', keyVaultHostFromReference(value) || 'could not parse']],
      hint: 'App Service passes the reference through unchanged when it cannot resolve it. ' +
            'The app setting blade in the portal shows the reference status and the reason.',
    };
  }
  const hash = crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  return {
    status: 'pass',
    summary: 'DEMO_SECRET has a value',
    details: [
      ['Length', `${value.length} characters`],
      ['SHA-256 (first 12)', hash.slice(0, 12)],
    ],
    note: 'This page cannot tell whether the value came from Key Vault or was set directly; ' +
          'your configuration shows that.',
  };
}

// ------------------------------------------------------------ SQL checks

function checkSqlConfig() {
  const cs = sqlConnectionString();
  if (!cs) {
    return {
      result: {
        status: 'fail',
        summary: 'SQL_CONNECTION_STRING is not set',
        details: [],
        hint: 'Add SQL_CONNECTION_STRING as an app setting or as a connection string. See the README.',
      },
      parsed: null,
    };
  }
  const parsed = parseConnectionString(cs.value);
  const mode = authMode(parsed.authentication);
  const details = [
    ['Supplied as', cs.source],
    ['Server', parsed.server || 'missing'],
    ['Database', parsed.database || 'missing'],
    ['Authentication', parsed.authentication || 'not specified (SQL authentication)'],
  ];
  if (mode === 'managed-identity' || mode === 'default-credential') {
    const clientId = parsed.userId || process.env.AZURE_CLIENT_ID || null;
    details.push(['Identity', clientId ? `user-assigned (client ID ${clientId})` : 'system-assigned']);
  }
  return { result: { details }, parsed: { ...parsed, mode } };
}

function checkCredentialsInConfig(parsed) {
  if (!parsed) {
    return { status: 'skip', summary: 'No connection string to inspect', details: [] };
  }
  const findings = [];
  if (parsed.hasPassword) findings.push('a password');
  if (parsed.mode === 'sql' && parsed.userId) findings.push('a SQL user name');
  if (findings.length) {
    return {
      status: 'fail',
      summary: `The connection string contains ${findings.join(' and ')}`,
      details: [],
    };
  }
  return {
    status: 'pass',
    summary: 'No credentials found in the SQL connection string',
    details: [],
  };
}

async function getToken(parsed) {
  const clientId = parsed.userId || process.env.AZURE_CLIENT_ID || undefined;
  const credential = parsed.mode === 'managed-identity'
    ? (clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential())
    : new DefaultAzureCredential(clientId ? { managedIdentityClientId: clientId } : undefined);
  const token = await credential.getToken(SQL_TOKEN_SCOPE);
  if (!token || !token.token) throw new Error('The credential returned no token');
  return token.token;
}

function runQuery(config) {
  return new Promise((resolve, reject) => {
    const connection = new Connection(config);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { connection.close(); } catch { /* ignore */ }
      fn(value);
    };
    connection.on('error', (err) => finish(reject, err));
    connection.on('connect', (err) => {
      if (err) return finish(reject, err);
      const row = {};
      const request = new Request(
        'SELECT USER_NAME() AS db_user, SUSER_SNAME() AS login_name, DB_NAME() AS db_name, ' +
        "CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition",
        (reqErr) => (reqErr ? finish(reject, reqErr) : finish(resolve, row)),
      );
      request.on('row', (columns) => {
        for (const c of columns) row[c.metadata.colName] = c.value;
      });
      connection.execSql(request);
    });
    connection.connect();
  });
}

function sqlHint(message) {
  const m = message.toLowerCase();
  if (m.includes('managedidentitycredential') || m.includes('credentialunavailable') ||
      m.includes('no managed identity endpoint')) {
    return 'The app could not get a token from a managed identity. Check the identity the app is ' +
           'configured to use, and for a user-assigned identity, the client ID.';
  }
  if (m.includes('login failed')) {
    return 'The token was accepted by the server but no matching database user was found. Check ' +
           'which database the user was created in and the name it was created with.';
  }
  if (m.includes('deny public network access') || m.includes('public network access')) {
    return 'The server refused a connection over its public endpoint.';
  }
  if (m.includes('is not allowed to access the server') || m.includes('client with ip address')) {
    return 'The server firewall rejected the connection from this app.';
  }
  if (m.includes('enotfound') || m.includes('getaddrinfo')) {
    return 'The server name did not resolve. Check the Server value in the connection string.';
  }
  if (m.includes('esocket') || m.includes('failed to connect') || m.includes('econnrefused')) {
    return 'No network connection could be opened to the server. Check the network path between ' +
           'the app and the server.';
  }
  if (m.includes('timeout') || m.includes('etimedout') || m.includes('did not complete')) {
    return 'The connection timed out. A serverless database resuming from auto-pause can take ' +
           'up to a minute: refresh once before investigating network paths.';
  }
  if (m.includes('cannot open database')) {
    return 'Connected to the server but could not open the named database.';
  }
  return null;
}

async function checkSqlConnection(parsed) {
  if (!parsed) return { status: 'skip', summary: 'No connection string configured', details: [] };
  if (!parsed.server || !parsed.database) {
    return { status: 'fail', summary: 'The connection string needs a Server and a Database', details: [] };
  }
  if (parsed.mode === 'unsupported') {
    return {
      status: 'fail',
      summary: `Authentication mode "${parsed.authentication}" is not supported by this app`,
      details: [],
      hint: 'Supported: Active Directory Managed Identity, Active Directory Default, or SQL authentication.',
    };
  }

  const started = Date.now();
  try {
    const options = {
      database: parsed.database,
      port: parsed.port,
      encrypt: true,
      connectTimeout: 60000,
      requestTimeout: 15000,
    };
    let authentication;
    if (parsed.mode === 'sql') {
      authentication = { type: 'default', options: { userName: parsed.userId, password: parsed.password } };
    } else {
      const token = await withTimeout(getToken(parsed), 30000, 'Token acquisition');
      authentication = { type: 'azure-active-directory-access-token', options: { token } };
    }
    const row = await withTimeout(
      runQuery({ server: parsed.server, authentication, options }), 70000, 'SQL connection');
    const method = {
      'managed-identity': 'Microsoft Entra token from managed identity',
      'default-credential': 'Microsoft Entra token from DefaultAzureCredential',
      sql: 'SQL authentication (user name and password)',
    }[parsed.mode];
    return {
      status: parsed.mode === 'sql' ? 'warn' : 'pass',
      summary: `Connected to ${row.db_name} as ${row.db_user}`,
      details: [
        ['Authenticated with', method],
        ['Database user', row.db_user],
        ['Login name', row.login_name],
        ['Database', row.db_name],
        ['Edition', row.edition],
        ['Round trip', `${((Date.now() - started) / 1000).toFixed(1)}s`],
      ],
    };
  } catch (err) {
    const message = describeError(err);
    return {
      status: 'fail',
      summary: 'Could not connect',
      details: [['Error', message], ['After', `${((Date.now() - started) / 1000).toFixed(1)}s`]],
      hint: sqlHint(message),
    };
  }
}

// ------------------------------------------------------------ DNS check

async function resolveHost(label, host) {
  if (!host) return { label, host: null, text: 'not configured' };
  try {
    const addresses = await withTimeout(dns.lookup(host, { all: true }), 10000, 'DNS lookup');
    const list = addresses.map((a) => a.address);
    const isPrivate = list.length > 0 && list.every(isPrivateAddress);
    return { label, host, resolved: true, isPrivate, text: `${list.join(', ')} (${isPrivate ? 'private' : 'public'})` };
  } catch (err) {
    return { label, host, resolved: false, isPrivate: false, text: `did not resolve: ${describeError(err)}` };
  }
}

async function checkDns(parsed) {
  const rows = await Promise.all([
    resolveHost('Azure SQL', parsed && parsed.server),
    resolveHost('Key Vault', keyVaultHost()),
  ]);
  const details = rows.map((r) => [r.label, r.host ? `${r.host} → ${r.text}` : r.text]);
  const note = keyVaultHost() ? undefined
    : 'To include Key Vault here once the reference resolves, set KEY_VAULT_URI (see the README).';
  const configured = rows.filter((r) => r.host);
  if (!configured.length) {
    return { status: 'skip', summary: 'No hostnames to resolve yet', details, note };
  }
  if (configured.some((r) => !r.resolved)) {
    return { status: 'fail', summary: 'A hostname did not resolve', details, note };
  }
  if (configured.every((r) => r.isPrivate)) {
    return {
      status: configured.length === 2 ? 'pass' : 'info',
      summary: configured.length === 2 ? 'Both hostnames resolve to private addresses'
                                       : 'Configured hostnames resolve to private addresses',
      details,
      note,
    };
  }
  return { status: 'info', summary: 'Public addresses in use (expected until objective 6)', details, note };
}

// ------------------------------------------------------------ all together

async function runAll() {
  const { result: configResult, parsed } = checkSqlConfig();
  const [sqlConnection, dnsResult] = await Promise.all([checkSqlConnection(parsed), checkDns(parsed)]);
  const sql = parsed
    ? { ...sqlConnection, details: [...configResult.details, ...sqlConnection.details] }
    : configResult;
  return {
    generatedAt: new Date().toISOString(),
    appVersion: require('./package.json').version,
    environment: environment(),
    checks: {
      keyVault: checkSecret(),
      credentialsInConfig: checkCredentialsInConfig(parsed),
      sql,
      dns: dnsResult,
    },
  };
}

module.exports = { runAll, parseConnectionString, authMode, isPrivateAddress, keyVaultHostFromReference };
