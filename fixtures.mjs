const iso = (daysAgo) => new Date(Date.UTC(2026, 7, 31 - daysAgo, 9, 30)).toISOString();

const baseFunnels = [
  {
    slug: 'summer-roofing-guide',
    name: 'Summer Roofing Guide',
    status: 'live',
    delivery: { enabled: true },
    observed: { lastSeenAt: iso(0), seenCount: 1842 },
    funnelType: 'lead-magnet',
  },
  {
    slug: 'home-value-workshop',
    name: 'Home Value Workshop',
    status: 'live',
    delivery: { enabled: true },
    observed: { lastSeenAt: iso(1), seenCount: 763 },
    funnelType: 'webinar',
  },
  {
    slug: 'partner-referral',
    name: 'Partner Referral',
    status: 'draft',
    delivery: { enabled: false },
    observed: { lastSeenAt: iso(9), seenCount: 38 },
    funnelType: 'appointment',
  },
];

const withSeededSplitTest = (funnels) => funnels.map((funnel) => funnel.slug !== 'home-value-workshop' ? funnel : {
  ...funnel,
  splitTest: {
    status: 'running',
    controlWeight: 70,
    variation: { key: 'variation-b', name: 'Variation B', createdAt: iso(3) },
    observed: { control: 534, variation: 229 },
  },
});

export const sandboxState = {
  production: withSeededSplitTest(structuredClone(baseFunnels)),
  test: structuredClone([
    ...baseFunnels,
    {
      slug: 'neighborhood-insider',
      name: 'Neighborhood Insider',
      status: 'draft',
      delivery: { enabled: true },
      observed: { lastSeenAt: null, seenCount: 0 },
      funnelType: 'lead-magnet',
    },
  ]),
};

export const configFor = (funnel, mode) => ({
  ...structuredClone(funnel),
  id: `fixture-location-${funnel.slug}`,
  editable: {
    usesDelivery: funnel.delivery?.enabled !== false,
    calendarId: funnel.calendarId || 'fixture-calendar-consultation',
    leadTag: funnel.leadTag || 'fixture-funnel-lead',
    webinar: funnel.webinar || { enabled: true, webinarId: 'fixture-webinar-101' },
    composition: {
      version: 1,
      publicPageValues: { fixture_proof_count: mode === 'test' ? '7,250' : '7,104' },
    },
  },
  readonly: {
    pages: { canonicalUrl: `/preview/live/${funnel.slug}` },
  },
  canGoLive: true,
  checklist: [
    { key: 'page', label: 'Synthetic page fixture', ok: true, blocker: true, detail: 'A local-only preview fixture is available.' },
    { key: 'release', label: 'Release transport', ok: false, blocker: false, detail: 'Intentionally unavailable in the contributor sandbox.' },
  ],
});

const release = (slug, version, daysAgo, status = 'deployed_verified') => ({
  id: `fixture-${slug}-v${version}`,
  version,
  status,
  committedAt: iso(daysAgo),
  deploymentVerification: { verifiedAt: iso(daysAgo) },
  publicPageValues: { fixture_proof_count: version === 3 ? '7,104' : '6,980' },
});

export const releasesFor = (slug) => [
  release(slug, 3, 2),
  release(slug, 2, 18),
  release(slug, 1, 42),
];

export const statusFor = (slug) => ({
  ok: true,
  funnel: slug,
  dirtyFiles: 1,
  unpushedCommits: 0,
  sync: { result: 'level', detail: 'local fixture baseline', at: Date.now() },
  candidate: {
    id: `fixture-candidate-${slug}`,
    candidateId: `fixture-candidate-${slug}`,
    configChanged: true,
    pagesChanged: true,
    transitionConfigured: true,
    browserVerification: { passed: false, reason: 'Release checks are disabled in this sandbox.' },
  },
});

export const historyFor = (slug) => ({
  ok: true,
  messages: [
    { role: 'system', text: '[SIMULATED] Local fixture conversation. No production agent or service is connected.' },
    { role: 'user', text: 'Make the value proposition clearer above the fold.' },
    { role: 'assistant', text: '[SIMULATED] I would tighten the headline and preserve the single booking CTA.' },
  ],
  changes: [
    {
      requested: 'Clarify the hero message (simulated)',
      changed: ['synthetic/index.html'],
      answered: ['Preview fixture updated in this demonstration only.'],
      beforeCandidate: { id: `fixture-before-${slug}` },
      afterCandidate: { id: `fixture-candidate-${slug}` },
      completedAt: iso(0),
    },
  ],
});

export const diagnosisFor = () => ({
  summary: { wired: true, broken: 0, unknown: 0 },
  groups: [
    {
      label: 'Local fixture boundaries',
      rows: [
        {
          label: 'Network', verdict: 'ok', blocker: true,
          headline: 'Preview and data stay on this localhost server.',
          evidence: [{ label: 'Policy', value: "connect-src 'self'; form-action 'none'" }],
        },
      ],
    },
  ],
});

export const funnelTypes = [
  { type: 'lead-magnet', label: 'Lead magnet' },
  { type: 'webinar', label: 'Workshop / webinar' },
  { type: 'appointment', label: 'Appointment request' },
];
