/**
 * Ad search matching (the "Search ad" box above every ad table).
 *
 * Regression cover for the Skip report that search "doesn't work properly":
 *   - plain phrases missed run-together / underscored ad names
 *     ("moving back in" vs "..._movingbackin_...", "2% deposit" vs "2%deposit");
 *   - campaign names were not searchable even though the tables show them;
 *   - LinkedIn and TikTok rows carried no search key, so search never filtered them.
 *
 * Run: node test/ad-search-matching.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const EXPORT = `
this.__S = {
  adNameAttr, adSearchTokens, filterRowsBySearch, normaliseSearchText,
  setTerm: (v) => { adSearchTerm = v; },
};`;

function load(){
  const sandbox = { window: {}, document: { documentElement: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(UTILS + EXPORT, sandbox, { filename: 'f10-utils.js' });
  return sandbox.__S;
}

let passed = 0;
function check(name, fn){ fn(); passed++; console.log('  ok -', name); }

(() => {
  console.log('Ad search matching');
  const S = load();
  const row = (ad, camp, set) => `<tr ${S.adNameAttr(ad, camp, set)}><td>${ad}</td></tr>`;
  const ROWS = [
    row('100926_all_customer_static_movingbackin_meta_character_v1-homedeck', 'F10_MOF_Consideration_Prospecting_NewAccountCreated_Customer', 'Adv+'),
    row('100926_all_customer_static_2%deposit_meta_character_v1-wheelbarrow', 'F10_BOF_Action_Remarketing_NewAccountCreated_Customer', 'RMKT'),
    row('230926_All_Broker_Static_Upgrade_Meta', 'F10_TOF_Awareness_FullFunnel_LPVs_Broker', 'Brokers'),
    row('Q&A "quoted" ad', 'Brand & Co', ''),
  ];
  const SUMMARY = '<tr><td>Sep 2026</td><td>$1,813</td></tr>';
  const hits = (term, rows) => { S.setTerm(term); return S.filterRowsBySearch(rows || ROWS).length; };

  check('empty or punctuation-only search passes every row', () => {
    assert.strictEqual(hits(''), ROWS.length);
    assert.strictEqual(hits('  %% - '), ROWS.length);
  });

  check('plain phrases match run-together / underscored ad names', () => {
    assert.strictEqual(hits('moving back in'), 1);
    assert.strictEqual(hits('2% deposit'), 1);
    assert.strictEqual(hits('2%deposit'), 1);
    assert.strictEqual(hits('wheel barrow'), 1);
  });

  check('matching is case-insensitive', () => {
    assert.strictEqual(hits('BROKER'), 1);
    assert.strictEqual(hits('Customer'), 2);
  });

  check('campaign and ad set names are searchable', () => {
    assert.strictEqual(hits('consideration'), 1);
    assert.strictEqual(hits('F10_MOF'), 1);
    assert.strictEqual(hits('rmkt'), 1);
  });

  check('every word must match (AND), in any order', () => {
    assert.strictEqual(hits('customer wheelbarrow'), 1);
    assert.strictEqual(hits('wheelbarrow customer'), 1);
    assert.strictEqual(hits('broker wheelbarrow'), 0);
  });

  check('a word never matches across the ad / campaign boundary', () => {
    /* ad ends "...homedeck", campaign starts "f10..." — "homedeckf10" must not match */
    assert.strictEqual(hits('homedeckf10'), 0);
  });

  check('quotes and ampersands in names do not break the attribute or the match', () => {
    const attr = S.adNameAttr('Q&A "quoted" ad', 'Brand & Co');
    assert.ok(!/&|"[^"]*"[^"]*"/.test(attr.replace(/^data-adname="|"$/g, '')), attr);
    assert.strictEqual(hits('q&a quoted'), 1);
    assert.strictEqual(hits('brand & co'), 1);
  });

  check('rows without a search key (summary tables) are never filtered', () => {
    assert.strictEqual(hits('broker', [SUMMARY]), 1);
  });

  check('non-English letters and digits are kept', () => {
    assert.strictEqual(S.normaliseSearchText('Café_2%'), 'café2');
  });

  /* Every ad-level table in every section must carry a search key, or the search
   * box silently does nothing there (the LinkedIn/TikTok bug). */
  check('LinkedIn and TikTok ad rows are tagged for search', () => {
    for (const f of ['f10-linkedin.js', 'f10-tiktok.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const tagged = (src.match(/<tr \$\{adNameAttr\(/g) || []).length;
      assert.strictEqual(tagged, 5, `${f}: expected board, production, power law, age and creative rows tagged, got ${tagged}`);
    }
  });

  check('LinkedIn and TikTok bars each carry a search box', () => {
    const layout = fs.readFileSync(path.join(ROOT, 'f10-layout.js'), 'utf8');
    for (const px of ['li', 'tt']) {
      assert.ok(layout.includes(`id="${px}-ctrl-adsearch" class="ctrl-search"`), `${px} search box missing`);
      assert.ok(layout.includes(`id="${px}-weekly-controls"`), `${px} weekly-controls id missing`);
    }
  });

  console.log(`${passed} passed`);
})();
