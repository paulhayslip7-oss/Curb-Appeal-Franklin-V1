// Pricing engine. Runs in the browser (live totals as boxes are ticked) and
// on the server (the saved, authoritative quote).
//
// The defaults are set from the labour up, not from what a solo operator
// charges: each job should bring in roughly $95 for every crew hour it takes
// (drive time included). Industry guides put healthy maintenance crews at
// $75–95 per labour hour; with Franklin crew wages around $20–25/hr
// (~$31/hr with payroll taxes and workers' comp) that keeps labour near a
// third of revenue. The owner can change every number from the admin Pricing
// tab without touching code.

export const DEFAULT_PRICING = {
  // The budgetary range shown to prospects: total -low% … total +high%.
  rangeLowPct: 10,
  rangeHighPct: 15,
  // Core plan — all-inclusive grounds care, year round. Every visit covers
  // the lawn (in season) plus keeping beds weeded, shrubs trimmed, leaves
  // cleared and mulch topped up, so nothing ever builds into a big job.
  // Weekly March–November (~39) + every other week December–February (~5)
  // = ~44 visits, billed as 12 equal payments.
  //   per visit = lawn (base + per 1,000 sq ft) + upkeep (per shrub + per sq ft of bed)
  //   per year  = per visit x visits + mulch used for top-ups
  mowing: {
    base: 42, per1kFirst10k: 4, per1kAfter10k: 3.4, minPerVisit: 55,
    upkeepPerShrub: 0.9, upkeepPerBedSqft: 0.03, minUpkeepPerVisit: 20,
    mulchPerCubicYard: 105, mulchInchesPerYear: 1,
    visitsPerYear: 44,
  },
  // Bundle discount on add-ons once enough are selected.
  bundle: [
    { count: 2, pct: 5 },
    { count: 3, pct: 8 },
    { count: 4, pct: 10 },
  ],
  addons: {
    petWaste: { enabled: true, perVisit: 20, perExtraDog: 5, visitsPerYear: 52 },
    pressureWash: { enabled: true, perSqft: 0.2, minPerVisit: 149, visitsPerYear: 4 },
    gutters: { enabled: true, base: 125, perRoofSqft: 0.03, visitsPerYear: 2 },
    aeration: { enabled: true, base: 70, per1k: 15, minPerVisit: 149, visitsPerYear: 1 },
    binCleaning: { enabled: true, perVisit: 20, visitsPerYear: 12 },
    // Off by default: applying herbicide/fertilizer for hire in Tennessee
    // requires a TDA pest-control charter and a licensed applicator.
    lawnTreatment: { enabled: false, base: 30, per1k: 5.5, minPerVisit: 55, visitsPerYear: 7 },
  },
  // Owner-only assumptions used to check each job's profitability. Never
  // sent to customers.
  labor: {
    loadedCostPerHour: 31, // wage + payroll taxes + workers' comp, per crew hour
    targetRevenuePerHour: 90, // what a job should bring in per crew hour
    driveMinutesPerVisit: 12,
    mowSqftPerHour: 16000, // mow + edge + trim + blow, one person
  },
};

// Customer-facing wording for each service, plus the checklist a crew
// member ticks off on a visit report.
export const CORE = {
  key: 'mowing',
  label: 'Year-round grounds care',
  blurb: 'Lawn, beds, shrubs, weeds, leaves and mulch — all kept up at every visit, so nothing ever turns into a big job.',
  cadence: 'Weekly March–November, every other week in winter',
  tasks: [
    'Mow lawn (in season)',
    'Edge walks, driveway & beds',
    'String-trim around obstacles',
    'Pull weeds in beds & hard surfaces',
    'Trim & tidy shrubs',
    'Clear leaves & debris',
    'Freshen mulch where thin',
    'Blow off hard surfaces',
  ],
};

export const ADDONS = [
  { key: 'petWaste', label: 'Pet waste removal', blurb: 'The whole yard scooped, bagged and taken with us.', cadence: 'Every week, all year', tasks: ['Scoop & remove pet waste'], needsDogs: true },
  { key: 'pressureWash', label: 'Pressure washing', blurb: 'Driveway, walks, patio and steps washed back to bright.', cadence: 'Quarterly', tasks: ['Pressure wash driveway & walks', 'Pressure wash patio & steps'] },
  { key: 'gutters', label: 'Gutter cleaning', blurb: 'Gutters and downspouts cleared and flushed.', cadence: 'Twice a year', tasks: ['Clear gutters', 'Flush downspouts'] },
  { key: 'aeration', label: 'Aeration & overseeding', blurb: 'Core aeration and overseeding for a thicker lawn next year.', cadence: 'Once a year, in fall', tasks: ['Core-aerate lawn', 'Overseed'] },
  { key: 'binCleaning', label: 'Trash bin cleaning', blurb: 'Bins washed, deodorized and put back.', cadence: 'Monthly', tasks: ['Wash & deodorize trash bins'] },
  { key: 'lawnTreatment', label: 'Lawn fertilization & weed control', blurb: 'Seasonal fertilizer and weed control applications.', cadence: '7 rounds a year', tasks: ['Apply seasonal lawn treatment'] },
];

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Fill in anything missing from a stored pricing config with the defaults. */
export function mergePricing(saved) {
  const out = structuredClone(DEFAULT_PRICING);
  if (!saved || typeof saved !== 'object') return out;
  for (const k of ['rangeLowPct', 'rangeHighPct']) if (Number.isFinite(saved[k])) out[k] = saved[k];
  if (saved.labor) for (const k of Object.keys(out.labor)) if (Number.isFinite(saved.labor[k]) && saved.labor[k] > 0) out.labor[k] = saved.labor[k];
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
  if (key === 'mowing') {
    const c = pricing.mowing;
    return mow() + Math.max(c.minUpkeepPerVisit, c.upkeepPerShrub * num(m.shrubCount) + c.upkeepPerBedSqft * num(m.bedSqft));
  }
  const c = pricing.addons[key];
  if (!c) return 0;
  switch (key) {
    case 'petWaste':
      return c.perVisit + c.perExtraDog * Math.max(0, Math.round(num(selections.dogs, 1)) - 1);
    case 'pressureWash':
      return Math.max(c.minPerVisit, c.perSqft * num(m.hardscapeSqft));
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

/** Yearly cost of the mulch used to keep beds topped up (part of the core plan). */
export function mulchAnnual(pricing, m) {
  const c = pricing.mowing;
  return ((num(m.bedSqft) * (c.mulchInchesPerYear / 12)) / 27) * c.mulchPerCubicYard;
}

/** Monthly cost of one add-on if it were added (used for the "+$X/mo" labels). */
export function monthlyFor(pricing, key, m, selections) {
  return (perVisitPrice(pricing, key, m, selections) * (pricing.addons[key]?.visitsPerYear || 0)) / 12;
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
    const materials = key === 'mowing' ? mulchAnnual(pricing, m) : 0;
    const annual = perVisit * visitsPerYear + materials;
    return { key, label: meta.label, cadence: meta.cadence, perVisit: Math.round(perVisit * 100) / 100, visitsPerYear, materials: Math.round(materials), annual: Math.round(annual), monthly: Math.round((annual / 12) * 100) / 100 };
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

/**
 * Owner's view of a job: roughly how many crew hours it takes in a year and
 * what that leaves after labour and materials. Time is estimated from the
 * same measurements the price is — treat it as a sanity check, not a timesheet.
 * @param monthly  the monthly price to test (confirmed price, or the calculated one)
 */
export function jobEconomics(pricing, m, selections = {}, monthly) {
  const L = pricing.labor;
  const lawnK = num(m.lawnSqft) / 1000;
  const visits = pricing.mowing.visitsPerYear;
  const mowVisits = Math.min(visits, 34); // the lawn isn't cut in winter
  const mowMin = 8 + (num(m.lawnSqft) / L.mowSqftPerHour) * 60;
  const upkeepMin = Math.max(10, 0.6 * num(m.shrubCount) + 0.03 * num(m.bedSqft));
  let minutes = mowVisits * mowMin + visits * (upkeepMin + L.driveMinutesPerVisit);

  // Extras: [minutes on site, needs its own trip]
  const extra = {
    petWaste: [8 + 3 * Math.max(0, num(selections.dogs, 1) - 1), false],
    binCleaning: [15, false],
    pressureWash: [Math.max(60, 20 + (num(m.hardscapeSqft) / 500) * 60), true],
    gutters: [60 + 0.02 * num(m.buildingSqft), true],
    aeration: [30 + 6 * lawnK, true],
    lawnTreatment: [15 + 2 * lawnK, false],
  };
  for (const [key, [min, ownTrip]] of Object.entries(extra)) {
    const c = pricing.addons[key];
    if (selections.addons?.[key] && c?.enabled) minutes += c.visitsPerYear * (min + (ownTrip ? L.driveMinutesPerVisit : 0));
  }

  const hours = minutes / 60;
  const revenue = num(monthly) * 12;
  const laborCost = hours * L.loadedCostPerHour;
  const materials = mulchAnnual(pricing, m) * 0.5; // mulch at roughly half its installed price
  return {
    hoursPerYear: Math.round(hours),
    minutesPerVisit: Math.round(mowMin + upkeepMin),
    revenue: Math.round(revenue),
    laborCost: Math.round(laborCost),
    materials: Math.round(materials),
    grossProfit: Math.round(revenue - laborCost - materials),
    grossMarginPct: revenue ? Math.round(((revenue - laborCost - materials) / revenue) * 100) : 0,
    revenuePerHour: hours ? Math.round(revenue / hours) : 0,
    onTarget: hours ? revenue / hours >= L.targetRevenuePerHour : true,
  };
}

/** The checklist for a routine visit under a set of selections. */
export function planTasks(selections = {}) {
  return [...CORE.tasks, ...ADDONS.filter((a) => selections.addons?.[a.key]).flatMap((a) => a.tasks)];
}
