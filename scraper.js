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

async function scrapeAllTokens() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    let uuid = null;

    // Intercept POST to capture UUID and log ALL headers for diagnostics
    page.on('request', req => {
        if (req.url().includes('GetSecureTokenUri') && req.method() === 'POST') {
            try {
                const body = JSON.parse(req.postData() || '{}');
                if (body.token && !uuid) {
                    uuid = body.token;
                    console.log(`[UUID] ${uuid}`);
                    console.log(`[headers] ${JSON.stringify(req.headers())}`);
                }
            } catch (_) {}
        }
        req.continue();
    });

    console.log('Loading drivenc.gov...');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 4000));

    // Dismiss modal using selector only — no coordinates
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
        for (const sel of ['.modal .close', '.modal-header .close', 'button[aria-label="Close"]', '.close']) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return; }
        }
    });
    await new Promise(r => setTimeout(r, 1000));

    // Wait for Show Video button with a timeout, then click it
    console.log('Looking for Show Video button...');
    try {
        await page.waitForFunction(
            () => [...document.querySelectorAll('button, a')].some(el => /show\s*video/i.test(el.textContent?.trim())),
            { timeout: 15000 }
        );
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button, a')]
                .find(el => /show\s*video/i.test(el.textContent?.trim()));
            if (btn) btn.click();
        });
        console.log('Show Video clicked.');
        await new Promise(r => setTimeout(r, 3000));
    } catch (_) {
        console.warn('Show Video button not found after 15s.');
        await page.screenshot({ path: 'debug.png' });
    }

    if (!uuid) {
        await browser.close();
        throw new Error('Session UUID not captured.');
    }

    // Fetch all 20 tokens from inside the browser with credentials: 'include'
    console.log('Fetching all 20 tokens from browser context...');
    const results = await page.evaluate(async (apiUrl, sourceMap, sessionUUID) => {
        const tokens = {};
        for (const cam of sourceMap) {
            try {
                const res = await fetch(apiUrl, {
                    method: 'POST',
                    credentials: 'include',   // sends insight-atms cookies
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({
                        token:          sessionUUID,
                        sourceId:       cam.sourceId,
                        systemSourceId: cam.division,
                    }),
                });
                const text = await res.text();
                const m = text.match(/token=([a-f0-9]+)/);
                tokens[cam.chan] = { status: res.status, token: m?.[1] ?? null, raw: text };
            } catch (e) {
                tokens[cam.chan] = { status: 0, token: null, raw: e.message };
            }
        }
        return tokens;
    }, TOKEN_API, SOURCE_MAP, uuid);

    await browser.close();

    const captured = {};
    for (const [chan, r] of Object.entries(results)) {
        if (r.token) {
            captured[chan] = r.token;
            console.log(`✅ ${chan} → ${r.token.slice(0, 16)}...`);
        } else {
            console.warn(`⚠  ${chan} → HTTP ${r.status}: ${r.raw}`);
        }
    }
    return captured;
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
        console.warn(`⚠  ${20 - Object.keys(newTokens).length} token(s) kept from previous run.`);
}

async function main() {
    const tokens = await scrapeAllTokens();
    if (Object.keys(tokens).length === 0) throw new Error('No tokens captured.');
    await updateIndexHTML(tokens);
}

main().catch(err => { console.error('⛔', err.message); process.exit(1); });
