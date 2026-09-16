/**
 * f10-linkedin.js — F10 Creative Dashboard LinkedIn section (config-gated)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@TAG/f10-linkedin.js"></script>
 *
 * Must be loaded AFTER f10-utils.js, f10-weekly.js, f10-monthly.js and f10-layout.js.
 *
 * This module is a NO-OP unless the dashboard defines a LINKEDIN config object
 * BEFORE the scripts load, so every existing Meta-only (or Meta+TikTok) dashboard
 * is unaffected. It renders its own "LinkedIn" nav section + panels (built by
 * f10-layout.js) and reuses the same pure helpers TikTok reuses from f10-utils.js
 * (classify, metricValue, creativeRates, creativeScoreSQL, renderPagedTable,
 * formatters) with entirely separate state + DOM ids (li-*), so it never collides
 * with the Meta or TikTok engines.
 *
 * ── TWO CONFIG MODES ────────────────────────────────────────────────────────────
 * LinkedIn is NOT like TikTok, where every client has a per-client mart. Pick the
 * mode that matches how the client's LinkedIn spend is actually warehoused:
 *
 * 1. PER-CLIENT MART (the TikTok-shaped default). The client has their own LinkedIn
 *    creative mart at `{PROJECT}.{DATASET}.{TABLE}`:
 *
 *      const LINKEDIN = {
 *        DATASET:   'acme_marts',                 // optional; defaults to the Meta DATASET
 *        TABLE:     'linkedin_creative_reporting',// optional; this is the default
 *        CONV_EXPR: 'conversions',                // optional; defaults to 'conversions'
 *        THRESHOLDS:{ HR_SPEND: 2000, HR_CPA: 150, ... },  // optional
 *      };
 *
 *    The mart should publish the NORMALISED LinkedIn column contract (below). When it
 *    publishes the contract verbatim, that is the whole config — the builder reads the
 *    table directly and nothing below applies.
 *
 * 1b. PER-CLIENT MART WITH COLUMN OVERRIDES. Real marts are rarely built to somebody
 *    else's contract. Rather than force every client's warehouse into one rigid shape,
 *    the columns a lean mart most often lacks accept an optional per-column SQL
 *    EXPRESSION override on LINKEDIN:
 *
 *      AD_ID_EXPR  AD_NAME_EXPR  CAMPAIGN_NAME_EXPR  ADGROUP_NAME_EXPR
 *      LANDING_PAGE_CLICKS_EXPR  ONE_CLICK_LEADS_EXPR  REVENUE_EXPR
 *      VIDEO_STARTS_EXPR  VIDEO_P25_EXPR  VIDEO_P50_EXPR  VIDEO_P75_EXPR  VIDEO_P100_EXPR
 *
 *    Set ANY of them and the builder stops reading the table bare and wraps it in a
 *    normalising subquery — exactly what shared-account mode already does — aliasing
 *    each expression to its contract name so every tab below stays mode-agnostic. Each
 *    value is a RAW SQL expression pasted verbatim into the SELECT list (the same
 *    escape hatch as Mode 2's CREATIVE_REF_EXPR): it can be a differently-named column
 *    (`creative_id`), a real expression (`COALESCE(NULLIF(name,''), id)`), or a literal
 *    (`NULL`, `0`) for a metric the mart genuinely does not carry, so a tab renders an
 *    honest blank instead of erroring on a missing column. These values come from the
 *    dashboard's own trusted config code, never from user input, and are NOT escaped —
 *    treat them like any other line of the dashboard's source.
 *
 *    Omit an override and that column keeps its contract name verbatim, so an existing
 *    or future client whose mart DOES publish the contract needs no config change at
 *    all and generates byte-identical SQL to before.
 *
 *    The columns NOT overridable are the ones no LinkedIn mart can be useful without:
 *    date_start, min_date, lifetime_spend, spend, impressions, clicks, conversions,
 *    video_views, creative_link. CONV_EXPR and (in ROAS mode) REVENUE_EXPR are read
 *    AFTER normalising, so when overrides are active they must name a CONTRACT column
 *    (e.g. CONV_EXPR: 'clicks'), not a raw mart column the wrapper does not emit.
 *
 *    WORKED EXAMPLE — Skip's real mart, `mcc-poc-477801.skip_marts.linkedin_creative_reporting`.
 *    It parallels Skip's Meta mart (same precomputed lifetime_spend / lifetime_cpa /
 *    creative_age pattern) but is leaner: it keys on creative_id with no ad_id, carries
 *    an always-empty creative_name and a campaign_id with no campaign_name, and has no
 *    ad-group, outbound-click, lead, revenue or video-quartile columns at all:
 *
 *      const LINKEDIN = {
 *        DATASET: 'skip_marts',
 *        TABLE:   'linkedin_creative_reporting',
 *        AD_ID_EXPR:               'creative_id',
 *        AD_NAME_EXPR:             'creative_id',  // creative_name is '' on every row
 *        CAMPAIGN_NAME_EXPR:       'campaign_id',  // no campaign_name column
 *        ADGROUP_NAME_EXPR:        'NULL',
 *        LANDING_PAGE_CLICKS_EXPR: 'clicks',       // no outbound-only click column
 *        ONE_CLICK_LEADS_EXPR:     'NULL',
 *        VIDEO_STARTS_EXPR:        'NULL',
 *        VIDEO_P25_EXPR: 'NULL', VIDEO_P50_EXPR: 'NULL',
 *        VIDEO_P75_EXPR: 'NULL', VIDEO_P100_EXPR: 'NULL',
 *        CONV_EXPR: 'clicks',                      // `conversions` is 0.0 on every row
 *        THRESHOLDS: { HR_SPEND: 2000, HR_CPA: 1, OB_SPEND: 750, OB_CPA: 2, SO_SPEND: 300, SO_CPA: 5 },
 *      };
 *
 *    THRESHOLDS ARE NOT INHERITABLE ACROSS OVERRIDE SETS. The moment CONV_EXPR points
 *    at a different metric, the HR/OB/SO *_CPA bands mean a different thing — the Ad
 *    Production tab there reads as cost-per-CLICK, not cost-per-conversion, and the
 *    LinkedIn defaults (150/250/400, set for a conversion) would classify the whole
 *    account Home Run. Always pull the real per-creative distribution of the metric you
 *    actually chose and set the bands off that; the numbers above are Skip's, from
 *    Skip's data, and are not a template.
 *
 * 2. SHARED ACCOUNT (set ACCOUNT_URN). The client has NO LinkedIn mart: their spend
 *    lives in the shared, multi-client `all_clients_linkedin_ads` dataset and is
 *    separable ONLY by ad-account URN. This is the real Skip case — Skip's LinkedIn
 *    is in no `skip_*` dataset at all; it runs through the 'Sucasa Ad Account'
 *    (urn:li:sponsoredAccount:510299552) in `mcc-poc-477801.all_clients_linkedin_ads`:
 *
 *      const LINKEDIN = {
 *        ACCOUNT_URN: 'urn:li:sponsoredAccount:510299552',
 *        CONV_EXPR:   'landing_page_clicks',
 *        THRESHOLDS:  { HR_SPEND: 2000, HR_CPA: 25, ... },
 *      };
 *
 *    In this mode the builder queries the shared tables directly and normalises them
 *    into the SAME column contract the per-client mart publishes, so every tab below
 *    this line is mode-agnostic. DATASET and TABLE are IGNORED when ACCOUNT_URN is
 *    set — shared-account mode always wins — and PROJECT stays the dashboard's own
 *    PROJECT constant unless LINKEDIN.PROJECT overrides it.
 *
 * ── NORMALISED LINKEDIN COLUMN CONTRACT ─────────────────────────────────────────
 * One row per creative per day:
 *   ad_id, ad_name, campaign_name, adgroup_name, creative_link,
 *   date_start (DATE), min_date (DATE), lifetime_spend,
 *   spend, impressions, clicks, landing_page_clicks,
 *   conversions, one_click_leads, revenue,
 *   video_starts, video_views, video_p25, video_p50, video_p75, video_p100
 *
 * Notes that matter when you build a per-client mart to this contract:
 *   • `spend` is `costInLocalCurrency` — ALREADY in the client's local currency
 *     (e.g. AUD). Do not re-convert it, and do not use costInUsd.
 *   • `video_views` is LinkedIn's own view gate (2 continuous seconds with the post
 *     at least half in view), which is why the LinkedIn platform profile treats it
 *     as the hook/thumbstop rate rather than as a play.
 *   • `landing_page_clicks` is the OUTBOUND click. LinkedIn's raw `clicks` counts
 *     every click on the unit (profile, reactions, expands) and runs ~8% of
 *     impressions on live data, so outbound CTR is the honest intent read.
 *   • `creative_link` is the post permalink, rebuilt from the creative's share /
 *     ugcPost URN: CONCAT('https://www.linkedin.com/feed/update/', reference).
 *   • a mart that cannot publish one of these verbatim does not have to fabricate it —
 *     map or blank it with the Mode 1b *_EXPR overrides above.
 *
 * Metric-aware like the Meta and TikTok engines: with TARGET_METRIC='roas' the
 * dropdown, Ad Production classification, scatter, tables and copy switch to ROAS,
 * reading the gated revenue column (LINKEDIN.REVENUE_EXPR, default REVENUE_EXPR) and
 * classifying against HR_ROAS/OB_ROAS/SO_ROAS. LinkedIn is usually a lead-gen / CAC
 * channel, so CPA (the default) is almost always the right lens.
 *
 * Entrypoint — f10-layout.js calls initLinkedIn() during boot when LINKEDIN exists.
 */
(function () {
  if (typeof linkedinEnabled !== 'function' || !linkedinEnabled()) return; /* no config → no LinkedIn section */

  const PROFILE   = PLATFORM_PROFILES.linkedin;
  const liCfg     = () => LINKEDIN;
  const liProject = () => (liCfg().PROJECT || PROJECT);
  const liDataset = () => (liCfg().DATASET || (typeof DATASET !== 'undefined' ? DATASET : ''));
  const liConv    = () => (liCfg().CONV_EXPR || 'conversions');
  /* Gated revenue column for ROAS mode. Defaults to the same REVENUE_EXPR the Meta
   * engine uses; override per-mart with LINKEDIN.REVENUE_EXPR. Referenced ONLY in
   * ROAS mode. Never sum raw conversion_value (hard policy) — in shared-account mode
   * the normalised `revenue` column is conversionValueInLocalCurrency, which is
   * LinkedIn's own reported conversion value, so treat ROAS here as provisional
   * unless the client's conversion values are known to be trustworthy. */
  const liRawRevExpr = () => (liCfg().REVENUE_EXPR || (typeof revenueExpr === 'function' ? revenueExpr() : 'revenue'));
  /* What the TABS read. REVENUE_EXPR is applied ONCE: when a normalising wrapper is in
   * play (Mode 1b) the wrapper has already aliased it to `revenue`, so applying it
   * again downstream would look for a column the wrapper never emitted. */
  const liRevExpr = () => (liMartNormalised() ? 'revenue' : liRawRevExpr());
  const liIsRoas  = () => (typeof targetMetric === 'function') && targetMetric() === 'roas';
  const LI_TH     = linkedinThresholds();

  /* ── Source resolution: the one place the two modes diverge ── */

  /* Mode 1: the client's own LinkedIn creative mart.
   *
   * The contract columns a lean real-world mart most often cannot publish verbatim,
   * paired with the LINKEDIN key that supplies a replacement SQL expression for each.
   * Order is the SELECT-list order of the normalising wrapper. The columns deliberately
   * absent from this list (date_start, min_date, lifetime_spend, spend, impressions,
   * clicks, conversions, video_views, creative_link) are the ones no LinkedIn mart is
   * useful without, so they stay mandatory and unmapped. */
  const LI_MART_OVERRIDES = [
    ['ad_id',               'AD_ID_EXPR'],
    ['ad_name',             'AD_NAME_EXPR'],
    ['campaign_name',       'CAMPAIGN_NAME_EXPR'],
    ['adgroup_name',        'ADGROUP_NAME_EXPR'],
    ['landing_page_clicks', 'LANDING_PAGE_CLICKS_EXPR'],
    ['one_click_leads',     'ONE_CLICK_LEADS_EXPR'],
    ['video_starts',        'VIDEO_STARTS_EXPR'],
    ['video_p25',           'VIDEO_P25_EXPR'],
    ['video_p50',           'VIDEO_P50_EXPR'],
    ['video_p75',           'VIDEO_P75_EXPR'],
    ['video_p100',          'VIDEO_P100_EXPR'],
  ];

  /* The overrides this dashboard actually set, as { contract_column: sql_expression }.
   * Blank / non-string values are ignored so an empty key can never emit `AS ad_id`
   * with nothing in front of it. */
  function liMartOverrides(){
    const cfg = liCfg(), out = {};
    LI_MART_OVERRIDES.forEach(([col, key]) => {
      const v = cfg[key];
      if (typeof v === 'string' && v.trim()) out[col] = v.trim();
    });
    return out;
  }

  /* True only when a per-client mart is being read THROUGH the normalising wrapper.
   * Shared-account mode has its own normaliser and never uses this one. */
  const liMartNormalised = () => !linkedinSharedAccount() && Object.keys(liMartOverrides()).length > 0;

  /* The bare table reference. Kept separate from liMartTable so the doc/test seam can
   * still see which physical table a normalised source is reading. */
  const liMartRef = () => `\`${liProject()}.${liDataset()}.${liCfg().TABLE || 'linkedin_creative_reporting'}\``;

  /* With no overrides this returns the bare table reference — byte-identical to the
   * original Mode 1 behaviour, so a mart built to the contract is unaffected. With any
   * override set it returns a normalising subquery that renames/synthesises the mapped
   * columns into their contract names, so every tab below stays mode-agnostic. The
   * expressions are pasted verbatim (trusted dashboard config, not user input), the
   * same escape-hatch contract as Mode 2's CREATIVE_REF_EXPR. Revenue is emitted ONLY
   * in ROAS mode, mirroring the rest of the engine: a CPA-mode mart may have no revenue
   * column at all and selecting one would error. */
  function liMartTable(){
    const ov = liMartOverrides();
    if (!Object.keys(ov).length) return liMartRef();
    /* An un-overridden column passes through by its own name — no `x AS x` noise, so
     * the wrapper reads as a diff of what this client's mart actually differs on. */
    const col = (name) => `        ${ov[name] ? `${ov[name]} AS ${name}` : name}`;
    const list = [
      col('ad_id'), col('ad_name'), col('campaign_name'), col('adgroup_name'),
      '        creative_link',
      '        date_start',
      '        min_date',
      '        lifetime_spend',
      '        spend',
      '        impressions',
      '        clicks',
      col('landing_page_clicks'),
      '        conversions',
      col('one_click_leads'),
    ];
    if (liIsRoas()) list.push(`        ${liRawRevExpr()} AS revenue`);
    list.push(
      col('video_starts'),
      '        video_views',
      col('video_p25'), col('video_p50'), col('video_p75'), col('video_p100')
    );
    return `(
      SELECT
${list.join(',\n')}
      FROM ${liMartRef()}
    )`;
  }

  /* Mode 2: the shared multi-client dataset, scoped to one ad account and normalised
   * into the contract shape. Verified against the live Sucasa account:
   *   • analytics rows are DAILY (start_date = end_date) at pivot='CREATIVE', so
   *     start_date is the day and becomes date_start;
   *   • sponsoredCreative and creatives.id are URN strings on both sides, so the join
   *     is on the trailing numeric id of each (this is the join that actually works —
   *     a raw string equality returns nothing);
   *   • creatives.content is a JSON column, so the share/ugcPost URN behind the
   *     permalink is JSON_EXTRACT_SCALAR(content, '$.reference');
   *   • creatives.name is present but EMPTY on real rows, so ad_name falls back to the
   *     campaign name and then to the creative id rather than rendering blank;
   *   • LinkedIn has no ad-group level, so adgroup_name carries the campaign's
   *     objectiveType — the nearest structural analogue, and a genuinely useful split.
   * lifetime_spend and min_date are window functions computed INSIDE this subquery, so
   * they stay true lifetime values even when an outer query filters to a date window —
   * matching what a per-client mart precomputes. */
  function liSharedSourceSQL(){
    const ds  = `${liProject()}.${liCfg().SHARED_DATASET || 'all_clients_linkedin_ads'}`;
    const urn = linkedinAccountUrn();
    const ref = liCfg().CREATIVE_REF_EXPR || `JSON_EXTRACT_SCALAR(c.content, '$.reference')`;
    return `(
      SELECT
        cr.ad_id, cr.ad_name, cr.campaign_name, cr.adgroup_name, cr.creative_link,
        a.start_date                                                AS date_start,
        MIN(a.start_date)          OVER (PARTITION BY cr.ad_id)     AS min_date,
        SUM(a.costInLocalCurrency) OVER (PARTITION BY cr.ad_id)     AS lifetime_spend,
        a.costInLocalCurrency              AS spend,
        a.impressions                      AS impressions,
        a.clicks                           AS clicks,
        a.landingPageClicks                AS landing_page_clicks,
        a.externalWebsiteConversions       AS conversions,
        a.oneClickLeads                    AS one_click_leads,
        a.conversionValueInLocalCurrency   AS revenue,
        a.videoStarts                      AS video_starts,
        a.videoViews                       AS video_views,
        a.videoFirstQuartileCompletions    AS video_p25,
        a.videoMidpointCompletions         AS video_p50,
        a.videoThirdQuartileCompletions    AS video_p75,
        a.videoCompletions                 AS video_p100
      FROM \`${ds}.ad_creative_analytics\` a
      JOIN (
        SELECT
          REGEXP_EXTRACT(c.id, r'([0-9]+)$') AS ad_id,
          COALESCE(NULLIF(c.name, ''), camp.name, CONCAT('Creative ', REGEXP_EXTRACT(c.id, r'([0-9]+)$'))) AS ad_name,
          COALESCE(camp.name, '(no campaign)')          AS campaign_name,
          COALESCE(camp.objectiveType, '(no objective)') AS adgroup_name,
          CONCAT('https://www.linkedin.com/feed/update/', ${ref}) AS creative_link
        FROM \`${ds}.creatives\` c
        LEFT JOIN \`${ds}.campaigns\` camp
          ON REGEXP_EXTRACT(c.campaign, r'([0-9]+)$') = CAST(camp.id AS STRING)
         AND camp.account = '${urn}'
        WHERE c.account = '${urn}'
      ) cr
        ON REGEXP_EXTRACT(a.sponsoredCreative, r'([0-9]+)$') = cr.ad_id
      WHERE a.pivot = 'CREATIVE'
    )`;
  }

  /* The single table expression every query below reads from. Shared-account mode
   * wins over DATASET/TABLE whenever ACCOUNT_URN is set. */
  const liTable = () => (linkedinSharedAccount() ? liSharedSourceSQL() : liMartTable());

  /* Metric-aware SQL fragments built from the LinkedIn thresholds (LI_TH) — the shared
   * helpers in f10-utils.js embed the GLOBAL thresholds, so LinkedIn needs its own,
   * exactly as TikTok does. */
  const liLifetimeMetricSQL = (spendExpr, convExpr) => liIsRoas()
    ? `SAFE_DIVIDE(SUM(${liRevExpr()}), NULLIF(${spendExpr}, 0))`
    : `SAFE_DIVIDE(${spendExpr}, NULLIF(${convExpr}, 0))`;
  const liLifetimeMetricCol = () => liIsRoas() ? 'lifetime_roas' : 'lifetime_cpa';
  /* Mirrors classificationCaseSQL against LI_TH, including FULL_COVERAGE_TIERS — the
   * tab's chart buckets come from the shared classificationTiers(), so a LinkedIn CASE
   * still emitting 'Unclassified' while the flag was on would produce a tier with no
   * bucket to land in. */
  function liClassificationCaseSQL(spendCol, metricCol){
    const roas = liIsRoas();
    const hr = roas
      ? `WHEN ${spendCol} >= ${LI_TH.HR_SPEND} AND ${metricCol} > ${LI_TH.HR_ROAS} THEN 'Home Run'`
      : `WHEN ${spendCol} >= ${LI_TH.HR_SPEND} AND ${metricCol} > 0 AND ${metricCol} < ${LI_TH.HR_CPA} THEN 'Home Run'`;
    const ob = roas
      ? `WHEN ${spendCol} >= ${LI_TH.OB_SPEND} AND ${metricCol} > ${LI_TH.OB_ROAS} THEN 'On Base'`
      : `WHEN ${spendCol} >= ${LI_TH.OB_SPEND} AND ${metricCol} > 0 AND ${metricCol} < ${LI_TH.OB_CPA} THEN 'On Base'`;
    if (typeof fullCoverageTiers === 'function' && fullCoverageTiers()){
      return `CASE ${hr} ${ob}`
           + ` WHEN ${spendCol} >= ${LI_TH.SO_SPEND} THEN 'Strike Out'`
           + ` WHEN ${spendCol} > 0 THEN 'Testing'`
           + ` ELSE 'Zero Spend' END`;
    }
    const so = roas
      ? `WHEN ${spendCol} >= ${LI_TH.SO_SPEND} AND ${metricCol} < ${LI_TH.SO_ROAS} THEN 'Strike Out'`
      : `WHEN ${spendCol} >= ${LI_TH.SO_SPEND} AND ${metricCol} > ${LI_TH.SO_CPA} THEN 'Strike Out'`;
    return `CASE ${hr} ${ob} ${so} ELSE 'Unclassified' END`;
  }

  /* Creative Score inputs for LinkedIn. The shared creativeScoreSQL emitter is
   * metric-aware and platform-agnostic; LinkedIn supplies its own rate expressions.
   * Two LinkedIn-specific calls:
   *   • the "hook" gate is video_views (2s in view) — LinkedIn's own view definition;
   *   • ctrExpr is the OUTBOUND (landing page) click rate, not raw clicks, because
   *     LinkedIn clicks include unit-level interactions and would reward engagement
   *     bait over intent. The hover breakdown is fed cr.outboundCtr to match.
   * Quality ceilings are a percent of impressions, calibrated on the live Sucasa
   * LinkedIn account (video creatives: median view rate ≈ 55%, hold ≈ 4.3%,
   * completion ≈ 2.3%) so a median LinkedIn video centres near 0.5 instead of being
   * capped. That sample is small (4 video creatives) — revisit once more LinkedIn
   * clients are on the framework. */
  function liScoreOpts(){
    return {
      hookExpr:       'SAFE_DIVIDE(video_views, NULLIF(impressions, 0)) * 100',
      holdExpr:       'SAFE_DIVIDE(video_p50, NULLIF(impressions, 0)) * 100',
      ctrExpr:        'SAFE_DIVIDE(landing_page_clicks, NULLIF(impressions, 0)) * 100',
      completionExpr: 'SAFE_DIVIDE(video_p100, NULLIF(impressions, 0)) * 100',
      hasVideoExpr:   'video_starts > 0',
      activeDaysExpr: 'active_days',
      qualityCeil:    { hook: 110, hold: 9, ctr: 0.3, completion: 4.5 },
    };
  }

  /* ── Ad Age bucketing ──
   * Meta's Ad Age tab reads a PRECOMPUTED `creative_age` label column off the Meta
   * mart. LinkedIn DERIVES the bucket instead, from days since launch (date_start
   * minus the per-creative lifetime min_date) — the same semantic `creative_age`
   * encodes, computed fresh. Three reasons, in order of weight:
   *
   *   1. `creative_age` is NOT in the normalised LinkedIn column contract, and cannot
   *      be: shared-account mode (Mode 2) builds its rows from the raw LinkedIn API
   *      tables, which have no age column at all, and a Mode 1b normalising wrapper
   *      only passes contract columns through. Deriving is the ONLY rule that gives
   *      all three source modes the same tab.
   *   2. A per-client mart is not required to publish an age column, so a tab that
   *      depended on one would break on a lean mart rather than degrade.
   *   3. It costs nothing in accuracy. Verified 2026-09-16 against Skip's real mart
   *      `mcc-poc-477801.skip_marts.linkedin_creative_reporting`: the derived bucket
   *      reproduces that mart's own `creative_age` on 1,469 of 1,469 rows (100%),
   *      with the 0-7/8-14/15-30/31-60/61-90/90+ boundaries landing exactly where
   *      DATE_DIFF puts them. So computing it is a strictly safer way to get the same
   *      answer, not a different answer.
   *
   *   (An earlier note on this build claimed Skip's `creative_age` read '1. 0-7 Days'
   *   on every row. That does NOT reproduce against the mart as it stands — the
   *   column is well-formed today. The derivation is kept for reasons 1 and 2, which
   *   hold regardless, not because that column is currently broken.)
   *
   * LINKEDIN.AGE_BUCKET_EXPR is the escape hatch for a client who wants their mart's
   * own bucketing instead: a raw SQL expression that must evaluate to one of the three
   * bucket labels below, e.g.
   *   AGE_BUCKET_EXPR: "CASE WHEN creative_age IN ('1. 0-7 Days','2. 8-14 Days') THEN '0–14 Days' ... END"
   * It is pasted verbatim from trusted dashboard config (the same escape-hatch
   * contract as the Mode 1b *_EXPR overrides) and is evaluated against the RESOLVED
   * source, so it may only name columns that source emits: any mart column in Mode 1
   * (bare table), but only NORMALISED CONTRACT columns once a Mode 1b wrapper or
   * shared-account mode is in play — those wrappers do not pass `creative_age`
   * through. A client who needs a precomputed age column AND column overrides at the
   * same time should map the age column into the contract via the mart itself. */
  const LI_AGE_DAYS = 'DATE_DIFF(date_start, min_date, DAY)';
  const LI_AGE_BUCKETS = ['0–14 Days', '15–90 Days', '90+ Days'];
  const liAgeBucketSQL = () => {
    const ov = liCfg().AGE_BUCKET_EXPR;
    if (typeof ov === 'string' && ov.trim()) return ov.trim();
    return `CASE WHEN ${LI_AGE_DAYS} <= 14 THEN '${LI_AGE_BUCKETS[0]}'`
         + ` WHEN ${LI_AGE_DAYS} <= 90 THEN '${LI_AGE_BUCKETS[1]}'`
         + ` ELSE '${LI_AGE_BUCKETS[2]}' END`;
  };

  /* Full eight-tab parity with the Meta engine. Order mirrors the Meta sidebar:
   * Weekly (Summary, Board, Map) then Monthly (Power Law, Production, Decay, Age,
   * Creative Effectiveness). */
  const LI_TABS = ['li-summary', 'li-board', 'li-map', 'li-powerlaw', 'li-production', 'li-decay', 'li-age', 'li-creative'];
  const liTitles = {
    'li-summary':    'LinkedIn · Weekly Summary',
    'li-board':      'LinkedIn · Movement Board',
    'li-map':        'LinkedIn · Movement Map',
    'li-powerlaw':   'LinkedIn · Ad Power Law',
    'li-production': 'LinkedIn · Ad Production',
    'li-decay':      'LinkedIn · Ad Decay',
    'li-age':        'LinkedIn · Ad Age',
    'li-creative':   'LinkedIn · Creative Effectiveness',
  };
  /* The Movement Map is fed by the SAME per-window `movers` array the Summary and
   * Board already compute, so it is a weekly tab: it needs no query of its own and
   * re-renders with the weekly controls. */
  const liIsWeekly = (t) => t === 'li-summary' || t === 'li-board' || t === 'li-map';

  let LI_WIN = null, LI_MAXDATE = null, liCharts = {}, liActive = null, liLoaded = {};

  /* Null-safe show/hide. The shared showEl/hideEl throw on a missing id, which is
   * fine for the panels that always exist; the tabs added for Meta parity render into
   * ids a partially-stubbed DOM may not carry, so they go through these. */
  const liShow = (id) => { const el = document.getElementById(id); if (el) el.style.display = ''; };
  const liHide = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

  /* ── Data fetching ── */

  const liMaxDateSQL = () => `SELECT FORMAT_DATE('%Y-%m-%d', MAX(date_start)) AS max_date FROM ${liTable()}`;

  async function liFetchMaxDate() {
    const rows = await runQuery(liMaxDateSQL());
    return rows && rows[0] ? bqStr(rows[0].max_date) : null;
  }

  function liControls() {
    const length = parseInt((document.getElementById('li-ctrl-length') || {}).value || '7', 10);
    const end = (document.getElementById('li-ctrl-enddate') || {}).value || LI_MAXDATE;
    const metricKey = (document.getElementById('li-ctrl-metric') || {}).value || (liIsRoas() ? 'ROAS' : 'CPA');
    const minSpend = Number((document.getElementById('li-ctrl-minspend') || {}).value) || 0;
    return { length, end, metricKey, metric: METRICS[metricKey], floorMode: 'fixed', fixedSpend: minSpend };
  }

  /* Pure SQL builder for the two weekly tabs. Split out from the fetch so the shape can
   * be asserted (and BigQuery dry-run) without a network call. */
  function liWindowsSQL(curStart, curEnd, priStart, priEnd) {
    const inCur = `date_start BETWEEN '${curStart}' AND '${curEnd}'`;
    const inPri = `date_start BETWEEN '${priStart}' AND '${priEnd}'`;
    /* Windowed revenue is SELECTed ONLY in ROAS mode — a CPA-mode LinkedIn mart may
     * have no gated revenue column and the query would error. Mirrors f10-weekly.js. */
    const revSel = liIsRoas()
      ? `,
        SUM(IF(${inCur}, ${liRevExpr()}, 0))     AS cur_revenue,
        SUM(IF(${inPri}, ${liRevExpr()}, 0))     AS pri_revenue`
      : '';
    const sql = `
      SELECT ad_id,
        ANY_VALUE(ad_name)       AS ad_name,
        ANY_VALUE(campaign_name) AS campaign_name,
        ANY_VALUE(adgroup_name)  AS adgroup_name,
        ANY_VALUE(creative_link) AS creative_link,
        SUM(IF(${inCur}, spend, 0))                AS cur_spend,
        SUM(IF(${inCur}, impressions, 0))          AS cur_impressions,
        SUM(IF(${inCur}, clicks, 0))               AS cur_clicks,
        SUM(IF(${inCur}, landing_page_clicks, 0))  AS cur_lpc,
        SUM(IF(${inCur}, ${liConv()}, 0))          AS cur_conv,
        SUM(IF(${inCur}, video_views, 0))          AS cur_views,
        SUM(IF(${inCur}, video_p50, 0))            AS cur_hold,
        SUM(IF(${inCur}, video_p100, 0))           AS cur_p100,
        SUM(IF(${inCur}, video_starts, 0))         AS cur_starts,
        SUM(IF(${inPri}, spend, 0))                AS pri_spend,
        SUM(IF(${inPri}, impressions, 0))          AS pri_impressions,
        SUM(IF(${inPri}, clicks, 0))               AS pri_clicks,
        SUM(IF(${inPri}, ${liConv()}, 0))          AS pri_conv${revSel}
      FROM ${liTable()}
      WHERE date_start BETWEEN '${priStart}' AND '${curEnd}'
      GROUP BY ad_id
      HAVING cur_spend > 0 OR pri_spend > 0`;
    return sql;
  }

  async function liFetchWindows(c) {
    const curStart = isoOffset(c.end, -(c.length - 1)), curEnd = c.end;
    const priEnd = isoOffset(curStart, -1), priStart = isoOffset(priEnd, -(c.length - 1));
    const rows = await runQuery(liWindowsSQL(curStart, curEnd, priStart, priEnd));
    const ads = {};
    rows.forEach((r) => {
      const cs = Number(r.cur_spend) || 0, ps = Number(r.pri_spend) || 0;
      ads[r.ad_id] = {
        ad_id: r.ad_id, ad_name: r.ad_name, campaign_name: r.campaign_name,
        adset_name: r.adgroup_name, creative_link: r.creative_link,
        cur: {
          spend: cs, impressions: Number(r.cur_impressions) || 0, clicks: Number(r.cur_clicks) || 0,
          conv: Number(r.cur_conv) || 0, conv_cost_num: cs, revenue: Number(r.cur_revenue) || 0,
          landing_page_clicks: Number(r.cur_lpc) || 0,
          video_views: Number(r.cur_views) || 0, video_p50: Number(r.cur_hold) || 0,
          video_p100: Number(r.cur_p100) || 0, video_starts: Number(r.cur_starts) || 0,
        },
        pri: { spend: ps, impressions: Number(r.pri_impressions) || 0, clicks: Number(r.pri_clicks) || 0, conv: Number(r.pri_conv) || 0, conv_cost_num: ps, revenue: Number(r.pri_revenue) || 0 },
      };
    });
    return { ads, curStart, curEnd, priStart, priEnd };
  }

  /* ── Load + render orchestration (weekly) ── */

  async function liLoadWindows() {
    try {
      showEl('li-summary-loading'); hideEl('li-summary-body');
      showEl('li-board-loading');   hideEl('li-board-table');
      liShow('li-map-loading');     liHide('li-map-wrapper');
      LI_WIN = await liFetchWindows(liControls());
      liRenderWeekly();
    } catch (err) {
      console.error('LinkedIn weekly error:', err);
      const el = document.getElementById('li-summary-loading'); if (el) el.innerHTML = 'Error loading data: ' + err.message;
    }
  }

  function liRenderWeekly() {
    if (!LI_WIN) return;
    const c = liControls();
    const classified = Object.values(LI_WIN.ads).map((a) => classify(a, c));
    const movers = classified.filter((a) => a.qCur || a.qPri);
    const windowTxt = `Current: ${fmtDate(LI_WIN.curStart)} – ${fmtDate(LI_WIN.curEnd)} vs Prior: ${fmtDate(LI_WIN.priStart)} – ${fmtDate(LI_WIN.priEnd)} · Metric: ${c.metric.label} · ${movers.length} ads cleared the floor`;
    ['li-summary-window-note', 'li-board-window-note', 'li-map-window-note'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = windowTxt; });
    liRenderSummary(classified, c);
    liRenderBoard(movers, c);
    /* The Map reads the SAME movers array the Board just rendered — one window
     * fetch feeds all three weekly tabs, exactly as the Meta engine does. */
    liRenderMap(movers, c);
    const lu = document.getElementById('last-updated'); if (lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
  }

  function liRenderSummary(all, c) {
    const m = c.metric;
    const tot = { cur: emptyAgg(), pri: emptyAgg() };
    let curImpr = 0, curViews = 0, curHold = 0, curLpc = 0;
    all.forEach((a) => {
      ['spend', 'impressions', 'clicks', 'conv', 'conv_cost_num', 'revenue'].forEach((k) => { tot.cur[k] += a.cur[k]; tot.pri[k] += a.pri[k]; });
      curImpr += a.cur.impressions; curViews += a.cur.video_views || 0; curHold += a.cur.video_p50 || 0; curLpc += a.cur.landing_page_clicks || 0;
    });
    const mCur = metricValue(tot.cur, m), mPri = metricValue(tot.pri, m);
    const viewCur = curImpr > 0 ? (curViews / curImpr) * 100 : null;
    const holdCur = curImpr > 0 ? (curHold / curImpr) * 100 : null;
    const outCur  = curImpr > 0 ? (curLpc / curImpr) * 100 : null;

    function deltaHtml(cur, pri, lowerBetter) {
      if (pri === 0 || pri == null) return `<div class="scorecard-delta delta-flat">no prior</div>`;
      const chg = (cur - pri) / pri * 100; const good = lowerBetter ? chg < 0 : chg > 0;
      const cls = Math.abs(chg) < 0.5 ? 'delta-flat' : (good ? 'delta-good' : 'delta-bad');
      const arrow = chg > 0 ? '▲' : (chg < 0 ? '▼' : '■');
      return `<div class="scorecard-delta ${cls}">${arrow} ${Math.abs(chg).toFixed(1)}% vs prior</div>`;
    }

    /* Revenue-integrity guard (US-010): in ROAS mode a window with blended revenue 0
     * while spend > 0 means the gated revenue column is missing/zeroed. Always false
     * in CPA mode, so CPA scorecards are unchanged. */
    const revBroken = (typeof applyRevenueGuard === 'function')
      ? applyRevenueGuard('li-summary-revenue-guard', revenueSignalBroken(tot.cur.revenue, tot.cur.spend))
      : false;

    const spendCard = { label: 'Spend',       val: fmt$(tot.cur.spend),         d: deltaHtml(tot.cur.spend, tot.pri.spend, false) };
    const convCard  = { label: 'Conversions', val: fmtNum(tot.cur.conv),        d: deltaHtml(tot.cur.conv, tot.pri.conv, false) };
    const imprCard  = { label: 'Impressions', val: fmtNum(tot.cur.impressions), d: deltaHtml(tot.cur.impressions, tot.pri.impressions, false) };
    const blendCard = revBroken
      ? { label: 'Blended ' + m.label, val: '–', d: `<div class="scorecard-delta delta-flat">revenue check needed</div>` }
      : { label: 'Blended ' + m.label, val: fmtMetric(mCur, m), d: deltaHtml(mCur, mPri, m.dir === 'lower') };
    const viewCard  = { label: 'View rate (2s)',  val: viewCur != null ? fmtPct(viewCur, 2) : '–', d: `<div class="scorecard-delta delta-flat">attention</div>` };
    const holdCard  = { label: 'Hold rate (50%)', val: holdCur != null ? fmtPct(holdCur, 2) : '–', d: `<div class="scorecard-delta delta-flat">retention</div>` };
    const outCard   = { label: 'Outbound CTR',    val: outCur  != null ? fmtPct(outCur, 3)  : '–', d: `<div class="scorecard-delta delta-flat">landing-page clicks</div>` };
    /* ROAS leads with the revenue story; CPA leads with spend/conversions. LinkedIn
     * always shows outbound CTR, because raw CTR is not the intent read here. */
    const cards = liIsRoas()
      ? [ spendCard, { label: 'Revenue', val: fmt$(tot.cur.revenue), d: deltaHtml(tot.cur.revenue, tot.pri.revenue, false) }, blendCard, convCard, viewCard, holdCard, outCard ]
      : [ spendCard, convCard, imprCard, blendCard, viewCard, holdCard, outCard ];
    document.getElementById('li-summary-scorecards').innerHTML = cards.map((c2) =>
      `<div class="scorecard"><div class="scorecard-label">${c2.label}</div><div class="scorecard-value">${c2.val}</div>${c2.d}</div>`
    ).join('');

    /* Blended metric decomposition — split the change in the blended metric into the
     * efficiency effect (creatives themselves getting better/worse) vs mix & flow
     * (budget shifting between ads, entrants/exits). Same method as Meta. */
    const denTotPri = tot.pri[m.den]; let efficiency = 0;
    all.forEach((a) => { const dPri = a.pri[m.den], dCur = a.cur[m.den]; if (dPri > 0 && dCur > 0) { const wPri = dPri / denTotPri; const Mp = (a.pri[m.num] / dPri) * m.scale, Mc = (a.cur[m.num] / dCur) * m.scale; efficiency += wPri * (Mc - Mp); } });
    const total = (mCur != null && mPri != null) ? (mCur - mPri) : 0;
    const mixFlow = total - efficiency;
    liDrawDecomp(mPri || 0, mixFlow, efficiency, mCur || 0, m);
    const lowerBetter = m.dir === 'lower';
    const effWord = (v) => { if (Math.abs(v) < 1e-9) return 'no change'; const worse = lowerBetter ? v > 0 : v < 0; return (worse ? 'worsened' : 'improved') + ' the metric by ' + fmtMetric(Math.abs(v), m); };
    const note = document.getElementById('li-decomp-note');
    if (note) note.innerHTML = `<strong>Efficiency effect:</strong> creatives themselves ${effWord(efficiency)}. <strong>Mix &amp; flow:</strong> budget reallocation + entrants/exits ${effWord(mixFlow)}. These sum to the total blended ${m.label} change of ${fmtMetric(total, m)}.`;

    hideEl('li-summary-loading'); showEl('li-summary-body');
  }

  /* Waterfall: Prior -> (Mix & flow) -> (Efficiency) -> Current, as floating bars.
   * Green when a step improves the metric, red when it worsens it (direction-aware). */
  function liDrawDecomp(prior, mix, eff, current, m) {
    const lowerBetter = m.dir === 'lower';
    const colorFor = (v) => { const worse = lowerBetter ? v > 0 : v < 0; return worse ? getCSS('--bad') : getCSS('--good'); };
    const after1 = prior + mix;
    const labels = ['Prior', 'Mix & flow', 'Efficiency', 'Current'];
    const ranges = [[0, prior], [Math.min(prior, after1), Math.max(prior, after1)], [Math.min(after1, current), Math.max(after1, current)], [0, current]];
    const colors = [getCSS('--young-blood'), colorFor(mix), colorFor(eff), getCSS('--young-blood')];
    if (liCharts.decomp) liCharts.decomp.destroy();
    liCharts.decomp = new Chart(document.getElementById('li-decomp-chart'), {
      type: 'bar',
      data: { labels, datasets: [{ data: ranges, backgroundColor: colors, borderColor: colors, borderWidth: 1 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => { const i = ctx.dataIndex; if (i === 0) return 'Prior blended: ' + fmtMetric(prior, m); if (i === 3) return 'Current blended: ' + fmtMetric(current, m); const v = i === 1 ? mix : eff; return labels[i] + ': ' + (v >= 0 ? '+' : '') + fmtMetric(v, m); } } } },
        scales: { y: { title: { display: true, text: m.label, font: { size: 10 } }, ticks: { callback: (v) => m.fmt === 'money' ? '$' + v : v + '%' } } },
      },
    });
  }

  function liRenderBoard(movers, c) {
    const m = c.metric;
    const head = document.getElementById('li-board-m-head'); if (head) head.textContent = m.label;
    const order = ['Scaling Winner', 'Fading', 'New Entrant', 'Efficient but Shrinking', 'Dropped Off', 'Steady'];
    const legend = document.getElementById('li-board-legend');
    if (legend) legend.innerHTML = order.map((s) => `<span class="li"${stateDefAttr(s)}><span class="dot" style="background:${STATE_META[s].color}"></span>${stateLabel(s)}</span>`).join('');
    const rows = movers.slice().sort((a, b) => b.sCur - a.sCur);
    const body = document.getElementById('li-board-body');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="12" class="no-data">No ads cleared the spend floor in this window. Lower the floor or widen the window.</td></tr>`;
    } else {
      renderPagedTable('li-board-body', rows.map((a) => {
        const sm = STATE_META[a.state], sd = a.spendDelta;
        const sdCls = Math.abs(sd) < 1 ? 'delta-flat' : (sd > 0 ? 'delta-good' : 'delta-bad');
        let mdHtml = '–';
        if (a.metricDelta != null) { const worse = m.dir === 'lower' ? a.metricDelta > 0 : a.metricDelta < 0; const cls = Math.abs(a.metricDelta) < 1e-6 ? 'delta-flat' : (worse ? 'delta-bad' : 'delta-good'); mdHtml = `<span class="${cls}">${a.metricDelta > 0 ? '+' : ''}${fmtMetric(a.metricDelta, m)}</span>`; }
        const cr = creativeRates(a.cur, PROFILE); registerAdMetrics(a.ad_id, a.cur, PROFILE);
        return `<tr>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;" title="${a.ad_name || ''}">${a.ad_name || '–'}<br><span style="color:var(--grey);font-size:10px;">${a.campaign_name || ''}</span></td>
          <td><span class="badge ${sm.cls}"${stateDefAttr(a.state)}>${stateLabel(a.state)}</span></td>
          <td class="num">${fmt$(a.sCur)}</td>
          <td class="num delta-cell ${sdCls}">${sd > 0 ? '+' : ''}${fmt$(sd)}</td>
          <td class="num">${fmtMetric(a.mCur, m)}</td>
          <td class="num delta-cell">${mdHtml}</td>
          <td class="num">${fmtNum(a.cur.conv)}</td>
          <td class="num">${fmtNum(a.cur.impressions)}</td>
          <td class="num">${cr.hook != null ? fmtPct(cr.hook, 2) : '–'}</td>
          <td class="num">${cr.hold != null ? fmtPct(cr.hold, 2) : '–'}</td>
          <td class="num">${cr.outboundCtr != null ? fmtPct(cr.outboundCtr, 3) : '–'}</td>
          <td>${a.creative_link ? `<a class="preview-link" data-ad-id="${a.ad_id}" data-platform="linkedin" href="${a.creative_link}" target="_blank">View</a>` : '–'}</td>
        </tr>`;
      }));
    }
    const title = document.getElementById('li-board-title'); if (title) title.textContent = `Ad Movement — ${rows.length} ads`;
    hideEl('li-board-loading'); showEl('li-board-table');
  }

  /* ── Movement Map ──
   * Bubble chart of the same qualifying creatives the Board lists: x = current-window
   * spend (how much the creative carries), y = % change in the active efficiency
   * metric vs the prior window (up = better), bubble size = current spend, colour =
   * ad state. Mirrors renderMap() in f10-weekly.js; it needs NO query of its own
   * because the movers array is already computed once per window fetch. */
  function liRenderMap(movers, c) {
    const m = c.metric;
    const pts = movers.filter((a) => a.improvePct != null && a.sCur > 0);
    const byState = {};
    pts.forEach((a) => { (byState[a.state] = byState[a.state] || []).push({ x: a.sCur, y: a.improvePct * 100, r: 0, _spend: a.sCur, _name: a.ad_name, _state: a.state }); });
    const maxSpend = Math.max(1, ...pts.map((p) => p.sCur));
    const datasets = Object.entries(byState).map(([s, arr]) => ({
      label: stateLabel(s),
      data: arr.map((p) => Object.assign({}, p, { r: 6 + 22 * Math.sqrt(p._spend / maxSpend) })),
      backgroundColor: STATE_META[s].color + 'bb',
      borderColor: STATE_META[s].color,
      borderWidth: 1.5,
    }));
    liHide('li-map-loading'); liShow('li-map-wrapper');
    if (liCharts.map) { liCharts.map.destroy(); liCharts.map = null; }
    const wrap = document.getElementById('li-map-wrapper');
    if (!wrap) return;
    if (!pts.length) {
      wrap.innerHTML = '<div class="no-data">No creatives with a comparable metric in both windows. New entrants and zero-conversion creatives appear on the Board instead.</div>';
      return;
    }
    wrap.innerHTML = '<canvas id="li-map-chart"></canvas>';
    liCharts.map = new Chart(document.getElementById('li-map-chart'), {
      type: 'bubble', data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: 'Current window spend ($)', font: { size: 11 } }, min: 0, ticks: { callback: (v) => '$' + v.toLocaleString() } },
          y: { title: { display: true, text: `${m.label} change vs prior (%, up = better)`, font: { size: 11 } }, ticks: { callback: (v) => v + '%' } },
        },
        plugins: { legend: { position: 'top', labels: { font: { size: 11 } } }, tooltip: { callbacks: { label: (ctx) => { const p = ctx.raw; return [p._name || '', stateLabel(p._state), `Spend: $${p._spend.toLocaleString()}`, `${m.label} change: ${p.y > 0 ? '+' : ''}${p.y.toFixed(1)}%`]; } } } },
      },
      plugins: [{ id: 'zeroLine', afterDraw(chart){ const yA = chart.scales.y, xA = chart.scales.x; const y0 = yA.getPixelForValue(0); if (y0 >= yA.top && y0 <= yA.bottom){ const ctx2 = chart.ctx; ctx2.save(); ctx2.setLineDash([5, 4]); ctx2.strokeStyle = '#727272'; ctx2.lineWidth = 1.5; ctx2.beginPath(); ctx2.moveTo(xA.left, y0); ctx2.lineTo(xA.right, y0); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle = '#727272'; ctx2.font = '10px Archivo'; ctx2.fillText('no change', xA.left + 4, y0 - 4); ctx2.restore(); } } }],
    });
  }

  /* ── Ad Production (lifetime spend vs CPA/ROAS classification) ── */

  /* Pure SQL builders for the Ad Production tab (scatter + monthly rollup). */
  function liProductionSQL() {
    const isRoas = liIsRoas();
    const mCol = liLifetimeMetricCol();
    const perAdMetricSQL = liLifetimeMetricSQL('ANY_VALUE(lifetime_spend)', `SUM(${liConv()})`);
    const scatterSQL = `
      WITH per_ad AS (
        SELECT ad_id, ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adgroup_name) AS adgroup_name,
          MIN(min_date) AS launch_date, ANY_VALUE(creative_link) AS creative_link,
          DATE_DIFF(COALESCE(MAX(date_start), CURRENT_DATE()), MIN(min_date), DAY) AS active_days,
          ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
          ROUND(SUM(${liConv()}), 0) AS total_conversions,
          ROUND(${perAdMetricSQL}, 2) AS ${mCol},
          SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(landing_page_clicks) AS landing_page_clicks,
          SUM(video_views) AS video_views, SUM(video_p50) AS video_p50,
          SUM(video_p100) AS video_p100, SUM(video_starts) AS video_starts
        FROM ${liTable()} GROUP BY 1
      )
      SELECT *, ${liClassificationCaseSQL('lifetime_spend', mCol)} AS classification,
        ${creativeScoreSQL('lifetime_spend', mCol, liScoreOpts())} AS creative_score
      FROM per_ad ORDER BY lifetime_spend DESC`;
    const rollupRevSel = isRoas ? `, ROUND(SUM(${liRevExpr()}), 2) AS period_revenue` : '';
    const rollupAvgSQL = isRoas
      ? `ROUND(SAFE_DIVIDE(SUM(period_revenue), NULLIF(SUM(period_spend), 0)), 2)`
      : `ROUND(SAFE_DIVIDE(SUM(period_spend), NULLIF(SUM(total_conversions), 0)), 0)`;
    const monthlySQL = `
      WITH unique_ads AS (
        SELECT ad_id, MIN(min_date) AS launch_date, ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
          ROUND(${perAdMetricSQL}, 2) AS ${mCol},
          ROUND(SUM(spend), 2) AS period_spend, ROUND(SUM(${liConv()}), 0) AS total_conversions${rollupRevSel}
        FROM ${liTable()} GROUP BY 1 ),
      classified AS ( SELECT *, ${liClassificationCaseSQL('lifetime_spend', mCol)} AS classification FROM unique_ads )
      SELECT FORMAT_DATE('%b %Y', launch_date) AS launch_month, DATE_TRUNC(launch_date, MONTH) AS launch_month_sort,
        COUNT(*) AS ads_launched, COUNTIF(classification='Home Run') AS home_runs, COUNTIF(classification='On Base') AS on_base, COUNTIF(classification='Strike Out') AS strike_outs,
        ROUND(SUM(period_spend), 0) AS total_spend, ${rollupAvgSQL} AS avg_cpa, ROUND(SUM(total_conversions), 0) AS total_conversions
      FROM classified GROUP BY 1, 2 ORDER BY 2 DESC`;
    return { scatterSQL, monthlySQL, mCol, isRoas };
  }

  async function liLoadProduction() {
    const { scatterSQL, monthlySQL, mCol, isRoas } = liProductionSQL();
    try {
      const [scatterData, monthlyData] = await Promise.all([runQuery(scatterSQL), runQuery(monthlySQL)]);
      const revBroken = isRoas
        && scatterData.some((r) => (Number(r.lifetime_spend) || 0) > 0)
        && !scatterData.some((r) => (Number(r[mCol]) || 0) > 0);
      if (typeof applyRevenueGuard === 'function') applyRevenueGuard('li-production-revenue-guard', revBroken);
      const totals = scatterData.reduce((acc, r) => { acc.total++; if (r.classification === 'Home Run') acc.hr++; if (r.classification === 'On Base') acc.ob++; if (r.classification === 'Strike Out') acc.so++; return acc; }, { total: 0, hr: 0, ob: 0, so: 0 });
      const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      setTxt('li-sc-ads-produced', fmtNum(totals.total));
      setTxt('li-sc-home-runs', fmtNum(totals.hr));
      setTxt('li-sc-hr-rate', totals.total ? fmtPct(totals.hr / totals.total * 100) : '–');
      setTxt('li-sc-on-base', fmtNum(totals.ob));
      setTxt('li-sc-ob-rate', totals.total ? fmtPct(totals.ob / totals.total * 100) : '–');
      setTxt('li-sc-strike-outs', fmtNum(totals.so));
      setTxt('li-sc-so-rate', totals.total ? fmtPct(totals.so / totals.total * 100) : '–');
      hideEl('li-production-scorecards-loading'); showEl('li-production-scorecards');

      const byClass = {}; classificationTiers().forEach((t) => { byClass[t] = []; });
      scatterData.forEach((r) => { const mVal = Number(r[mCol]) || 0, spend = Number(r.lifetime_spend) || 0; if (mVal > 0 || spend > 0) { const cls = r.classification; if (!byClass[cls]) byClass[cls] = []; byClass[cls].push({ x: spend, y: mVal, label: r.ad_name }); } });
      const scatterDatasets = Object.entries(byClass).map(([cls, pts]) => { const col = CLASS_COLOR[cls] || '#b0b0b0'; return { label: cls, data: pts, backgroundColor: col + 'bb', borderColor: col, borderWidth: 1.5, pointRadius: 6, pointHoverRadius: 8 }; });
      hideEl('li-scatter-loading'); showEl('li-scatter-wrapper');
      if (liCharts.scatter) liCharts.scatter.destroy();
      const topSpend = Math.max(0, ...scatterData.map((r) => Number(r.lifetime_spend) || 0));
      const maxSpend = topSpend > LI_TH.HR_SPEND ? topSpend + 1000 : LI_TH.HR_SPEND * 1.2;
      const yFloor = isRoas ? LI_TH.HR_ROAS : 100;
      const maxY = Math.ceil(Math.max(...scatterData.filter((r) => Number(r[mCol]) > 0).map((r) => Number(r[mCol]) || 0), yFloor) * 1.2);
      liCharts.scatter = new Chart(document.getElementById('li-scatter-chart'), {
        type: 'scatter', data: { datasets: scatterDatasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { x: { title: { display: true, text: 'Lifetime Spend ($)', font: { size: 11 } }, min: 0, max: maxSpend, ticks: { callback: (v) => fmt$(v) } }, y: { title: { display: true, text: `Lifetime ${targetMetricDef().label} (${isRoas ? 'x' : '$'})`, font: { size: 11 } }, min: 0, max: maxY, ticks: { callback: (v) => fmtMetricCell(v) } } },
          plugins: { legend: { position: 'top', labels: { font: { size: 11 } } }, tooltip: { callbacks: { label: (ctx) => { const pt = ctx.raw; const mLine = isRoas ? `${targetMetricDef().label}: ${fmtMetricCell(pt.y)}` : `CPA: ${pt.y > 0 ? fmt$(pt.y) : 'N/A'}`; return [`${ctx.dataset.label}`, `Spend: ${fmt$(pt.x)}`, mLine]; } } } },
        },
      });

      const months = monthlyData.map((r) => r.launch_month).reverse();
      const adsArr = monthlyData.map((r) => Number(r.ads_launched)).reverse();
      const hrRates = monthlyData.map((r) => +(Number(r.home_runs) / Number(r.ads_launched) * 100).toFixed(1)).reverse();
      const obRates = monthlyData.map((r) => +(Number(r.on_base) / Number(r.ads_launched) * 100).toFixed(1)).reverse();
      const soRates = monthlyData.map((r) => +(Number(r.strike_outs) / Number(r.ads_launched) * 100).toFixed(1)).reverse();
      hideEl('li-production-chart-loading'); showEl('li-production-chart-wrapper');
      if (liCharts.production) liCharts.production.destroy();
      liCharts.production = new Chart(document.getElementById('li-production-chart'), {
        type: 'bar', data: { labels: months, datasets: [
          { type: 'bar', label: 'Ads Launched', data: adsArr, backgroundColor: '#e6e6e6', borderColor: '#b0b0b0', borderWidth: 1, yAxisID: 'y', order: 1 },
          { type: 'line', label: 'Home Run Rate', data: hrRates, borderColor: CHART_PRIMARY, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 4, yAxisID: 'y2', tension: 0.3, order: 0 },
          { type: 'line', label: 'On Base Rate', data: obRates, borderColor: CHART_SECONDARY, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 4, yAxisID: 'y2', tension: 0.3, order: 0 },
          { type: 'line', label: 'Strike Out Rate', data: soRates, borderColor: CHART_NEGATIVE, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 4, yAxisID: 'y2', tension: 0.3, borderDash: [4, 3], order: 0 } ] },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { font: { size: 10 } } }, y: { title: { display: true, text: 'Ads Launched', font: { size: 10 } }, ticks: { font: { size: 10 } } }, y2: { position: 'right', title: { display: true, text: 'Rate (%)', font: { size: 10 } }, ticks: { callback: (v) => v + '%', font: { size: 10 } }, grid: { drawOnChartArea: false } } }, plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } } },
      });

      renderPagedTable('li-scatter-table-body', scatterData.map((r) => {
        const cls = r.classification; const badgeClass = cls === 'Home Run' ? 'badge-hr' : cls === 'On Base' ? 'badge-ob' : cls === 'Strike Out' ? 'badge-so' : 'badge-un';
        const ce = { impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, landing_page_clicks: Number(r.landing_page_clicks) || 0, video_views: Number(r.video_views) || 0, video_p50: Number(r.video_p50) || 0, video_p100: Number(r.video_p100) || 0, video_starts: Number(r.video_starts) || 0 };
        const cr = creativeRates(ce, PROFILE);
        /* Feed the hover the OUTBOUND CTR, because that is the rate liScoreOpts fed
         * the SQL — the breakdown must explain the score it is shown next to. */
        registerAdMetrics(r.ad_id, ce, PROFILE, creativeScoreHover(r.creative_score, { spend: r.lifetime_spend, metric: r[mCol], hook: cr.hook, hold: cr.hold, ctr: cr.outboundCtr, completion: cr.completion, hasVideo: cr.hasVideo, activeDays: r.active_days }, liScoreOpts()));
        return `<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adgroup_name}">${r.adgroup_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmt$(r.lifetime_spend)}</td><td>${Number(r[mCol]) > 0 ? fmtMetricCell(r[mCol]) : '–'}</td><td>${fmtNum(r.total_conversions)}</td><td class="num">${cr.hook != null ? fmtPct(cr.hook, 2) : '–'}</td><td class="num">${cr.hold != null ? fmtPct(cr.hold, 2) : '–'}</td><td class="num">${cr.completion != null ? fmtPct(cr.completion, 2) : '–'}</td><td>${r.creative_link ? `<a class="preview-link" data-ad-id="${r.ad_id}" data-platform="linkedin" href="${r.creative_link}" target="_blank">Preview</a>` : '–'}</td><td><span class="badge ${badgeClass}">${cls}</span></td><td>${creativeScoreBadge(r.creative_score)}</td></tr>`;
      }));
      hideEl('li-scatter-table-loading'); showEl('li-scatter-table');
    } catch (err) { console.error('LinkedIn production error:', err); }
  }

  /* ── Ad Power Law ──
   * Spend concentration over the last 90 days: every creative ranked by its share of
   * total spend, with a rolling cumulative line. Mirrors loadPowerLaw() in
   * f10-monthly.js against the RESOLVED LinkedIn source, so it works unchanged in
   * Mode 1, Mode 1b and shared-account mode. Two divergences from the Meta shape,
   * both forced by the normalised LinkedIn contract:
   *   • there is no `max_date` column, so "last spend" is MAX(date_start);
   *   • the structural split column is `adgroup_name` (the campaign objective in
   *     shared-account mode), not Meta's `adset_name`.
   * SAFE_DIVIDE guards the share maths so an all-zero-spend 90-day window renders an
   * empty chart rather than erroring on a divide by zero. */
  function liPowerLawSQL() {
    const mCol = liLifetimeMetricCol();
    return `
      WITH ad_spend AS (
        SELECT ad_id, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adgroup_name) AS adgroup_name, ANY_VALUE(ad_name) AS ad_name,
          MIN(min_date) AS launch_date, MAX(date_start) AS last_spend_date, ANY_VALUE(creative_link) AS preview_link,
          ROUND(SUM(spend), 2) AS period_spend,
          ROUND(${liLifetimeMetricSQL('SUM(spend)', `SUM(${liConv()})`)}, 2) AS ${mCol}
        FROM ${liTable()}
        WHERE date_start >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
        GROUP BY 1
        /* A creative can have rows inside the window with no spend on any of them
           (LinkedIn marts carry a row per creative per day whether or not it served),
           which on the live Skip mart put two null-spend creatives into the ranking at
           #16 and #17 with a blank spend and a blank share. They contribute nothing to
           a spend-concentration read, so they are dropped rather than ranked. */
        HAVING period_spend > 0 ),
      total AS ( SELECT SUM(period_spend) AS grand_total FROM ad_spend )
      SELECT ROW_NUMBER() OVER (ORDER BY a.period_spend DESC) AS rank_num,
        a.ad_id, a.campaign_name, a.adgroup_name, a.ad_name, a.launch_date, a.last_spend_date, a.preview_link,
        a.period_spend AS spend,
        ROUND(SAFE_DIVIDE(a.period_spend, t.grand_total) * 100, 2) AS spend_pct,
        ROUND(SUM(SAFE_DIVIDE(a.period_spend, t.grand_total) * 100) OVER (ORDER BY a.period_spend DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2) AS rolling_pct,
        a.${mCol}
      FROM ad_spend a, total t ORDER BY a.period_spend DESC`;
  }

  async function liLoadPowerLaw() {
    const mCol = liLifetimeMetricCol();
    try {
      const data = await runQuery(liPowerLawSQL());
      const labels = data.map((r) => `#${r.rank_num}`);
      const pcts = data.map((r) => Number(r.spend_pct) || 0);
      const rolling = data.map((r) => Number(r.rolling_pct) || 0);
      liHide('li-powerlaw-chart-loading'); liShow('li-powerlaw-chart-wrapper');
      if (liCharts.powerlaw) liCharts.powerlaw.destroy();
      liCharts.powerlaw = new Chart(document.getElementById('li-powerlaw-chart'), {
        type: 'bar', data: { labels, datasets: [
          { type: 'bar', label: '% of Spend', data: pcts, backgroundColor: getCSS('--young-blood') + '99', borderColor: getCSS('--young-blood'), borderWidth: 1, yAxisID: 'y' },
          { type: 'line', label: '% Rolling Cumulative', data: rolling, borderColor: CHART_PRIMARY, backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 3, yAxisID: 'y2', tension: 0.2 } ] },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { font: { size: 10 } } }, y: { title: { display: true, text: '% of Spend', font: { size: 10 } }, ticks: { callback: (v) => v + '%' } }, y2: { position: 'right', min: 0, max: 100, title: { display: true, text: 'Cumulative %', font: { size: 10 } }, ticks: { callback: (v) => v + '%', font: { size: 10 } }, grid: { drawOnChartArea: false } } }, plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } } },
      });
      renderPagedTable('li-powerlaw-table-body', data.map((r) =>
        `<tr><td class="rank-num">${r.rank_num}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name || ''}">${r.campaign_name || '–'}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adgroup_name || ''}">${r.adgroup_name || '–'}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name || ''}">${r.ad_name || '–'}</td><td>${fmtDate(r.launch_date)}</td><td>${fmtDate(r.last_spend_date)}</td><td>${r.preview_link ? `<a class="preview-link" data-ad-id="${r.ad_id}" data-platform="linkedin" href="${r.preview_link}" target="_blank">Preview</a>` : '–'}</td><td>${fmt$(r.spend)}</td><td>${fmtPct(r.spend_pct, 2)}</td><td>${fmtPct(r.rolling_pct, 2)}</td><td>${Number(r[mCol]) > 0 ? fmtMetricCell(r[mCol]) : '–'}</td></tr>`));
      liHide('li-powerlaw-table-loading'); liShow('li-powerlaw-table');
    } catch (err) { console.error('LinkedIn power law error:', err); const el = document.getElementById('li-powerlaw-table-loading'); if (el) el.innerHTML = 'Error loading data: ' + err.message; }
  }

  /* ── Ad Decay ──
   * Launch-month cohorts: how a month's creatives keep (or stop) carrying spend.
   * Mirrors loadDecay() in f10-monthly.js. The cohort summary is computed per
   * creative FIRST (a `per_ad` CTE) and only then rolled up by launch month, because
   * the LinkedIn contract has no `max_date` column — the per-creative last active day
   * is MAX(date_start), which only exists once rows are collapsed to one per creative.
   * That also makes "avg days running" a true per-creative average rather than one
   * weighted by how many daily rows each creative happens to have. */
  function liDecaySQL() {
    const isRoas = liIsRoas();
    const revSel = isRoas ? `, SUM(${liRevExpr()}) AS revenue` : '';
    /* Cohort efficiency: CPA (SUM(spend)/SUM(conv), 0 dp) or, in ROAS mode, cohort
       ROAS (SUM(revenue)/SUM(spend), 2 dp). The alias stays `cpa` so the render and
       grand-total plumbing matches the Meta tab. */
    const cohortMetricSQL = isRoas
      ? `ROUND(SAFE_DIVIDE(SUM(revenue), NULLIF(SUM(ad_spend), 0)), 2)`
      : `ROUND(SAFE_DIVIDE(SUM(ad_spend), NULLIF(SUM(ad_conversions), 0)), 0)`;
    const summarySQL = `
      WITH per_ad AS (
        SELECT ad_id, MIN(min_date) AS launch_date, MAX(date_start) AS last_active_date,
          SUM(spend) AS ad_spend, SUM(${liConv()}) AS ad_conversions${revSel}
        FROM ${liTable()} GROUP BY 1 )
      SELECT FORMAT_DATE('%b %Y', launch_date) AS launch_month, DATE_TRUNC(launch_date, MONTH) AS launch_month_sort,
        COUNT(DISTINCT ad_id) AS ads_launched,
        ROUND(AVG(DATE_DIFF(COALESCE(last_active_date, CURRENT_DATE()), launch_date, DAY)), 0) AS avg_days_running,
        ROUND(SUM(ad_spend), 0) AS total_spend,
        ${cohortMetricSQL} AS cpa
      FROM per_ad GROUP BY 1, 2 ORDER BY 2 DESC`;
    const dailySQL = `
      SELECT FORMAT_DATE('%b %Y', min_date) AS launch_month, DATE_TRUNC(min_date, MONTH) AS launch_month_sort,
        date_start, ROUND(SUM(spend), 2) AS daily_spend
      FROM ${liTable()} GROUP BY 1, 2, 3 ORDER BY 3, 2`;
    return { summarySQL, dailySQL };
  }

  async function liLoadDecay() {
    const { summarySQL, dailySQL } = liDecaySQL();
    try {
      const [summary, daily] = await Promise.all([runQuery(summarySQL), runQuery(dailySQL)]);
      let totalAds = 0, totalSpend = 0;
      const rows = summary.map((r) => {
        totalAds += Number(r.ads_launched) || 0; totalSpend += Number(r.total_spend) || 0;
        return `<tr><td>${r.launch_month}</td><td>${fmtNum(r.ads_launched)}</td><td>${r.avg_days_running != null ? r.avg_days_running + 'd' : '–'}</td><td>${fmt$(r.total_spend)}</td><td>${r.cpa && Number(r.cpa) > 0 ? fmtMetricCell(r.cpa) : '–'}</td></tr>`;
      });
      renderPagedTable('li-decay-summary-body', rows, 20, `<tr style="font-weight:600; background:var(--paper);"><td>Grand Total</td><td>${fmtNum(totalAds)}</td><td>–</td><td>${fmt$(totalSpend)}</td><td>–</td></tr>`);
      liHide('li-decay-summary-loading'); liShow('li-decay-summary-table');
      const cohorts = [...new Set(daily.map((r) => r.launch_month))];
      const dates = [...new Set(daily.map((r) => bqStr(r.date_start)))].sort();
      const spendMap = {}; daily.forEach((r) => { spendMap[r.launch_month + '|' + bqStr(r.date_start)] = Number(r.daily_spend) || 0; });
      const datasets = cohorts.map((c, i) => ({ label: c, data: dates.map((d) => spendMap[c + '|' + d] || 0), backgroundColor: COHORT_COLORS[i % COHORT_COLORS.length] + '99', borderColor: COHORT_COLORS[i % COHORT_COLORS.length], borderWidth: 2, fill: true, tension: 0.3, pointRadius: 3 }));
      liHide('li-decay-chart-loading'); liShow('li-decay-chart-wrapper');
      if (liCharts.decay) liCharts.decay.destroy();
      liCharts.decay = new Chart(document.getElementById('li-decay-chart'), {
        type: 'line', data: { labels: dates.map((d) => fmtDate(d)), datasets },
        options: { responsive: true, maintainAspectRatio: true, scales: { x: { stacked: true, ticks: { font: { size: 10 }, maxRotation: 45 } }, y: { stacked: true, ticks: { callback: (v) => '$' + v.toLocaleString() } } }, plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } } },
      });
      const dayTotals = dates.map((d) => cohorts.reduce((s, c) => s + (spendMap[c + '|' + d] || 0), 0));
      const pctDatasets = cohorts.map((c, i) => ({ label: c, data: dates.map((d, j) => dayTotals[j] > 0 ? (spendMap[c + '|' + d] || 0) / dayTotals[j] * 100 : 0), backgroundColor: COHORT_COLORS[i % COHORT_COLORS.length] + 'cc', borderColor: COHORT_COLORS[i % COHORT_COLORS.length], borderWidth: 1, fill: true }));
      liHide('li-decay-pct-loading'); liShow('li-decay-pct-wrapper');
      if (liCharts.decayPct) liCharts.decayPct.destroy();
      liCharts.decayPct = new Chart(document.getElementById('li-decay-pct-chart'), {
        type: 'bar', data: { labels: dates.map((d) => fmtDate(d)), datasets: pctDatasets },
        options: { responsive: true, maintainAspectRatio: true, scales: { x: { stacked: true, ticks: { font: { size: 10 }, maxRotation: 45 } }, y: { stacked: true, max: 100, ticks: { callback: (v) => v + '%' } } }, plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } } },
      });
    } catch (err) { console.error('LinkedIn decay error:', err); const el = document.getElementById('li-decay-summary-loading'); if (el) el.innerHTML = 'Error loading data: ' + err.message; }
  }

  /* ── Ad Age ──
   * Daily spend mix by creative age (0–14 / 15–90 / 90+ days since launch) plus the
   * per-creative library. Mirrors loadAge() in f10-monthly.js, except the age bucket
   * is DERIVED from date_start − min_date rather than read from a precomputed
   * `creative_age` column — see liAgeBucketSQL() above for why that column cannot be
   * trusted on LinkedIn, and for the LINKEDIN.AGE_BUCKET_EXPR escape hatch. */
  function liAgeSQL() {
    const mCol = liLifetimeMetricCol();
    const ageSQL = `
      SELECT date_start, ${liAgeBucketSQL()} AS age_bucket, ROUND(SUM(spend), 2) AS daily_spend
      FROM ${liTable()} GROUP BY 1, 2 ORDER BY 1, 2`;
    const tableSQL = `
      SELECT ad_id, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adgroup_name) AS adgroup_name, ANY_VALUE(ad_name) AS ad_name,
        MIN(min_date) AS launch_date, MAX(date_start) AS last_spend, ANY_VALUE(creative_link) AS preview_link,
        ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
        ROUND(${liLifetimeMetricSQL('ANY_VALUE(lifetime_spend)', `SUM(${liConv()})`)}, 2) AS ${mCol},
        ROUND(SUM(${liConv()}), 0) AS total_conversions
      FROM ${liTable()} GROUP BY 1 ORDER BY lifetime_spend DESC`;
    return { ageSQL, tableSQL };
  }

  async function liLoadAge() {
    const { ageSQL, tableSQL } = liAgeSQL();
    const mCol = liLifetimeMetricCol();
    try {
      const [ageData, tableData] = await Promise.all([runQuery(ageSQL), runQuery(tableSQL)]);
      const dates = [...new Set(ageData.map((r) => bqStr(r.date_start)))].sort();
      const spendMap = {}; ageData.forEach((r) => { spendMap[bqStr(r.date_start) + '|' + r.age_bucket] = Number(r.daily_spend) || 0; });
      const dayTotals = dates.map((d) => LI_AGE_BUCKETS.reduce((s, bk) => s + (spendMap[d + '|' + bk] || 0), 0));
      const ageDatasets = LI_AGE_BUCKETS.map((b) => ({
        label: b,
        data: dates.map((d, i) => dayTotals[i] > 0 ? +((spendMap[d + '|' + b] || 0) / dayTotals[i] * 100).toFixed(1) : 0),
        backgroundColor: AGE_COLORS[b] + 'dd', borderColor: AGE_COLORS[b], borderWidth: 1,
      }));
      liHide('li-age-chart-loading'); liShow('li-age-chart-wrapper');
      if (liCharts.age) liCharts.age.destroy();
      liCharts.age = new Chart(document.getElementById('li-age-chart'), {
        type: 'bar', data: { labels: dates.map((d) => fmtDate(d)), datasets: ageDatasets },
        options: { responsive: true, maintainAspectRatio: true, scales: { x: { stacked: true, ticks: { font: { size: 10 }, maxRotation: 45 } }, y: { stacked: true, max: 100, ticks: { callback: (v) => v + '%' } } }, plugins: { legend: { position: 'top', labels: { font: { size: 11 } } }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw}%` } } } },
      });
      renderPagedTable('li-age-table-body', tableData.map((r) =>
        `<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name || ''}">${r.campaign_name || '–'}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.adgroup_name || ''}">${r.adgroup_name || '–'}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name || ''}">${r.ad_name || '–'}</td><td>${fmtDate(r.launch_date)}</td><td>${fmtDate(r.last_spend)}</td><td>${r.preview_link ? `<a class="preview-link" data-ad-id="${r.ad_id}" data-platform="linkedin" href="${r.preview_link}" target="_blank">Preview</a>` : '–'}</td><td>${fmt$(r.lifetime_spend)}</td><td>${Number(r[mCol]) > 0 ? fmtMetricCell(r[mCol]) : '–'}</td><td>${fmtNum(r.total_conversions)}</td></tr>`));
      liHide('li-age-table-loading'); liShow('li-age-table');
    } catch (err) { console.error('LinkedIn age error:', err); const el = document.getElementById('li-age-table-loading'); if (el) el.innerHTML = 'Error loading data: ' + err.message; }
  }

  /* ── Creative Effectiveness (view / hold / completion / retention) ── */

  /* Pure SQL builder for the Creative Effectiveness tab. */
  function liCreativeSQL() {
    /* Same score inputs and the same liScoreOpts as the Production tab, so a given ad
     * shows the same Creative Score on both tabs. Unlike Meta/TikTok there is no
     * video-only gate on the row filter: LinkedIn runs a lot of single-image and
     * document ads and dropping them would hide most of the account, so every ad with
     * impressions is listed and the video columns simply read '–' for statics. */
    const sql = `
      SELECT *, ${creativeScoreSQL('lifetime_spend', liLifetimeMetricCol(), liScoreOpts())} AS creative_score FROM (
        SELECT ad_id, ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(creative_link) AS creative_link,
          ROUND(SUM(spend), 2) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(landing_page_clicks) AS landing_page_clicks,
          SUM(video_starts) AS video_starts, SUM(video_views) AS video_views,
          SUM(video_p25) AS video_p25, SUM(video_p50) AS video_p50, SUM(video_p75) AS video_p75, SUM(video_p100) AS video_p100,
          ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
          ROUND(SUM(${liConv()}), 0) AS total_conversions,
          ROUND(${liLifetimeMetricSQL('ANY_VALUE(lifetime_spend)', `SUM(${liConv()})`)}, 2) AS ${liLifetimeMetricCol()},
          DATE_DIFF(COALESCE(MAX(date_start), CURRENT_DATE()), MIN(min_date), DAY) AS active_days
        FROM ${liTable()}
        WHERE date_start >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
        GROUP BY 1
      ) WHERE impressions > 0 ORDER BY spend DESC`;
    return sql;
  }

  async function liLoadCreative() {
    try {
      const data = await runQuery(liCreativeSQL());
      let tImpr = 0, tViews = 0, tHold = 0, t25 = 0, t50 = 0, t75 = 0, t100 = 0;
      const rows = data.map((r) => {
        const ce = { impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, landing_page_clicks: Number(r.landing_page_clicks) || 0, video_starts: Number(r.video_starts) || 0, video_views: Number(r.video_views) || 0, video_p25: Number(r.video_p25) || 0, video_p50: Number(r.video_p50) || 0, video_p75: Number(r.video_p75) || 0, video_p100: Number(r.video_p100) || 0 };
        const cr = creativeRates(ce, PROFILE);
        registerAdMetrics(r.ad_id, ce, PROFILE, creativeScoreHover(r.creative_score, { spend: r.lifetime_spend, metric: r[liLifetimeMetricCol()], hook: cr.hook, hold: cr.hold, ctr: cr.outboundCtr, completion: cr.completion, hasVideo: cr.hasVideo, activeDays: r.active_days }, liScoreOpts()));
        tImpr += ce.impressions; tViews += ce.video_views; tHold += ce.video_p50; t25 += ce.video_p25; t50 += ce.video_p50; t75 += ce.video_p75; t100 += ce.video_p100;
        const pct = (v) => v != null ? fmtPct(v, 2) : '–';
        const pv = r.creative_link ? `<a class="preview-link" data-ad-id="${r.ad_id}" data-platform="linkedin" href="${r.creative_link}" target="_blank">Preview</a>` : '–';
        return `<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name || ''}">${r.ad_name || '–'}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name || ''}">${r.campaign_name || '–'}</td><td class="num">${fmt$(r.spend)}</td><td class="num">${fmtNum(ce.impressions)}</td><td class="num">${pct(cr.hook)}</td><td class="num">${pct(cr.hold)}</td><td class="num">${pct(cr.completion)}</td><td class="num">${pct(cr.retention.p25)}</td><td class="num">${pct(cr.retention.p50)}</td><td class="num">${pct(cr.retention.p75)}</td><td class="num">${pct(cr.retention.p100)}</td><td class="num">${pct(cr.ctr)}</td><td class="num">${cr.outboundCtr != null ? fmtPct(cr.outboundCtr, 3) : '–'}</td><td>${pv}</td><td>${creativeScoreBadge(r.creative_score)}</td></tr>`;
      });
      renderPagedTable('li-creative-table-body', rows);
      hideEl('li-creative-table-loading'); showEl('li-creative-table');
      const viewAvg = tImpr > 0 ? +(tViews / tImpr * 100).toFixed(2) : 0;
      const holdAvg = tImpr > 0 ? +(tHold / tImpr * 100).toFixed(2) : 0;
      const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      setTxt('li-creative-hook', fmtPct(viewAvg, 2));
      setTxt('li-creative-hold', fmtPct(holdAvg, 2));
      const curve = [t25, t50, t75, t100].map((v) => tImpr > 0 ? +(v / tImpr * 100).toFixed(2) : 0);
      hideEl('li-creative-chart-loading'); showEl('li-creative-chart-wrapper');
      if (liCharts.creative) liCharts.creative.destroy();
      liCharts.creative = new Chart(document.getElementById('li-creative-chart'), {
        type: 'line',
        data: { labels: ['25%', '50%', '75%', '100%'], datasets: [{ label: '% of impressions reaching', data: curve, borderColor: CHART_PRIMARY, backgroundColor: CHART_PRIMARY+'21', borderWidth: 2.5, pointRadius: 4, fill: true, tension: 0.25 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.label} watched: ${ctx.raw}% of impressions` } } }, scales: { x: { title: { display: true, text: 'Video quartile watched', font: { size: 11 } } }, y: { title: { display: true, text: '% of impressions', font: { size: 11 } }, ticks: { callback: (v) => v + '%' } } } },
      });
    } catch (err) { console.error('LinkedIn creative error:', err); const el = document.getElementById('li-creative-table-loading'); if (el) el.innerHTML = 'Error loading data: ' + err.message; }
  }

  function liLoadTab(tab) {
    liLoaded[tab] = true;
    if (tab === 'li-powerlaw') liLoadPowerLaw();
    if (tab === 'li-production') liLoadProduction();
    if (tab === 'li-decay') liLoadDecay();
    if (tab === 'li-age') liLoadAge();
    if (tab === 'li-creative') liLoadCreative();
    /* li-summary / li-board / li-map load together via liLoadWindows on boot +
     * control changes — one window fetch feeds all three weekly tabs. */
  }

  /* ── Tab system (coordinates with the Meta engine's tabs and the TikTok section) ── */

  function liSelectTab(tab) {
    /* Deactivate everything else. Clearing by the two SHARED shapes — every panel is a
     * `.tab-panel`, every nav link is an `<a>` inside `#sidebar nav` — is the same rule
     * f10ActivateTab uses, so this needs no hand-maintained list of the other modules'
     * nav classes and keeps working as modules are added. */
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('#sidebar nav a').forEach((l) => l.classList.remove('active'));
    const mc = document.getElementById('controls-bar'); if (mc) mc.style.display = 'none';
    const tc = document.getElementById('tt-controls-bar'); if (tc) tc.style.display = 'none';
    /* Activate LinkedIn. */
    document.querySelectorAll('.li-tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.li-nav-link').forEach((l) => l.classList.toggle('active', l.dataset.liTab === tab));
    const panel = document.getElementById('panel-' + tab); if (panel) panel.classList.add('active');
    const title = document.getElementById('page-title'); if (title) title.textContent = liTitles[tab];
    liActive = tab;
    const bar = document.getElementById('li-controls-bar'); if (bar) bar.style.display = liIsWeekly(tab) ? 'flex' : 'none';
    if (window.F10A) F10A.track('tab_viewed', { tab: tab, tab_label: liTitles[tab] });
    if (!liIsWeekly(tab) && !liLoaded[tab]) liLoadTab(tab);
  }

  /* When any OTHER nav link is clicked, drop the LinkedIn active state so only one
   * section shows at a time. That engine handles activating its own panel. */
  function liDeactivateOnOtherNav() {
    document.querySelectorAll('.li-tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.li-nav-link').forEach((l) => l.classList.remove('active'));
    const bar = document.getElementById('li-controls-bar'); if (bar) bar.style.display = 'none';
    liActive = null;
  }

  function liWireControls() {
    document.querySelectorAll('.li-nav-link').forEach((link) =>
      link.addEventListener('click', (e) => { e.preventDefault(); liSelectTab(link.dataset.liTab); })
    );
    /* Delegated, not one listener per link: the modules that register their own nav
     * entries later in boot (Competitors, Component Scale, Creative Review) do not
     * exist in the DOM yet at this point, so a direct bind would miss them and leave a
     * stale LinkedIn highlight when the user switched to one of those tabs. */
    const nav = document.querySelector('#sidebar nav');
    if (nav) nav.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (a && !a.classList.contains('li-nav-link')) liDeactivateOnOtherNav();
    });
    ['li-ctrl-length', 'li-ctrl-enddate'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', liLoadWindows); });
    ['li-ctrl-metric', 'li-ctrl-minspend'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', liRenderWeekly); });
  }

  /* ── Boot ── */

  async function initLinkedIn() {
    liWireControls();
    try {
      LI_MAXDATE = await liFetchMaxDate();
      const ed = document.getElementById('li-ctrl-enddate');
      if (ed && LI_MAXDATE) { ed.value = LI_MAXDATE; ed.max = LI_MAXDATE; }
      await liLoadWindows(); /* pre-load weekly so first click is instant */
      liLoaded['li-summary'] = true; liLoaded['li-board'] = true; liLoaded['li-map'] = true;
    } catch (err) { console.error('LinkedIn boot error:', err); }
  }

  window.initLinkedIn = initLinkedIn;
  /* Test seam. The SQL builders are pure functions of the LINKEDIN config, so the
   * regression test (test/linkedin-channel.test.js) asserts the two source modes
   * without a browser or BigQuery. Read-only; nothing in the UI path uses it. */
  window.f10LinkedInInternals = {
    source: liTable,
    sharedSource: liSharedSourceSQL,
    martTable: liMartTable,
    martRef: liMartRef,
    martOverrides: liMartOverrides,
    martNormalised: liMartNormalised,
    classificationCaseSQL: liClassificationCaseSQL,
    scoreOpts: liScoreOpts,
    maxDateSQL: liMaxDateSQL,
    windowsSQL: liWindowsSQL,
    productionSQL: liProductionSQL,
    powerLawSQL: liPowerLawSQL,
    decaySQL: liDecaySQL,
    ageSQL: liAgeSQL,
    ageBucketSQL: liAgeBucketSQL,
    ageBuckets: LI_AGE_BUCKETS,
    creativeSQL: liCreativeSQL,
    thresholds: LI_TH,
    tabs: LI_TABS,
    titles: liTitles,
    isWeekly: liIsWeekly,
  };
})();
