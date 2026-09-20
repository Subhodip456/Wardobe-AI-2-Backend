const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const backendRoot = path.resolve(__dirname, '..');

function deploymentFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'node_modules-sdk51-backup', '.git', '.vercel', '.expo', '.next', '.codex', '.agents', 'coverage', 'dist', 'build'].includes(entry.name)) return [];
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return deploymentFiles(filename);
    return entry.isFile() && (/\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(entry.name) || entry.name === '.env.example')
      ? [filename]
      : [];
  });
}

function requestJson(server, pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method,
      headers: encoded === undefined ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encoded),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error('Local regression request timed out')));
    request.on('error', reject);
    request.end(encoded);
  });
}

test('deployable backend files and root ignore rules contain no merge-conflict markers', () => {
  const files = deploymentFiles(backendRoot);
  const rootIgnore = path.join(backendRoot, '..', '.gitignore');
  // A standalone backend upload does not contain the parent repository's ignore file.
  if (fs.existsSync(rootIgnore)) files.push(rootIgnore);
  const conflictMarker = /^(?:<{7}(?:\s|$)|={7}\s*$|>{7}(?:\s|$)|\|{7}(?:\s|$))/m;
  for (const filename of files) {
    // Only report a filename: source text must never be copied into test output.
    assert.equal(conflictMarker.test(fs.readFileSync(filename, 'utf8')), false, path.relative(backendRoot, filename));
  }
});

test('deployable source files contain no embedded provider credentials', () => {
  const repositoryRoot = path.join(backendRoot, '..');
  // Exclude developer .env files; check code, configuration, and example env files.
  // This reports filenames only, even if an accidentally pasted credential is found.
  const credentialPattern = /(?:AIza[A-Za-z0-9_-]{35}|sk-(?:proj-|svcacct-|ant-api\d{2}-)?[A-Za-z0-9_-]{32,})/;
  const files = deploymentFiles(backendRoot);
  // Standalone backend uploads have no containing app checkout. Do not scan their
  // parent directory, vendor backups, or unrelated deployment files.
  if (fs.existsSync(path.join(repositoryRoot, '.git'))) {
    for (const sibling of ['src', 'scripts']) {
      const directory = path.join(repositoryRoot, sibling);
      if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) files.push(...deploymentFiles(directory));
    }
    for (const name of ['app.json', 'app.config.js', 'app.config.ts', 'package.json', 'eas.json', 'babel.config.js', 'metro.config.js', '.env.example']) {
      const filename = path.join(repositoryRoot, name);
      if (fs.existsSync(filename)) files.push(filename);
    }
  }
  const affectedFiles = files
    .filter((filename) => credentialPattern.test(fs.readFileSync(filename, 'utf8')))
    .map((filename) => path.relative(repositoryRoot, filename));
  assert.deepEqual(affectedFiles, [], 'Remove embedded provider credentials from the listed files');
});

test('Vercel routes target an existing function with an adequate image-generation duration', () => {
  const config = JSON.parse(fs.readFileSync(path.join(backendRoot, 'vercel.json'), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(Object.hasOwn(config, 'builds'), false, 'Legacy builds must not conflict with functions configuration');
  assert.ok(fs.statSync(path.join(backendRoot, 'api', 'index.js')).isFile());
  assert.equal(config.functions['api/index.js'].maxDuration, 300);
  assert.deepEqual(config.rewrites, [{ source: '/(.*)', destination: '/api/index' }]);
});

test('actual exported backend boots without API keys and preserves route validation', async (t) => {
  // Empty values prevent dotenv from loading real credentials from a developer's .env file.
  const keys = ['FAL_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'MONGODB_URI', 'MONGODB_DB_NAME', 'OPENAI_IMAGE_MODEL'];
  const previous = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) process.env[key] = '';
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // This suite must never contact or bill a live AI provider, even after a regression.
  const unexpectedNetwork = () => { throw new Error('Live provider calls are forbidden in deployment tests'); };
  const providerFetch = t.mock.method(global, 'fetch', unexpectedNetwork);
  const providerRequest = t.mock.method(https, 'request', unexpectedNetwork);
  const providerGet = t.mock.method(https, 'get', unexpectedNetwork);
  let app;
  await t.test('requiring server.js exports the app without opening a listening socket', () => {
    const listen = t.mock.method(http.Server.prototype, 'listen', () => {
      throw new Error('Importing server.js must not start a server');
    });
    try {
      app = require('../server');
      assert.equal(typeof app, 'function');
      assert.equal(require('../api/index'), app, 'Vercel must export the same Express app as local startup');
      assert.equal(listen.mock.callCount(), 0);
    } finally {
      listen.mock.restore();
    }
  });
  assert.equal(typeof app, 'function');

  const server = http.createServer(app);
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  await t.test('GET /health returns 200 without configured providers', async () => {
    assert.deepEqual(await requestJson(server, '/health'), { status: 200, body: { status: 'ok' } });
  });

  await t.test('GET /api/try-on/config reports missing provider configuration', async () => {
    const response = await requestJson(server, '/api/try-on/config');
    assert.equal(response.status, 200);
    assert.equal(response.body.available, false);
    assert.equal(response.body.code, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(response.body.provider, 'fal');
    assert.equal(response.body.requiresPurchase, true);
    assert.equal(response.body.model, 'fal-ai/image-apps-v2/virtual-try-on');
  });

  await t.test('POST /api/try-on fails closed with 503 when no image provider is configured', async () => {
    const response = await requestJson(server, '/api/try-on', 'POST', {});
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'PROVIDER_NOT_CONFIGURED');
  });

  await t.test('POST /api/outfit/generate rejects an invalid wardrobe before calling Claude', async () => {
    const response = await requestJson(server, '/api/outfit/generate', 'POST', {});
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'No wardrobe items provided');
  });

  await t.test('POST /api/wardrobe/tag rejects a missing image before calling Claude', async () => {
    const response = await requestJson(server, '/api/wardrobe/tag', 'POST', {});
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'No image uploaded');
  });

  assert.equal(providerFetch.mock.callCount(), 0);
  assert.equal(providerRequest.mock.callCount(), 0);
  assert.equal(providerGet.mock.callCount(), 0);
});
