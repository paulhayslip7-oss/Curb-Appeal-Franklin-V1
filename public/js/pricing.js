// Pricing engine. Runs in the browser (live totals as boxes are ticked) and
// on the server (the saved, authoritative quote).
//
// Every number below is a starting point drawn from typical 2025–26 Middle
// Tennessee residential rates. The owner can change all of them from the
// admin Pricing tab without touching code.

export const DEFAULT_PRICING = {
  // The budgetary range shown to prospects: total -low% … total +high%.
  rangeLowPct: 10,
  rangeHighPct: 15,
  // Core plan: mow, edge, string-trim, blow. Weekly Apr–Oct, every other
  // week in March and November = ~34 visits, billed as 12 equal payments.
  mowing: { base: 38, per1kFirst10k: 3.6, per1kAfter10k: 2.4, minPerVisit: 48, visitsPerYear: 34 },
  // Bundle discount on add-ons once enough are selected.
  bundle: [
    { count: 3, pct: 5 },
    { count: 5, pct: 8 },
    { count: 7, pct: 10 },
  ],
  addons: {
    shrubs: { enabled: true, perShrub: 7, minPerVisit: 65, visitsPerYear: 3 },
    bedWeeding: { enabled: true, base: 30, perBedSqft: 0.06, minPerVisit: 35, visitsPerYear: 9 },
    petWaste: { enabled: true, perVisit: 18, perExtraDog: 4, visitsPerYear: 52 },
    pressureWash: { enabled: true, perSqft: 0.16, minPerVisit: 119, visitsPerYear: 4 },
    leafCleanup: { enabled: true, mowMultiple: 1.8, minPerVisit: 95, visitsPerYear: 3 },
    mulch: { enabled: true, perCubicYard: 105, depthInches: 2.5, minPerVisit: 250, visitsPerYear: 1 },
    gutters: { enabled: true, base: 100, perRoofSqft: 0.03, visitsPerYear: 2 },
    aeration: { enabled: true, base: 60, per1k: 14, minPerVisit: 129, visitsPerYear: 1 },
    binCleaning: { enabled: true, perVisit: 15, visitsPerYear: 12 },
    // Off by default: applying herbicide/fertilizer for hire in Tennessee
    // requires a TDA pest-control charter and a licensed applicator.
    lawnTreatment: { enabled: false, base: 30, per1k: 5.5, minPerVisit: 55, visitsPerYear: 7 },
  },
};

// Customer-facing wording for each service, plus the checklist a crew
// member ticks off on a visit report.
export const CORE = {
  key: 'mowing',
  label: 'Lawn care',
  blurb: 'Mowing, crisp edging along walks and beds, string-trimming, and every hard surface blown clean.',
  cadence: 'Weekly in the growing season, every other week in spring & late fall',
  tasks: ['Mow lawn', 'Edge walks, driveway & beds', 'String-trim around obstacles', 'Blow off hard surfaces'],
};

export const ADDONS = [
  { key: 'shrubs', label: 'Shrub & hedge trimming', icon: '✂️', blurb: 'Every shrub shaped and the clippings hauled away.', cadence: '3 times a year', tasks: ['Trim & shape shrubs', 'Haul away clippings'] },
  { key: 'bedWeeding', label: 'Weed removal in beds', icon: '🌱', blurb: 'Hand-pulled weeds in every planting bed and along the hardscape.', cadence: 'Monthly, March–November', tasks: ['Hand-weed planting beds', 'Clear weeds from cracks & edges'] },
  { key: 'petWaste', label: 'Pet waste removal', icon: '🐾', blurb: 'The whole yard scooped, bagged and taken with us.', cadence: 'Every week, all year', tasks: ['Scoop & remove pet waste'], needsDogs: true },
  { key: 'pressureWash', label: 'Pressure washing', icon: '💦', blurb: 'Driveway, walks, patio and steps washed back to bright.', cadence: 'Quarterly', tasks: ['Pressure wash driveway & walks', 'Pressure wash patio & steps'] },
  { key: 'leafCleanup', label: 'Fall leaf cleanup', icon: '🍂', blurb: 'Leaves cleared from lawn and beds and hauled off.', cadence: '3 visits, November–December', tasks: ['Clear leaves from lawn & beds', 'Haul away leaves'] },
  { key: 'mulch', label: 'Fresh mulch', icon: '🪵', blurb: 'Beds edged and topped with fresh hardwood mulch.', cadence: 'Once a year, in spring', tasks: ['Edge beds', 'Install fresh mulch'] },
  { key: 'gutters', label: 'Gutter cleaning', icon: '🏠', blurb: 'Gutters and downspouts cleared and flushed.', cadence: 'Twice a year', tasks: ['Clear gutters', 'Flush downspouts'] },
  { key: 'aeration', label: 'Aeration & overseeding', icon: '🌾', blurb: 'Core aeration and overseeding for a thicker lawn next year.', cadence: 'Once a year, in fall', tasks: ['Core-aerate lawn', 'Overseed'] },
  { key: 'binCleaning', label: 'Trash bin cleaning', icon: '🗑️', blurb: 'Bins washed, deodorized and put back.', cadence: 'Monthly', tasks: ['Wash & deodorize trash bins'] },
  { key: 'lawnTreatment', label: 'Lawn fertilization & weed control', icon: '🧪', blurb: 'Seasonal fertilizer and weed control applications.', cadence: '7 rounds a year', tasks: ['Apply seasonal lawn treatment'] },
];

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Fill in anything missing from a stored pricing config with the defaults. */
export function mergePricing(saved) {
  const out = structuredClone(DEFAULT_PRICING);
  if (!saved || typeof saved !== 'object') return out;
  for (const k of ['rangeLowPct', 'rangeHighPct']) if (Number.isFinite(saved[k])) out[k] = saved[k];
  if (saved.mowing) for (const k of Object.keys(out.mowing)) if (Number.isFinite(saved.mowing[k])) out.mowing[k] = saved.mowing[k];
  if (Array.isArray(saved.bundle)) {
    out.bundle = saved.bundle.filter((b) => Number.isFinite(b?.count) && Number.isFinite(b?.pct)).map((b) => ({ count: b.count, pct: b.pct }));
  }
  for (const key of Object.keys(out.addons)) {
    const s = saved.addons?.[key];
    if (!s) continue;
    for (const k of Object.keys(out.addons[key])) {
      if (k === 'enabled') { if (typeof s.enabled === 'boolean') out.addons[key].enabled = s.enabled; }
      else if (Number.isFinite(s[k])) out.addons[key][k] = s[k];
    }
  }
  return out;
}

/** Price of one visit for a service, given the property's measurements. */
export function perVisitPrice(pricing, key, m, selections = {}) {
  const lawnK = num(m.lawnSqft) / 1000;
  const mow = () => {
    const c = pricing.mowing;
    return Math.max(c.minPerVisit, c.base + c.per1kFirst10k * Math.min(lawnK, 10) + c.per1kAfter10k * Math.max(0, lawnK - 10));
  };
  if (key === 'mowing') return mow();
  const c = pricing.addons[key];
  if (!c) return 0;
  switch (key) {
    case 'shrubs':
      return Math.max(c.minPerVisit, c.perShrub * num(m.shrubCount));
    case 'bedWeeding':
      return Math.max(c.minPerVisit, c.base + c.perBedSqft * num(m.bedSqft));
    case 'petWaste':
      return c.perVisit + c.perExtraDog * Math.max(0, Math.round(num(selections.dogs, 1)) - 1);
    case 'pressureWash':
      return Math.max(c.minPerVisit, c.perSqft * num(m.hardscapeSqft));
    case 'leafCleanup':
      return Math.max(c.minPerVisit, mow() * c.mowMultiple);
    case 'mulch':
      return Math.max(c.minPerVisit, ((num(m.bedSqft) * (c.depthInches / 12)) / 27) * c.perCubicYard);
    case 'gutters':
      return c.base + c.perRoofSqft * num(m.buildingSqft);
    case 'aeration':
    case 'lawnTreatment':
      return Math.max(c.minPerVisit, c.base + c.per1k * lawnK);
    case 'binCleaning':
      return c.perVisit;
    default:
      return 0;
  }
}

/** Monthly cost of one line if it were added (used for the "+$X/mo" labels). */
export function monthlyFor(pricing, key, m, selections) {
  const visits = key === 'mowing' ? pricing.mowing.visitsPerYear : pricing.addons[key]?.visitsPerYear || 0;
  return (perVisitPrice(pricing, key, m, selections) * visits) / 12;
}

const roundTo = (v, step) => Math.round(v / step) * step;

/**
 * Build a full quote.
 * @param pricing     pricing config (see DEFAULT_PRICING)
 * @param m           measurements { lawnSqft, shrubCount, bedSqft, hardscapeSqft, buildingSqft }
 * @param selections  { addons: { key: true }, dogs: 1 }
 */
export function computeQuote(pricing, m, selections = {}) {
  const line = (key, meta) => {
    const perVisit = perVisitPrice(pricing, key, m, selections);
    const visitsPerYear = key === 'mowing' ? pricing.mowing.visitsPerYear : pricing.addons[key].visitsPerYear;
    const annual = perVisit * visitsPerYear;
    return { key, label: meta.label, cadence: meta.cadence, perVisit: Math.round(perVisit * 100) / 100, visitsPerYear, annual: Math.round(annual), monthly: Math.round((annual / 12) * 100) / 100 };
  };
  const core = line('mowing', CORE);
  const addons = ADDONS.filter((a) => selections.addons?.[a.key] && pricing.addons[a.key]?.enabled).map((a) => line(a.key, a));

  const tier = [...pricing.bundle].sort((a, b) => b.count - a.count).find((b) => addons.length >= b.count);
  const discountPct = tier ? tier.pct : 0;
  const addonsMonthly = addons.reduce((s, a) => s + a.monthly, 0);
  const discountMonthly = (addonsMonthly * discountPct) / 100;
  const monthly = core.monthly + addonsMonthly - discountMonthly;

  return {
    core,
    addons,
    discountPct,
    discountMonthly: Math.round(discountMonthly * 100) / 100,
    monthly: Math.round(monthly),
    low: roundTo(monthly * (1 - pricing.rangeLowPct / 100), 5),
    high: roundTo(monthly * (1 + pricing.rangeHighPct / 100), 5),
    annual: Math.round(monthly * 12),
  };
}

/** The checklist for a routine visit under a set of selections. */
export function planTasks(selections = {}) {
  return [...CORE.tasks, ...ADDONS.filter((a) => selections.addons?.[a.key]).flatMap((a) => a.tasks)];
}
