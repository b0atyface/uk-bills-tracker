// Bulk summary generator — runs through all active Parliament bills and
// pre-generates AI summaries for any that aren't cached yet.
// Rate-limited to one call per 95 seconds to stay under Sonnet's 30k TPM cap.
//
// Usage: node generate-all.js
// Resumes safely if interrupted — already-cached bills are skipped.

const https = require('https');
const fs = require('fs');
const path = require('path');

const SUMMARIES_FILE = path.join(__dirname, 'data', 'summaries.json');
const DELAY_MS = 95000; // 95s between calls — gives rate limit time to reset

// --prod flag: targets the live Railway server instead of localhost
const PROD = process.argv.includes('--prod');
const API_BASE = PROD
  ? 'https://uk-bills-tracker-production.up.railway.app'
  : 'http://localhost:3457';
if (PROD) console.log('🚀 Running against PRODUCTION:', API_BASE);

const TOPICS = [
  { id: 'lgbtq',        label: 'LGBTQ+',          keywords: ['lgbt', 'gay', 'lesbian', 'bisexual', 'same-sex', 'sexual orientation', 'queer', 'civil partnership'] },
  { id: 'trans',        label: 'Trans rights',     keywords: ['trans ', 'transgender', 'gender identity', 'gender recognition', 'non-binary', 'conversion therapy', 'single-sex'] },
  { id: 'security',     label: 'Security',         keywords: ['national security', 'surveillance', 'terrorism', 'intelligence services', 'investigatory powers', 'espionage', 'cyber'] },
  { id: 'ai',           label: 'AI & algorithms',  keywords: ['artificial intelligence', ' ai ', 'ai bill', 'algorithm', 'automated decision', 'machine learning', 'generative'] },
  { id: 'crypto',       label: 'Crypto',           keywords: ['cryptocurrency', 'crypto', 'digital asset', 'bitcoin', 'blockchain', 'stablecoin', 'cryptoasset'] },
  { id: 'climate',      label: 'Climate',          keywords: ['climate', 'net zero', 'carbon', 'emissions', 'renewable', 'fossil fuel', 'environment'] },
  { id: 'housing',      label: 'Housing',          keywords: ['housing', 'renters', 'leasehold', 'mortgage', 'tenant', 'landlord', 'rent '] },
  { id: 'immigration',  label: 'Immigration',      keywords: ['immigration', 'asylum', 'migrant', 'refugee', 'border', 'visa', 'nationality'] },
  { id: 'policing',     label: 'Policing',         keywords: ['policing', 'police', 'criminal justice', 'stop and search', 'prisons', 'sentencing'] },
  { id: 'protest',      label: 'Protest',          keywords: ['protest', 'demonstration', 'public order', 'assembly', 'picket', 'lock-on'] },
  { id: 'sex-work',     label: 'Sex work & porn',  keywords: ['pornography', 'sex work', 'intimate image', 'obscene', 'adult content', 'prostitution'] },
  { id: 'health',       label: 'NHS & health',     keywords: ['nhs', 'health service', 'tobacco', 'pharmacy'] },
  { id: 'mental-health',label: 'Mental health',    keywords: ['mental health', 'camhs', 'psychiatric'] },
  { id: 'workers',      label: "Workers' rights",  keywords: ['workers', 'employment', 'trade union', 'minimum wage', 'zero hours'] },
  { id: 'education',    label: 'Education',        keywords: ['education', 'schools', 'teachers', 'university', 'student'] },
  { id: 'disability',   label: 'Disability',       keywords: ['disability', 'disabled', 'accessibility', 'pip', ' sen '] },
  { id: 'women',        label: "Women's rights",   keywords: ['women', 'maternity', 'misogyny', 'domestic abuse', 'violence against women'] },
  { id: 'online-safety',label: 'Online safety',    keywords: ['online safety', 'age verification', 'ofcom', 'social media'] },
  { id: 'privacy',      label: 'Data & privacy',   keywords: ['data protection', 'privacy', 'personal data', 'biometric'] },
  { id: 'democracy',    label: 'Democracy',        keywords: ['elections', 'voter', 'electoral', 'constitution', 'house of lords reform'] },
  { id: 'benefits',     label: 'Benefits',         keywords: ['universal credit', 'benefits', 'welfare', 'pension', 'carers'] },
  { id: 'tax',          label: 'Tax',              keywords: ['tax ', 'corporation tax', 'national insurance', ' vat '] },
  { id: 'defence',      label: 'Defence',          keywords: ['defence', 'armed forces', 'military', 'veterans'] },
  { id: 'rural',        label: 'Rural & farming',  keywords: ['farming', 'agriculture', 'countryside', 'rural', 'fisheries'] },
  { id: 'children',     label: 'Children',         keywords: ['children', 'child protection', 'safeguarding'] },
  { id: 'race',         label: 'Racial justice',   keywords: ['racial', 'racism', 'ethnicity', 'discrimination'] },
];

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'uk-bills-tracker/1.0', Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function postJson(rawUrl, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(rawUrl);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function allTopicsForBill(bill) {
  const hay = ` ${bill.shortTitle || ''} ${bill.longTitle || ''} ${bill.summary || ''} `.toLowerCase();
  return TOPICS.filter((t) => t.keywords.some((kw) => hay.includes(kw.toLowerCase())));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadSummaries() {
  try { return JSON.parse(fs.readFileSync(SUMMARIES_FILE, 'utf8')); } catch { return {}; }
}

async function run() {
  console.log('Fetching bill list from Parliament API...');
  const data = await getJson('https://bills-api.parliament.uk/api/v1/Bills?SortOrder=DateUpdatedDescending&take=200');
  const bills = data.items || [];
  console.log(`Found ${bills.length} bills.\n`);

  const summaries = loadSummaries();
  const todo = bills.filter((b) => {
    const cached = summaries[b.billId];
    const topics = allTopicsForBill(b);
    if (topics.length === 0) return false; // no matching topics — skip
    if (!cached || cached.schema !== 6) return true;
    const covered = cached.topics_covered || [];
    return !topics.every((t) => covered.includes(t.id));
  });

  const skip = bills.length - todo.length;
  console.log(`${skip} already cached / no topics. ${todo.length} to generate.\n`);

  if (todo.length === 0) { console.log('All done — nothing to do.'); return; }

  const estimatedMins = Math.ceil((todo.length * DELAY_MS) / 60000);
  console.log(`Estimated time: ~${estimatedMins} minutes at 1 bill per ${DELAY_MS/1000}s.\n`);
  console.log('Starting in 5 seconds — Ctrl+C to stop (progress is saved after each bill)...\n');
  await sleep(5000);

  let done = 0, failed = 0;
  for (const bill of todo) {
    const topics = allTopicsForBill(bill);
    process.stdout.write(`[${done + failed + 1}/${todo.length}] "${bill.shortTitle}" (${topics.length} topics) ... `);
    try {
      const res = await postJson(`${API_BASE}/api/summary`, { billId: bill.billId, bill, topics });
      if (res.body.error) throw new Error(res.body.error);
      const src = res.body.cached ? 'cached' : 'generated';
      console.log(`✓ ${src}`);
      done++;
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failed++;
    }
    if (done + failed < todo.length) {
      process.stdout.write(`  Waiting ${DELAY_MS/1000}s for rate limit...\n`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone. ${done} generated, ${failed} failed.`);
}

run().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
