import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import test, { after, before } from 'node:test';
import { createSandboxServer } from '../server.mjs';

let server;
let origin;

before(async () => {
  server = createSandboxServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('serves the exported builder with an explicit sandbox boundary', async () => {
  const response = await fetch(`${origin}/`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /PUBLIC LOCAL SANDBOX/);
  assert.match(body, /\/app\.js/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
});

test('serves realistic live and Test fixture workspaces', async () => {
  const live = await fetch(`${origin}/api/marketing/funnels`, { headers: { 'X-Demo-Mode': 'production' } });
  const testResponse = await fetch(`${origin}/api/marketing/funnels`, { headers: { 'X-Demo-Mode': 'test' } });
  const liveBody = await live.json();
  const testBody = await testResponse.json();
  assert.equal(live.headers.get('x-demo-mode'), 'production');
  assert.equal(liveBody.funnels.length, 3);
  assert.equal(testBody.funnels.length, 4);
  assert.ok(testBody.funnels.some((funnel) => funnel.slug === 'neighborhood-insider'));
});

test('provides versions, a draft ledger, and synthetic preview pages', async () => {
  const releases = await fetch(`${origin}/api/coauthor/releases?funnel=summer-roofing-guide`).then((value) => value.json());
  const history = await fetch(`${origin}/api/coauthor/history?funnel=summer-roofing-guide`).then((value) => value.json());
  const preview = await fetch(`${origin}/preview/test/summer-roofing-guide`).then(async (value) => ({
    body: await value.text(), csp: value.headers.get('content-security-policy'),
  }));
  assert.equal(releases.releases[0].version, 3);
  assert.match(history.messages[0].text, /SIMULATED/);
  assert.match(preview.body, /SYNTHETIC EDITABLE DRAFT/);
  assert.match(preview.body, /disabled/);
  assert.doesNotMatch(preview.body, /https?:\/\//);
  assert.match(preview.csp, /form-action 'none'/);
});

test('renders empty and error fixture scenarios without a live fallback', async () => {
  const empty = await fetch(`${origin}/api/marketing/funnels?scenario=empty`, { headers: { 'X-Demo-Mode': 'test' } });
  const failed = await fetch(`${origin}/api/marketing/funnels?scenario=error`, { headers: { 'X-Demo-Mode': 'production' } });
  assert.deepEqual((await empty.json()).funnels, []);
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error, /Synthetic upstream failure/);

  const page = await fetch(`${origin}/?scenario=empty`);
  const cookie = page.headers.get('set-cookie');
  const subsequent = await fetch(`${origin}/api/marketing/funnels`, {
    headers: { Cookie: cookie, 'X-Demo-Mode': 'test' },
  });
  assert.deepEqual((await subsequent.json()).funnels, [], 'documented page scenario must carry into same-origin fixture requests');
});

test('allows only local Test fixture edits and refuses release mutations', async () => {
  const testEdit = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Demo-Mode': 'test' }, body: JSON.stringify({ usesDelivery: false }),
  });
  const liveEdit = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Demo-Mode': 'production' }, body: JSON.stringify({ usesDelivery: false }),
  });
  const promote = await fetch(`${origin}/api/coauthor/promote`, { method: 'POST' });
  assert.equal(testEdit.status, 200);
  assert.equal((await testEdit.json()).simulated, true);
  assert.equal(liveEdit.status, 403);
  assert.equal(promote.status, 403);
});

test('fails closed for unknown API, page, Host, and WebSocket routes', async () => {
  const unknownApi = await fetch(`${origin}/api/marketing/provider/passthrough`);
  const unknownPage = await fetch(`${origin}/not-packaged`);
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownPage.status, 404);

  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(origin, { headers: { Host: 'external.example' } }, resolve);
    request.once('error', reject);
    request.end();
  });
  assert.equal(badHost.statusCode, 421);
  badHost.resume();

  const socketReply = await new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1');
    let value = '';
    socket.on('connect', () => socket.write(`GET /api/coauthor/ws HTTP/1.1\r\nHost: 127.0.0.1:${server.address().port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
    socket.on('data', (chunk) => { value += chunk; });
    socket.on('end', () => resolve(value));
    socket.on('error', reject);
  });
  assert.match(socketReply, /^HTTP\/1\.1 403 Forbidden/);
});

test('runs split tests with weighted, sticky, and forced preview arms', async () => {
  const seeded = await fetch(`${origin}/api/marketing/funnels/home-value-workshop/split-test`).then((value) => value.json());
  assert.equal(seeded.splitTest.status, 'running');
  assert.equal(seeded.splitTest.controlWeight, 70);

  const created = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Variation B' }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).splitTest.controlWeight, 50);

  const duplicate = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test`, { method: 'POST' });
  assert.equal(duplicate.status, 409);
  const badWeight = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ controlWeight: 140 }),
  });
  assert.equal(badWeight.status, 400);

  await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ controlWeight: 0 }),
  });
  const randomised = await fetch(`${origin}/preview/live/summer-roofing-guide`);
  assert.match(await randomised.text(), /SYNTHETIC SPLIT-TEST ARM/, 'weight 0 must send every new visitor to the variation');
  assert.match(randomised.headers.get('set-cookie'), /demo_split_summer-roofing-guide=variation/);
  const forcedControl = await fetch(`${origin}/preview/live/summer-roofing-guide?split_force=control`);
  assert.match(await forcedControl.text(), /SYNTHETIC CURRENT VERSION/, 'forced console previews must override randomisation');
  assert.equal(forcedControl.headers.get('set-cookie'), null, 'forced previews must not pin an arm');

  await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ controlWeight: 100 }),
  });
  const pinned = await fetch(`${origin}/preview/live/summer-roofing-guide`, {
    headers: { Cookie: 'demo_split_summer-roofing-guide=variation' },
  }).then((value) => value.text());
  assert.match(pinned, /SYNTHETIC SPLIT-TEST ARM/, 'returning visitors must keep their first arm');

  const ended = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test`, { method: 'DELETE' });
  assert.equal((await ended.json()).splitTest, null);
  const after = await fetch(`${origin}/preview/live/summer-roofing-guide`).then((value) => value.text());
  assert.match(after, /SYNTHETIC CURRENT VERSION/);
});

test('presentation source retains upstream builder logic and sandbox rails', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function renderFunnels/);
  assert.match(app, /function renderBuild/);
  assert.match(app, /function promotionReviewDialog/);
  assert.match(app, /class SimulatedChatSocket/);
  assert.match(app, /Commit disabled/);
  assert.doesNotMatch(app, /private source/i);
});

test('provenance records the current adapted presentation hashes', async () => {
  const provenance = JSON.parse(await readFile(new URL('../PROVENANCE.json', import.meta.url), 'utf8'));
  assert.equal(provenance.history, 'fresh-public-only');
  for (const entry of provenance.files) {
    const value = await readFile(new URL(`../${entry.sandboxPath}`, import.meta.url));
    assert.equal(createHash('sha256').update(value).digest('hex'), entry.sandboxSha256, entry.sandboxPath);
  }
});
