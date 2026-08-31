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
  const seededRegistration = seeded.pages.find((page) => page.key === 'registration');
  assert.equal(seededRegistration.splitTest.status, 'running');
  assert.equal(seededRegistration.splitTest.controlWeight, 70);
  assert.equal(seeded.pages.find((page) => page.key === 'confirmation').splitTest, null, 'each page carries its own split test');

  const badCreate = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Variation B', controlWeight: 140 }),
  });
  assert.equal(badCreate.status, 400, 'creating a variation with an invalid weight must fail before anything is stored');

  const created = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Variation B', controlWeight: 65 }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).splitTest.controlWeight, 65, 'the weight chosen before saving the variation must be stored');

  const dupArm = await fetch(`${origin}/preview/live/summer-roofing-guide?split_force=variation`).then((value) => value.text());
  assert.match(dupArm, /SYNTHETIC SPLIT-TEST ARM/);
  assert.match(dupArm, /A clearer path to your next move/, 'a new variation starts as a duplicate of the control page');
  const editedArm = await fetch(`${origin}/preview/live/home-value-workshop?split_force=variation`).then((value) => value.text());
  assert.match(editedArm, /A bolder promise for your next move/, 'the seeded, already-edited variation keeps its own content');

  const duplicate = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration`, { method: 'POST' });
  assert.equal(duplicate.status, 409);
  const badWeight = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ controlWeight: 140 }),
  });
  assert.equal(badWeight.status, 400);

  await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ controlWeight: 0 }),
  });
  const randomised = await fetch(`${origin}/preview/live/summer-roofing-guide`);
  assert.match(await randomised.text(), /SYNTHETIC SPLIT-TEST ARM/, 'weight 0 must send every new visitor to the variation');
  assert.match(randomised.headers.get('set-cookie'), /demo_split_summer-roofing-guide_registration=variation/);
  const forcedControl = await fetch(`${origin}/preview/live/summer-roofing-guide?split_force=control`);
  assert.match(await forcedControl.text(), /SYNTHETIC CURRENT VERSION/, 'forced console previews must override randomisation');
  assert.equal(forcedControl.headers.get('set-cookie'), null, 'forced previews must not pin an arm');

  await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ controlWeight: 100 }),
  });
  const pinned = await fetch(`${origin}/preview/live/summer-roofing-guide`, {
    headers: { Cookie: 'demo_split_summer-roofing-guide_registration=variation' },
  }).then((value) => value.text());
  assert.match(pinned, /SYNTHETIC SPLIT-TEST ARM/, 'returning visitors must keep their first arm');

  const ended = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration`, { method: 'DELETE' });
  assert.equal((await ended.json()).splitTest, null);
  const after = await fetch(`${origin}/preview/live/summer-roofing-guide`).then((value) => value.text());
  assert.match(after, /SYNTHETIC CURRENT VERSION/);
});

test('picks winners and records split-test history', async () => {
  const before = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test`).then((value) => value.json());
  assert.equal(before.history.at(-1).outcome, 'ended', 'ending a split test must archive it to history');
  assert.equal(before.history.at(-1).page, 'registration', 'archived tests record which page they tested');
  const priorRuns = before.history.length;

  await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bolder Headline', controlWeight: 40 }),
  });
  const badWinner = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration/winner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winner: 'both' }),
  });
  assert.equal(badWinner.status, 400);
  const picked = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration/winner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winner: 'control' }),
  });
  assert.equal(picked.status, 200);
  const afterPick = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test`).then((value) => value.json());
  assert.equal(afterPick.pages.find((page) => page.key === 'registration').splitTest, null, 'picking a winner ends the split test');
  assert.equal(afterPick.history.length, priorRuns + 1);
  assert.equal(afterPick.history.at(-1).outcome, 'control');
  assert.equal(afterPick.history.at(-1).variation.name, 'Bolder Headline');
  assert.equal(afterPick.history.at(-1).controlWeight, 40, 'archived tests keep their final split and observed visits');

  const noRun = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/registration/winner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winner: 'control' }),
  });
  assert.equal(noRun.status, 404);

  const promoted = await fetch(`${origin}/api/marketing/funnels/home-value-workshop/split-test/registration/winner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winner: 'variation' }),
  });
  assert.equal(promoted.status, 200);
  const livePage = await fetch(`${origin}/preview/live/home-value-workshop`).then((value) => value.text());
  assert.match(livePage, /SYNTHETIC CURRENT VERSION/, 'the promoted page is the live funnel, not a split arm');
  assert.match(livePage, /A bolder promise for your next move/, 'the winning variation content is now live');
  const seeded = await fetch(`${origin}/api/marketing/funnels/home-value-workshop/split-test`).then((value) => value.json());
  assert.equal(seeded.history.at(-1).outcome, 'variation');
  assert.equal(seeded.history[0].outcome, 'control', 'the seeded prior test stays in history');
});

test('records each split-test variation and promoted winner as a funnel version', async () => {
  const summer = await fetch(`${origin}/api/coauthor/releases?funnel=summer-roofing-guide`).then((value) => value.json());
  const splitVersions = summer.releases.filter((release) => release.status === 'split_test');
  assert.equal(splitVersions.length, 2, 'both created variations must appear as their own versions');
  assert.ok(splitVersions.every((release) => release.version > 3 && release.note.includes('created as its own funnel version')));
  assert.equal(summer.releases[0].version, 5, 'dynamic versions are listed newest-first above the base fixtures');

  const home = await fetch(`${origin}/api/coauthor/releases?funnel=home-value-workshop`).then((value) => value.json());
  const winner = home.releases.find((release) => release.id.startsWith('winner-b'));
  assert.ok(winner, 'promoting a winner must add a new version');
  assert.equal(winner.status, 'deployed_verified');
  assert.match(winner.note, /won the split test/);
  assert.ok(winner.deploymentVerification?.verifiedAt, 'the promoted version becomes the newest verified deploy');
  assert.ok(home.releases.some((release) => release.id === 'split-test-b-v4'), 'the seeded running variation is version v4');
});

test('renames versions and serves read-only per-version previews', async () => {
  const renamed = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/versions/3`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Summer Promo <script>' }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).release.name, 'Summer Promo script', 'names are sanitized like variation names');
  const listed = await fetch(`${origin}/api/coauthor/releases?funnel=summer-roofing-guide`).then((value) => value.json());
  assert.equal(listed.releases.find((release) => release.version === 3).name, 'Summer Promo script');
  const cleared = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/versions/3`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '' }),
  });
  assert.equal((await cleared.json()).release.name, undefined, 'an empty name clears the custom name');
  const missing = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/versions/99`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ghost' }),
  });
  assert.equal(missing.status, 404);

  const splitVersion = await fetch(`${origin}/preview/version/home-value-workshop/4`).then((value) => value.text());
  assert.match(splitVersion, /SYNTHETIC SPLIT-TEST ARM/, 'split-test versions preview as their arm');
  assert.match(splitVersion, /A bolder promise for your next move/, 'the seeded edited variation shows its own content');
  const baseVersion = await fetch(`${origin}/preview/version/home-value-workshop/3`).then((value) => value.text());
  assert.match(baseVersion, /SYNTHETIC CURRENT VERSION/);
  assert.match(baseVersion, /A clearer path to your next move/, 'base releases preview the pre-promotion control page');
  const winnerRelease = (await fetch(`${origin}/api/coauthor/releases?funnel=home-value-workshop`).then((value) => value.json()))
    .releases.find((release) => release.id.startsWith('winner-b'));
  const winnerVersion = await fetch(`${origin}/preview/version/home-value-workshop/${winnerRelease.version}`).then((value) => value.text());
  assert.match(winnerVersion, /SYNTHETIC CURRENT VERSION/, 'a promoted winner previews as the live page');
  assert.match(winnerVersion, /A bolder promise for your next move/);
  const unknown = await fetch(`${origin}/preview/version/home-value-workshop/99`);
  assert.equal(unknown.status, 404, 'unknown version previews fail closed');
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

test('splits pages independently and tracks synthetic views and opt-ins', async () => {
  const confirmation = await fetch(`${origin}/preview/live/summer-roofing-guide/thank-you/`).then((value) => value.text());
  assert.match(confirmation, /You are registered/, 'the confirmation page renders its own content');
  assert.equal((await fetch(`${origin}/preview/live/summer-roofing-guide/unknown-page/`)).status, 404, 'unknown pages fail closed');

  const readMetrics = async () => (await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/config`, {
    headers: { 'X-Demo-Mode': 'production' },
  }).then((value) => value.json())).config.metrics;
  const readReleases = async () => (await fetch(`${origin}/api/coauthor/releases?funnel=summer-roofing-guide`).then((value) => value.json())).releases;
  const deployedViews = (releases) => releases.find((release) => release.status === 'deployed_verified').metrics.views;
  const metricsBefore = await readMetrics();
  const deployedBefore = deployedViews(await readReleases());
  for (let i = 0; i < 10; i += 1) await fetch(`${origin}/preview/live/summer-roofing-guide`);
  await fetch(`${origin}/preview/live/summer-roofing-guide?console=1`);
  await fetch(`${origin}/preview/live/summer-roofing-guide/thank-you/`);
  const metricsAfter = await readMetrics();
  assert.equal(metricsAfter.views, metricsBefore.views + 10, 'registration loads count as funnel views; console thumbnails and confirmation loads do not');
  assert.ok(metricsAfter.optins >= metricsBefore.optins && metricsAfter.optins <= metricsBefore.optins + 10, 'a share of counted views simulate opt-ins');
  assert.equal(deployedViews(await readReleases()), deployedBefore + 11, 'the deployed version is credited with every live page load it served');

  const homeReleases = (await fetch(`${origin}/api/coauthor/releases?funnel=home-value-workshop`).then((value) => value.json())).releases;
  const seededVariation = homeReleases.find((release) => release.id === 'split-test-b-v4');
  assert.equal(seededVariation.metrics.views, 229, 'a split-test version carries the performance of its variation arm');
  assert.equal(seededVariation.metrics.optins, 29);

  const created = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/confirmation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Warmer Thanks' }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.splitTest.optins.control, 0, 'new tests start their opt-in counters at zero');
  assert.ok(Number(createdBody.splitTest.versionNumber) > 3, 'a new test remembers which version its variation became');
  const badPage = await fetch(`${origin}/api/marketing/funnels/summer-roofing-guide/split-test/checkout`, { method: 'POST' });
  assert.equal(badPage.status, 404, 'unknown pages fail closed for split tests too');
  const confirmationArm = await fetch(`${origin}/preview/live/summer-roofing-guide/thank-you/?split_force=variation`).then((value) => value.text());
  assert.match(confirmationArm, /SYNTHETIC SPLIT-TEST ARM - WARMER THANKS/);
  assert.match(confirmationArm, /You are registered/, 'the confirmation variation starts as a duplicate');
});

test('runs scheduled split-test starts and variation launches', async () => {
  const post = (body) => fetch(`${origin}/api/marketing/funnels/home-value-workshop/schedules`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await post({ page: 'confirmation', action: 'explode', at: future })).status, 400);
  assert.equal((await post({ page: 'checkout', action: 'start_split', at: future })).status, 404);
  assert.equal((await post({ page: 'confirmation', action: 'start_split', at: new Date(Date.now() - 1000).toISOString() })).status, 400, 'past times are rejected');

  const created = await post({ page: 'confirmation', action: 'start_split', at: new Date(Date.now() + 120).toISOString(), name: 'Night Owl', controlWeight: 60 });
  assert.equal(created.status, 201);
  const scheduleId = (await created.json()).schedule.id;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = await fetch(`${origin}/api/marketing/funnels/home-value-workshop/split-test`).then((value) => value.json());
  const confirmationSplit = started.pages.find((page) => page.key === 'confirmation').splitTest;
  assert.equal(confirmationSplit?.status, 'running', 'the scheduled split test starts on time');
  assert.equal(confirmationSplit.variation.name, 'Night Owl');
  assert.equal(confirmationSplit.controlWeight, 60);
  assert.equal(started.schedules.find((item) => item.id === scheduleId).status, 'done');

  const launch = await post({ page: 'confirmation', action: 'promote_variation', at: new Date(Date.now() + 120).toISOString() });
  assert.equal(launch.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const swapped = await fetch(`${origin}/api/marketing/funnels/home-value-workshop/split-test`).then((value) => value.json());
  assert.equal(swapped.pages.find((page) => page.key === 'confirmation').splitTest, null, 'the scheduled launch ends the test');
  assert.equal(swapped.history.at(-1).outcome, 'variation', 'the variation is promoted automatically');
  assert.equal(swapped.history.at(-1).variation.name, 'Night Owl');

  const cancellable = await post({ page: 'confirmation', action: 'start_split', at: new Date(Date.now() + 3_600_000).toISOString() });
  const cancelId = (await cancellable.json()).schedule.id;
  const cancelled = await fetch(`${origin}/api/marketing/funnels/home-value-workshop/schedules/${cancelId}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.equal((await fetch(`${origin}/api/marketing/funnels/home-value-workshop/schedules/${cancelId}`, { method: 'DELETE' })).status, 404);
  const remaining = await fetch(`${origin}/api/marketing/funnels/home-value-workshop/schedules`).then((value) => value.json());
  assert.ok(!remaining.schedules.some((item) => item.id === cancelId), 'cancelled schedules never run');
});
