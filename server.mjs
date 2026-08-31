import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUNNEL_PAGES, configFor, diagnosisFor, funnelTypes, historyFor, releasesFor, sandboxState, statusFor,
} from './fixtures.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const configuredPort = Number(process.env.SANDBOX_PORT || 4173);
const port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
  ? configuredPort : 4173;
const bindHost = '127.0.0.1';

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'self'; frame-src 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
};

const html = (res, status, body, extra = {}) => {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', ...extra });
  res.end(body);
};

const scenarioFor = (req, url) => {
  if (url.searchParams.has('scenario')) return url.searchParams.get('scenario');
  const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)demo_scenario=(default|empty|error|loading)(?:;|$)/);
  if (cookie) return cookie[1];
  try { return new URL(req.headers.referer || '').searchParams.get('scenario') || 'default'; } catch { return 'default'; }
};

const bodyJson = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const requestedMode = (req) => req.headers['x-demo-mode'] === 'production' ? 'production' : 'test';

const findFunnel = (slug, mode) => sandboxState[mode].find((item) => item.slug === slug);

// Versions are materialized per funnel (newest first) on first use, so they
// can be renamed and extended. Every split-test variation and promoted winner
// becomes its own funnel version after the v1-v3 base fixtures.
const funnelReleases = (funnel, slug) => {
  funnel.releases = funnel.releases || releasesFor(slug);
  return funnel.releases;
};

const pushRelease = (funnel, slug, idPrefix, entry) => {
  const releases = funnelReleases(funnel, slug);
  const version = releases.reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1;
  releases.unshift({ id: `${idPrefix}-v${version}`, version, metrics: { views: 0, optins: 0 }, ...entry });
  return version;
};

// Every finished split test — ended or decided — is archived so the console
// can show what was tested previously. Tests are per page.
const archiveSplitTest = (funnel, pageDef, outcome) => {
  const split = funnel.splitTests[pageDef.key];
  funnel.splitTestHistory = funnel.splitTestHistory || [];
  funnel.splitTestHistory.push({
    page: pageDef.key,
    variation: structuredClone(split.variation),
    controlWeight: split.controlWeight,
    observed: structuredClone(split.observed),
    optins: split.optins ? structuredClone(split.optins) : null,
    startedAt: split.variation.createdAt || null,
    endedAt: new Date().toISOString(),
    outcome,
  });
  delete funnel.splitTests[pageDef.key];
};

// A variation created from the console starts as an exact duplicate of the
// control page (duplicateOfControl); only the seeded, already-edited fixture
// variation renders distinct content. The kicker still names the arm so the
// sandbox label and the tests can tell duplicates apart. Once a variation is
// picked as the winner it is promoted: the live page (and any later duplicate
// arms of it) render the promoted content under the normal live kicker.
// Content differs per funnel page: registration carries the inert opt-in
// form; confirmation is the post-registration page.
const PAGE_COPY = {
  registration: {
    control: { h1: 'A clearer path to your next move', p: 'See the practical steps homeowners can use to plan with confidence.' },
    edited: { h1: 'A bolder promise for your next move', p: 'This is the alternative page served to part of the randomised traffic in this split test.' },
  },
  confirmation: {
    control: { h1: 'You are registered - check your email', p: 'Your spot is saved. The workshop details and a calendar invite are on their way to your inbox.' },
    edited: { h1: 'Smart move - your seat is locked in', p: 'This is the alternative confirmation page served to part of the randomised traffic in this split test.' },
  },
};

const previewDocument = (slug, kind, { page = FUNNEL_PAGES[0], variation = null, promoted = null } = {}) => {
  const promotedEdited = Boolean(promoted && !promoted.duplicateOfControl);
  const edited = variation ? (!variation.duplicateOfControl || promotedEdited) : kind === 'live' && promotedEdited;
  const copy = (PAGE_COPY[page.key] || PAGE_COPY.registration)[edited ? 'edited' : 'control'];
  const form = page.key === 'registration' ? `
<form action="/blocked-submission" method="post"><label>Name <input name="name" value="Sample Visitor" disabled></label>
<label>Phone <input name="phone" value="+1 555 010 0200" disabled></label><button disabled>Submission disabled</button></form>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${slug} synthetic preview</title><link rel="stylesheet" href="/preview.css"></head>
<body><main class="preview-page${edited ? ' variation' : ''}"><span class="preview-kicker">${variation ? `SYNTHETIC SPLIT-TEST ARM - ${variation.name.toUpperCase()}` : kind === 'live' ? 'SYNTHETIC CURRENT VERSION' : 'SYNTHETIC EDITABLE DRAFT'}</span>
<h1>${copy.h1}</h1><p>${copy.p}</p>${form}
<small>Fixture: ${slug} (${page.label.toLowerCase()}${variation ? `, ${variation.key}${variation.duplicateOfControl ? ', duplicated from control' : ''}` : ''}). This page is generated locally and cannot submit, track, or navigate externally.</small></main></body></html>`;
};

// Starting a test and deciding its winner are shared between the API routes
// and the scheduler, so a scheduled action behaves exactly like a manual one.
const startSplitTest = (funnel, slug, pageDef, name, weight) => {
  funnel.splitTests = funnel.splitTests || {};
  const split = {
    status: 'running',
    controlWeight: weight,
    variation: { key: 'variation-b', name, createdAt: new Date().toISOString(), duplicateOfControl: true },
    observed: { control: 0, variation: 0 },
    optins: { control: 0, variation: 0 },
  };
  funnel.splitTests[pageDef.key] = split;
  split.versionNumber = pushRelease(funnel, slug, 'split-test-b', {
    status: 'split_test',
    committedAt: split.variation.createdAt,
    page: pageDef.key,
    variation: structuredClone(split.variation),
    note: `Split-test variation "${name}" created as its own funnel version on the ${pageDef.label}. It duplicates the control page and receives ${100 - weight}% of the randomised live traffic.`,
  });
  return split;
};

const decideSplitWinner = (funnel, slug, pageDef, winner) => {
  const split = funnel.splitTests[pageDef.key];
  if (winner === 'variation') {
    funnel.promotedVariations = funnel.promotedVariations || {};
    funnel.promotedVariations[pageDef.key] = structuredClone(split.variation);
    pushRelease(funnel, slug, 'winner-b', {
      status: 'deployed_verified',
      committedAt: new Date().toISOString(),
      deploymentVerification: { verifiedAt: new Date().toISOString() },
      page: pageDef.key,
      variation: structuredClone(split.variation),
      note: `"${split.variation.name}" won the split test on the ${pageDef.label} (${split.observed.variation} vs ${split.observed.control} randomised visits) and is now the live page.`,
    });
  }
  archiveSplitTest(funnel, pageDef, winner);
};

// Scheduled actions: a funnel can queue "start this split test" or "make the
// variation the live page" for a moment in the future (e.g. overnight). The
// sweep runs on every request and on a background timer, so swaps happen on
// time even with the console closed. Everything stays in-memory synthetic.
let scheduleSeq = 1;

const runDueSchedules = () => {
  const now = Date.now();
  for (const funnel of sandboxState.production) {
    for (const item of funnel.schedules || []) {
      if (item.status !== 'pending') continue;
      const due = Date.parse(item.at);
      if (!Number.isFinite(due) || due > now) continue;
      const pageDef = FUNNEL_PAGES.find((page) => page.key === item.page);
      try {
        if (!pageDef) throw new Error('Unknown synthetic page.');
        if (item.action === 'start_split') {
          if (funnel.splitTests?.[pageDef.key]) throw new Error('A split test was already running on this page.');
          startSplitTest(funnel, funnel.slug, pageDef, item.name || 'Variation B', Number.isInteger(item.controlWeight) ? item.controlWeight : 50);
          item.result = `Split test started with "${item.name || 'Variation B'}".`;
        } else {
          if (!funnel.splitTests?.[pageDef.key]) throw new Error('No split test was running to promote.');
          const variationName = funnel.splitTests[pageDef.key].variation.name;
          decideSplitWinner(funnel, funnel.slug, pageDef, 'variation');
          item.result = `"${variationName}" is now the live page.`;
        }
        item.status = 'done';
      } catch (error) {
        item.status = 'failed';
        item.result = error.message;
      }
      item.completedAt = new Date().toISOString();
    }
  }
};

/** Weighted, sticky arm assignment for a running split test. Stickiness is
 * per funnel page. Forced arms (the console's side-by-side previews) never
 * count as visits or set the cookie. */
const splitArmFor = (req, url, slug, pageKey, split) => {
  const forced = url.searchParams.get('split_force');
  if (forced === 'control' || forced === 'variation') return { arm: forced, forced: true };
  const sticky = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)demo_split_${slug}_${pageKey}=(control|variation)(?:;|$)`));
  if (sticky) return { arm: sticky[1], forced: false, sticky: true };
  return { arm: Math.random() * 100 < split.controlWeight ? 'control' : 'variation', forced: false, sticky: false };
};

// Synthetic funnel analytics: registration-page loads count as funnel views,
// and a fixed share of them simulate an opt-in (the sandbox's forms are
// inert, so submissions cannot happen for real). Every live page load is
// also credited to the funnel version that served it: the variation's own
// version while its split test runs, the current deployed version otherwise.
// Console thumbnails (?console=1) and forced split arms never count.
const SYNTHETIC_OPTIN_RATE = 0.09;

const creditedRelease = (funnel, slug, split, arm) => {
  const releases = funnelReleases(funnel, slug);
  if (split && arm === 'variation' && split.versionNumber != null) {
    return releases.find((item) => Number(item.version) === Number(split.versionNumber)) || null;
  }
  return releases.find((item) => item.status === 'deployed_verified') || null;
};

const countLiveView = (funnel, slug, url, pageDef, split = null, arm = null) => {
  if (!funnel || url.searchParams.has('console') || url.searchParams.has('split_force')) return;
  const release = creditedRelease(funnel, slug, split, arm);
  if (release) {
    release.metrics = release.metrics || { views: 0, optins: 0 };
    release.metrics.views += 1;
  }
  if (pageDef.key !== 'registration') return;
  funnel.metrics = funnel.metrics || { views: 0, optins: 0 };
  funnel.metrics.views += 1;
  if (Math.random() < SYNTHETIC_OPTIN_RATE) {
    funnel.metrics.optins += 1;
    if (split?.optins && arm) split.optins[arm] += 1;
    if (release) release.metrics.optins += 1;
  }
};

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const staticFiles = new Set(['/index.html', '/app.js', '/styles.css']);

export const createSandboxServer = () => {
  const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    return json(res, 421, { success: false, error: 'Localhost Host header required.' });
  }

  const url = new URL(req.url || '/', `http://${host}`);
  runDueSchedules();
  const scenario = scenarioFor(req, url);
  if (scenario === 'loading' && url.pathname.startsWith('/api/')) {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
  if (scenario === 'error' && url.pathname.startsWith('/api/marketing')) {
    return json(res, 503, { success: false, error: 'Synthetic upstream failure for UI review.' }, { 'X-Demo-Mode': requestedMode(req) });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'funnel-builder-ui-public', network: 'localhost-only' });
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204, securityHeaders);
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/api/console') {
    return json(res, 200, {
      success: true,
      defaultMode: 'test',
      canSwitch: true,
      coauthorConfigured: true,
      previewOrigin: `http://${host}`,
      modes: [
        { mode: 'production', label: 'Live fixture', database: 'synthetic-live', available: true },
        { mode: 'test', label: 'Test fixture', database: 'synthetic-test', available: true },
      ],
    });
  }

  const marketing = url.pathname.match(/^\/api\/marketing(\/.*)$/);
  if (marketing) {
    const path = marketing[1];
    const mode = requestedMode(req);
    const reply = (status, value) => json(res, status, value, { 'X-Demo-Mode': mode });

    if (req.method === 'GET' && path === '/funnels') {
      return reply(200, { success: true, funnels: scenario === 'empty' ? [] : structuredClone(sandboxState[mode]) });
    }
    if (req.method === 'GET' && path === '/funnel-types') return reply(200, { success: true, types: funnelTypes });

    const configMatch = path.match(/^\/funnels\/([a-z0-9-]+)\/config$/);
    if (configMatch && req.method === 'GET') {
      const funnel = findFunnel(configMatch[1], mode);
      return funnel ? reply(200, { success: true, config: configFor(funnel, mode) })
        : reply(404, { success: false, error: 'Synthetic funnel not found.' });
    }
    if (configMatch && req.method === 'PUT' && mode === 'test') {
      const funnel = findFunnel(configMatch[1], mode);
      if (!funnel) return reply(404, { success: false, error: 'Synthetic funnel not found.' });
      let update;
      try { update = await bodyJson(req); } catch (error) { return reply(400, { success: false, error: error.message }); }
      const allowed = new Set(['usesDelivery', 'publicPageValue', 'calendarId', 'leadTag', 'webinar']);
      const rejected = Object.keys(update).filter((key) => !allowed.has(key));
      if (rejected.length) return reply(403, { success: false, error: `Sandbox update refused: ${rejected.join(', ')}` });
      if (typeof update.usesDelivery === 'boolean') funnel.delivery.enabled = update.usesDelivery;
      if ('calendarId' in update) funnel.calendarId = update.calendarId;
      if ('leadTag' in update) funnel.leadTag = update.leadTag;
      if ('webinar' in update) funnel.webinar = update.webinar;
      return reply(200, { success: true, simulated: true, config: configFor(funnel, mode) });
    }
    if (configMatch && req.method === 'PUT') return reply(403, { success: false, error: 'Production fixture is read-only.' });

    const diagnosisMatch = path.match(/^\/funnels\/([a-z0-9-]+)\/diagnosis$/);
    if (diagnosisMatch && req.method === 'GET') {
      return findFunnel(diagnosisMatch[1], 'production')
        ? reply(200, { success: true, diagnosis: diagnosisFor() })
        : reply(404, { success: false, error: 'Synthetic funnel not found.' });
    }

    const optionsMatch = path.match(/^\/funnels\/fixture-location-([a-z0-9-]+)\/form-options$/);
    if (optionsMatch && req.method === 'GET' && mode === 'test') {
      return reply(200, {
        success: true,
        calendars: [
          { id: 'fixture-calendar-consultation', name: 'Fixture consultation', isActive: true },
          { id: 'fixture-calendar-workshop', name: 'Fixture workshop', isActive: true },
        ],
        tags: [{ name: 'fixture-funnel-lead' }, { name: 'fixture-workshop-registered' }],
      });
    }

    // Split tests target randomised live traffic, so they always act on the
    // production fixture record; state is in-memory and clearly simulated.
    const versionMatch = path.match(/^\/funnels\/([a-z0-9-]+)\/versions\/(\d{1,4})$/);
    if (versionMatch) {
      if (req.method !== 'PUT') return reply(405, { success: false, error: 'Unsupported version method.' });
      const funnel = findFunnel(versionMatch[1], 'production');
      if (!funnel) return reply(404, { success: false, error: 'Synthetic funnel not found.' });
      const release = funnelReleases(funnel, versionMatch[1]).find((item) => Number(item.version) === Number(versionMatch[2]));
      if (!release) return reply(404, { success: false, error: 'Synthetic version not found.' });
      let value;
      try { value = await bodyJson(req); } catch (error) { return reply(400, { success: false, error: error.message }); }
      const name = String(value.name ?? '').replace(/[^\w .-]/g, '').trim().slice(0, 60);
      if (name) release.name = name; else delete release.name;
      return reply(200, { success: true, simulated: true, release: structuredClone(release) });
    }

    const winnerMatch = path.match(/^\/funnels\/([a-z0-9-]+)\/split-test\/([a-z-]+)\/winner$/);
    if (winnerMatch) {
      if (req.method !== 'POST') return reply(405, { success: false, error: 'Unsupported split-test method.' });
      const funnel = findFunnel(winnerMatch[1], 'production');
      if (!funnel) return reply(404, { success: false, error: 'Synthetic funnel not found.' });
      const pageDef = FUNNEL_PAGES.find((item) => item.key === winnerMatch[2]);
      if (!pageDef) return reply(404, { success: false, error: 'Unknown synthetic page.' });
      const split = funnel.splitTests?.[pageDef.key];
      if (!split) return reply(404, { success: false, error: 'No split test is running for this synthetic page.' });
      let value;
      try { value = await bodyJson(req); } catch (error) { return reply(400, { success: false, error: error.message }); }
      if (value.winner !== 'control' && value.winner !== 'variation') {
        return reply(400, { success: false, error: "winner must be 'control' or 'variation'." });
      }
      decideSplitWinner(funnel, winnerMatch[1], pageDef, value.winner);
      return reply(200, { success: true, simulated: true, history: structuredClone(funnel.splitTestHistory) });
    }

    const splitPageMatch = path.match(/^\/funnels\/([a-z0-9-]+)\/split-test\/([a-z-]+)$/);
    if (splitPageMatch) {
      const funnel = findFunnel(splitPageMatch[1], 'production');
      if (!funnel) return reply(404, { success: false, error: 'Synthetic funnel not found.' });
      const pageDef = FUNNEL_PAGES.find((item) => item.key === splitPageMatch[2]);
      if (!pageDef) return reply(404, { success: false, error: 'Unknown synthetic page.' });
      funnel.splitTests = funnel.splitTests || {};
      if (req.method === 'POST') {
        if (funnel.splitTests[pageDef.key]) return reply(409, { success: false, error: 'A split test already exists for this synthetic page.' });
        let value;
        try { value = await bodyJson(req); } catch (error) { return reply(400, { success: false, error: error.message }); }
        const name = String(value.name || 'Variation B').replace(/[^\w .-]/g, '').trim().slice(0, 60) || 'Variation B';
        const weight = value.controlWeight === undefined ? 50 : Number(value.controlWeight);
        if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
          return reply(400, { success: false, error: 'controlWeight must be an integer between 0 and 100.' });
        }
        const split = startSplitTest(funnel, splitPageMatch[1], pageDef, name, weight);
        return reply(201, { success: true, simulated: true, splitTest: structuredClone(split) });
      }
      if (req.method === 'PUT') {
        const split = funnel.splitTests[pageDef.key];
        if (!split) return reply(404, { success: false, error: 'No split test is running for this synthetic page.' });
        let value;
        try { value = await bodyJson(req); } catch (error) { return reply(400, { success: false, error: error.message }); }
        const weight = Number(value.controlWeight);
        if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
          return reply(400, { success: false, error: 'controlWeight must be an integer between 0 and 100.' });
        }
        split.controlWeight = weight;
        return reply(200, { success: true, simulated: true, splitTest: structuredClone(split) });
      }
      if (req.method === 'DELETE') {
        if (!funnel.splitTests[pageDef.key]) return reply(404, { success: false, error: 'No split test is running for this synthetic page.' });
        archiveSplitTest(funnel, pageDef, 'ended');
        return reply(200, { success: true, simulated: true, splitTest: null });
      }
      return reply(405, { success: false, error: 'Unsupported split-test method.' });
    }

    const splitMatch = path.match(/^\/funnels\/([a-z0-9-]+)\/split-test$/);
    if (splitMatch) {
      if (req.method !== 'GET') return reply(405, { success: false, error: 'Unsupported split-test method.' });
      const funnel = findFunnel(splitMatch[1], 'production');
      if (!funnel) return reply(404, { success: false, error: 'Synthetic funnel not found.' });
      return reply(200, {
        success: true,
        pages: FUNNEL_PAGES.map((item) => ({
          ...item,
          splitTest: funnel.splitTests?.[item.key] ? structuredClone(funnel.splitTests[item.key]) : null,
        })),
        history: structuredClone(funnel.splitTestHistory || []),
        schedules: structuredClone(funnel.schedules || []),
      });
    }

    const scheduleMatch = path.match(/^\/funnels\/([a-z0-9-]+)\/schedules(?:\/([a-z0-9-]+))?$/);
    if (scheduleMatch) {
      const funnel = findFunnel(scheduleMatch[1], 'production');
      if (!funnel) return reply(404, { success: false, error: 'Synthetic funnel not found.' });
      funnel.schedules = funnel.schedules || [];
      if (req.method === 'GET' && !scheduleMatch[2]) {
        return reply(200, { success: true, schedules: structuredClone(funnel.schedules) });
      }
      if (req.method === 'POST' && !scheduleMatch[2]) {
        let value;
        try { value = await bodyJson(req); } catch (error) { return reply(400, { success: false, error: error.message }); }
        const pageDef = FUNNEL_PAGES.find((item) => item.key === value.page);
        if (!pageDef) return reply(404, { success: false, error: 'Unknown synthetic page.' });
        if (value.action !== 'start_split' && value.action !== 'promote_variation') {
          return reply(400, { success: false, error: "action must be 'start_split' or 'promote_variation'." });
        }
        const due = Date.parse(value.at);
        if (!Number.isFinite(due)) return reply(400, { success: false, error: 'at must be a parseable timestamp.' });
        if (due <= Date.now()) return reply(400, { success: false, error: 'at must be in the future.' });
        const weight = value.controlWeight === undefined ? 50 : Number(value.controlWeight);
        if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
          return reply(400, { success: false, error: 'controlWeight must be an integer between 0 and 100.' });
        }
        const schedule = {
          id: `sch-${scheduleSeq++}`,
          page: pageDef.key,
          action: value.action,
          at: new Date(due).toISOString(),
          name: String(value.name || 'Variation B').replace(/[^\w .-]/g, '').trim().slice(0, 60) || 'Variation B',
          controlWeight: weight,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        funnel.schedules.push(schedule);
        return reply(201, { success: true, simulated: true, schedule: structuredClone(schedule) });
      }
      if (req.method === 'DELETE' && scheduleMatch[2]) {
        const index = funnel.schedules.findIndex((item) => item.id === scheduleMatch[2]);
        if (index === -1) return reply(404, { success: false, error: 'Synthetic schedule not found.' });
        funnel.schedules.splice(index, 1);
        return reply(200, { success: true, simulated: true });
      }
      return reply(405, { success: false, error: 'Unsupported schedule method.' });
    }

    const stateMatch = path.match(/^\/funnels\/([a-z0-9-]+)\/(go-live|pause)$/);
    if (stateMatch && req.method === 'POST' && mode === 'test') {
      const funnel = findFunnel(stateMatch[1], mode);
      if (!funnel) return reply(404, { success: false, error: 'Synthetic funnel not found.' });
      funnel.status = stateMatch[2] === 'go-live' ? 'live' : 'draft';
      return reply(200, { success: true, simulated: true, status: funnel.status });
    }

    if (req.method === 'POST' && path === '/funnels/new' && mode === 'test') {
      let value;
      try { value = await bodyJson(req); } catch (error) { return reply(400, { success: false, error: error.message }); }
      if (!/^[a-z0-9-]{3,60}$/.test(value.slug || '')) return reply(400, { success: false, error: 'Use a 3-60 character synthetic slug.' });
      if (findFunnel(value.slug, mode)) return reply(409, { success: false, error: 'That synthetic slug already exists.' });
      sandboxState.test.push({
        slug: value.slug, name: String(value.name || value.slug).slice(0, 80), status: 'draft',
        delivery: { enabled: false }, observed: { lastSeenAt: null, seenCount: 0 }, funnelType: value.type || 'lead-magnet',
      });
      return reply(201, { success: true, simulated: true });
    }

    return reply(404, { success: false, error: 'Unknown marketing fixture route; live fallback is forbidden.' });
  }

  if (url.pathname.startsWith('/api/coauthor')) {
    if (req.method === 'GET' && url.pathname === '/api/coauthor/releases') {
      const slug = url.searchParams.get('funnel') || 'fixture';
      const funnel = findFunnel(slug, 'production');
      const releases = funnel ? funnelReleases(funnel, slug) : releasesFor(slug);
      return json(res, 200, { ok: true, releases: scenario === 'empty' ? [] : structuredClone(releases) });
    }
    if (req.method === 'GET' && url.pathname === '/api/coauthor/status') {
      return json(res, 200, statusFor(url.searchParams.get('funnel') || 'fixture'));
    }
    if (req.method === 'GET' && url.pathname === '/api/coauthor/pages') {
      return json(res, 200, { ok: true, pages: FUNNEL_PAGES.map(({ label, path: pagePath }) => ({ label, path: pagePath })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/coauthor/history') {
      return json(res, 200, historyFor(url.searchParams.get('funnel') || 'fixture'));
    }
    return json(res, 403, { ok: false, error: 'Co-author mutation and release transports are disabled in this sandbox.' });
  }

  // Read-only snapshot of what a specific funnel version looked like: split
  // arms for split_test versions, promoted content for winner versions, and
  // the plain control page for base releases. Fails closed on unknown ids.
  const versionPreview = url.pathname.match(/^\/preview\/version\/([a-z0-9-]+)\/(\d{1,4})$/);
  if (req.method === 'GET' && versionPreview) {
    const funnel = findFunnel(versionPreview[1], 'production');
    if (!funnel) return json(res, 404, { success: false, error: 'Synthetic funnel not found.' });
    const release = funnelReleases(funnel, versionPreview[1]).find((item) => Number(item.version) === Number(versionPreview[2]));
    if (!release) return json(res, 404, { success: false, error: 'Synthetic version not found.' });
    const pageDef = FUNNEL_PAGES.find((item) => item.key === (release.page || 'registration')) || FUNNEL_PAGES[0];
    if (release.status === 'split_test') return html(res, 200, previewDocument(versionPreview[1], 'live', { page: pageDef, variation: release.variation || null }));
    return html(res, 200, previewDocument(versionPreview[1], 'live', { page: pageDef, promoted: release.variation || null }));
  }

  const preview = url.pathname.match(/^\/preview\/(test|live)\/([a-z0-9-]+)(?:\/(.*))?$/);
  if (req.method === 'GET' && preview) {
    const [, kind, slug, restRaw] = preview;
    const rest = (restRaw || '').replace(/\/+$/, '');
    const pageDef = FUNNEL_PAGES.find((item) => item.path.replace(/\/+$/, '') === rest);
    if (!pageDef) return json(res, 404, { success: false, error: 'Unknown synthetic page.' });
    const funnel = kind === 'live' ? findFunnel(slug, 'production') : null;
    const promoted = funnel?.promotedVariations?.[pageDef.key] || null;
    const split = funnel?.splitTests?.[pageDef.key];
    if (!split || split.status !== 'running') {
      countLiveView(funnel, slug, url, pageDef);
      return html(res, 200, previewDocument(slug, kind, { page: pageDef, promoted }));
    }
    const consoleHit = url.searchParams.has('console');
    const assignment = splitArmFor(req, url, slug, pageDef.key, split);
    if (!assignment.forced && !consoleHit) split.observed[assignment.arm] += 1;
    countLiveView(funnel, slug, url, pageDef, split, assignment.arm);
    const extra = assignment.forced || assignment.sticky || consoleHit
      ? {} : { 'Set-Cookie': `demo_split_${slug}_${pageDef.key}=${assignment.arm}; Path=/; SameSite=Strict` };
    return html(res, 200, previewDocument(slug, kind, { page: pageDef, variation: assignment.arm === 'variation' ? split.variation : null, promoted }), extra);
  }
  if (req.method === 'GET' && url.pathname === '/preview.css') {
    const css = '.preview-page{font-family:system-ui;max-width:720px;margin:12vh auto;padding:32px;color:#132238}.preview-kicker{color:#8b5a00;font-weight:700;font-size:12px}.preview-page h1{font-size:clamp(36px,7vw,72px);line-height:1}.preview-page form{display:grid;gap:14px;margin:32px 0;padding:24px;background:#edf3f8}.preview-page label{display:grid;gap:5px}.preview-page input,.preview-page button{padding:12px}.preview-page.variation{background:#fff7ed}.preview-page.variation .preview-kicker{color:#b45309}.preview-page.variation form{background:#fde8cf}';
    res.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/css; charset=utf-8' });
    return res.end(css);
  }

  const staticPath = url.pathname === '/' ? '/index.html' : url.pathname;
  if (req.method === 'GET' && staticFiles.has(staticPath)) {
    try {
      const value = await readFile(join(publicDir, staticPath.slice(1)));
      const headers = { ...securityHeaders, 'Content-Type': contentTypes[extname(staticPath)] };
      if (staticPath === '/index.html') {
        const requestedScenario = ['empty', 'error', 'loading'].includes(url.searchParams.get('scenario'))
          ? url.searchParams.get('scenario') : 'default';
        headers['Set-Cookie'] = `demo_scenario=${requestedScenario}; Path=/; SameSite=Strict`;
      }
      res.writeHead(200, headers);
      return res.end(value);
    } catch { return json(res, 500, { success: false, error: 'Packaged presentation file unavailable.' }); }
  }

  if (req.headers.upgrade) {
    res.writeHead(403, securityHeaders);
    return res.end('WebSocket/provider transports are disabled.');
  }
    return json(res, 404, { success: false, error: 'Unknown local route; no upstream fallback exists.' });
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  const scheduleTimer = setInterval(runDueSchedules, 10_000);
  scheduleTimer.unref();
  server.on('close', () => clearInterval(scheduleTimer));
  return server;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createSandboxServer().listen(port, bindHost, () => {
    console.log(`Funnel builder contributor sandbox: http://${bindHost}:${port}`);
    console.log('Synthetic fixtures only. No live services or release transports are configured.');
  });
}
