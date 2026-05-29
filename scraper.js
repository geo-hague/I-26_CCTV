const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const DRIVENC   = 'https://www.drivenc.gov';
const UA        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SOURCE_MAP = [
    { chan: "chan-5373_l", sourceId: "518",  division: "Division 13" },
    { chan: "chan-5374_l", sourceId: "519",  division: "Division 13" },
    { chan: "chan-5375_l", sourceId: "520",  division: "Division 13" },
    { chan: "chan-5376_l", sourceId: "521",  division: "Division 13" },
    { chan: "chan-5378_l", sourceId: "523",  division: "Division 13" },
    { chan: "chan-6332_l", sourceId: "2184", division: "Division 13" },
    { chan: "chan-5381_l", sourceId: "526",  division: "Division 13" },
    { chan: "chan-5432_l", sourceId: "577",  division: "Division 14" },
    { chan: "chan-5440_l", sourceId: "585",  division: "Division 14" },
    { chan: "chan-5441_l", sourceId: "2132", division: "Division 13" },
    { chan: "chan-6279_l", sourceId: "2137", division: "Division 13" },
    { chan: "chan-5442_l", sourceId: "587",  division: "Division 14" },
    { chan: "chan-5443_l", sourceId: "588",  division: "Division 14" },
    { chan: "chan-6275_l", sourceId: "2133", division: "Division 13" },
    { chan: "chan-6276_l", sourceId: "2134", division: "Division 14" },
    { chan: "chan-6327_l", sourceId: "2180", division: "Division 14" },
    { chan: "chan-6328_l", sourceId: "2181", division: "Division 14" },
    { chan: "chan-5444_l", sourceId: "589",  division: "Division 14" },
    { chan: "chan-5446_l", sourceId: "591",  division: "Division 14" },
    { chan: "chan-5445_l", sourceId: "590",  division: "Division 14" },
];

async function getSessionUUID() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    let uuid = null;

    page.on('request', req => {
        if (req.url().includes('GetSecureTokenUri') && req.method() === 'POST') {
            try {
                const body = JSON.parse(req.postData() || '{}');
                if (body.token && !uuid) {
                    uuid = body.token;
                    console.log(`[UUID from POST] ${uuid}`);
                }
            } catch (_) {}
        }
        req.continue();
    });

    console.log('Loading drivenc.gov...');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('Page loaded. Waiting for JS to settle...');
    await new Promise(r => setTimeout(r, 5000));

    // Dismiss modal — try every method
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));

    // Click X by coordinate (we know it's around 891, 119 from earlier screenshots)
    await page.mouse.click(891, 119);
    await new Promise(r => setTimeout(r, 500));

    // Also try selector-based click
    await page.evaluate(() => {
        for (const sel of ['.modal .close', '.modal-header .close', 'button[aria-label="Close"]', '.close']) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return; }
        }
        // Try clicking Next/OK buttons too
        const btns = [...document.querySelectorAll('button')];
        const ok = btns.find(b => /next|ok|got it|close|dismiss/i.test(b.textContent));
        if (ok) ok.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Find and click Show Video
    const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, a')]
            .find(el => /show\s*video/i.test(el.textContent?.trim()));
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        if (r.width === 0) return false;
        btn.click();
        return true;
    });
    console.log(`Show Video DOM click: ${clicked}`);
    await new Promise(r => setTimeout(r, 500));

    // Also try mouse click at known sidebar position
    await page.mouse.click(201, 440);
    await new Promise(r => setTimeout(r, 3000));

    // If POST interception didn't catch UUID, try scanning the JS heap
    if (!uuid) {
        console.log('POST not intercepted — scanning JS heap for UUID...');
        uuid = await page.evaluate(() => {
            const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            // Check Angular/React service instances for a token/UUID field
            for (const key of Object.getOwnPropertyNames(window)) {
                try {
                    const val = window[key];
                    if (typeof val === 'string' && re.test(val) &&
                        val !== '00000000-0000-0000-0000-000000000000') return val;
                    if (val && typeof val === 'object') {
                        const str = JSON.stringify(val);
                        const m = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                        if (m && m[0] !== '00000000-0000-0000-0000-000000000000') return m[0];
                    }
                } catch (_) {}
            }
            return null;
        });
        if (uuid) console.log(`[UUID from heap] ${uuid}`);
    }

    // Last resort: call the token API from inside the browser using a fresh UUID
    // and check if it works (the session cookie may be sufficient)
    if (!uuid) {
        console.log('Trying API call from browser context with fresh UUID...');
        const result = await page.evaluate(async (apiUrl, sourceId, division) => {
            const testUUID = crypto.randomUUID();
            const res = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ token: testUUID, sourceId, systemSourceId: division }),
            });
            return { status: res.status, body: await res.text(), uuid: testUUID };
        }, TOKEN_API, '518', 'Division 13');

        console.log(`Browser API test → HTTP ${result.status}: ${result.body}`);
        if (result.status === 200 && result.body.includes('token=')) {
            // A fresh UUID worked from within the browser context!
            uuid = result.uuid;
            console.log(`[UUID works from browser] ${uuid}`);
        }
    }

    await page.screenshot({ path: 'debug.png' });
    await browser.close();

    if (!uuid) throw new Error('Could not obtain a valid session UUID by any method.');
    return uuid;
}

async function fetchAllTokens(uuid) {
    const tokens  = {};
    const headers = {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'User-Agent':   UA,
        'Referer':      DRIVENC,
        'Origin':       DRIVENC,
    };

    for (const cam of SOURCE_MAP) {
        try {
            const res  = await fetch(TOKEN_API, {
                method: 'POST', headers,
                body: JSON.stringify({ token: uuid, sourceId: cam.sourceId, systemSourceId: cam.division }),
            });
            const text = await res.text();
            const m    = text.match(/token=([a-f0-9]+)/);
            if (m) {
                tokens[cam.chan] = m[1];
                console.log(`✅ ${cam.chan} → ${m[1].slice(0,16)}...`);
            } else {
                console.warn(`⚠ ${cam.chan} → HTTP ${res.status}: ${text}`);
            }
        } catch (e) { console.warn(`⚠ ${cam.chan} → ${e.message}`); }
    }
    return tokens;
}

async function updateIndexHTML(newTokens) {
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error('index.html not found');
    let html = fs.readFileSync(indexPath, 'utf8');
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(html)) throw new Error('Anchor comments not found in index.html');
    const existingMatch = html.match(/const tokenConfig = ({[\s\S]*?});/);
    let existing = {};
    if (existingMatch) { try { existing = JSON.parse(existingMatch[1]); } catch (_) {} }
    const merged = { ...existing, ...newTokens, updated: new Date().toISOString() };
    html = html.replace(regex,
        `$1\n        const tokenConfig = ${JSON.stringify(merged, null, 2)};\n        $2`);
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log(`\n✅ index.html updated — ${Object.keys(newTokens).length}/20 tokens refreshed.`);
    if (Object.keys(newTokens).length < 20)
        console.warn(`⚠ ${20 - Object.keys(newTokens).length} token(s) kept from previous run.`);
}

async function main() {
    console.log('Step 1: Getting session UUID...');
    const uuid = await getSessionUUID();

    console.log('\nStep 2: Fetching tokens for all 20 cameras...');
    const tokens = await fetchAllTokens(uuid);

    if (Object.keys(tokens).length === 0)
        throw new Error('No tokens fetched.');

    console.log('\nStep 3: Updating index.html...');
    await updateIndexHTML(tokens);
}

main().catch(err => { console.error('⛔', err.message); process.exit(1); });
