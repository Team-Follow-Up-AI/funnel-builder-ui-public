import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configFor, diagnosisFor, funnelTypes, historyFor, releasesFor, sandboxState, statusFor,
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

const html = (res, status, body) => {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
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

const previewDocument = (slug, kind) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${slug} synthetic preview</title><link rel="stylesheet" href="/preview.css"></head>
<body><main class="preview-page"><span class="preview-kicker">${kind === 'live' ? 'SYNTHETIC CURRENT VERSION' : 'SYNTHETIC EDITABLE DRAFT'}</span>
<h1>A clearer path to your next move</h1><p>See the practical steps homeowners can use to plan with confidence.</p>
<form action="/blocked-submission" method="post"><label>Name <input name="name" value="Sample Visitor" disabled></label>
<label>Phone <input name="phone" value="+1 555 010 0200" disabled></label><button disabled>Submission disabled</button></form>
<small>Fixture: ${slug}. This page is generated locally and cannot submit, track, or navigate externally.</small></main></body></html>`;

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const staticFiles = new Set(['/index.html', '/app.js', '/styles.css']);

export const createSandboxServer = () => {
  const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    return json(res, 421, { success: false, error: 'Localhost Host header required.' });
  }

  const url = new URL(req.url || '/', `http://${host}`);
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
      return json(res, 200, { ok: true, releases: scenario === 'empty' ? [] : releasesFor(url.searchParams.get('funnel') || 'fixture') });
    }
    if (req.method === 'GET' && url.pathname === '/api/coauthor/status') {
      return json(res, 200, statusFor(url.searchParams.get('funnel') || 'fixture'));
    }
    if (req.method === 'GET' && url.pathname === '/api/coauthor/pages') {
      return json(res, 200, { ok: true, pages: [{ label: 'Landing page', path: '' }, { label: 'Thank you', path: 'thank-you/' }] });
    }
    if (req.method === 'GET' && url.pathname === '/api/coauthor/history') {
      return json(res, 200, historyFor(url.searchParams.get('funnel') || 'fixture'));
    }
    return json(res, 403, { ok: false, error: 'Co-author mutation and release transports are disabled in this sandbox.' });
  }

  const preview = url.pathname.match(/^\/preview\/(test|live)\/([a-z0-9-]+)(?:\/.*)?$/);
  if (req.method === 'GET' && preview) return html(res, 200, previewDocument(preview[2], preview[1]));
  if (req.method === 'GET' && url.pathname === '/preview.css') {
    const css = '.preview-page{font-family:system-ui;max-width:720px;margin:12vh auto;padding:32px;color:#132238}.preview-kicker{color:#8b5a00;font-weight:700;font-size:12px}.preview-page h1{font-size:clamp(36px,7vw,72px);line-height:1}.preview-page form{display:grid;gap:14px;margin:32px 0;padding:24px;background:#edf3f8}.preview-page label{display:grid;gap:5px}.preview-page input,.preview-page button{padding:12px}';
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
  return server;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createSandboxServer().listen(port, bindHost, () => {
    console.log(`Funnel builder contributor sandbox: http://${bindHost}:${port}`);
    console.log('Synthetic fixtures only. No live services or release transports are configured.');
  });
}
