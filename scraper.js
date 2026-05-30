const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const DRIVENC   = 'https://www.drivenc.gov';
const UA        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// sourceId = channel number (confirmed from GetUserCameras API pattern)
// Division determined by trying 13 then 14 (I-26 runs through both)
const CAMERA_CHANNELS = [
    { host: "cfase02", chan: "chan-5373_l", sourceId: "5373" },
    { host: "cfase03", chan: "chan-5374_l", sourceId: "5374" },
    { host: "cfase04", chan: "chan-5375_l", sourceId: "5375" },
    { host: "cfsse11", chan: "chan-5376_l", sourceId: "5376" },
    { host: "cfase01", chan: "chan-5378_l", sourceId: "5378" },
    { host: "cfase02", chan: "chan-6332_l", sourceId: "6332" },
    { host: "cfase04", chan: "chan-5381_l", sourceId: "5381" },
    { host: "cfase04", chan: "chan-5432_l", sourceId: "5432" },
    { host: "cfase03", chan: "chan-5440_l", sourceId: "5440" },
    { host: "cfsse13", chan: "chan-5441_l", sourceId: "5441" },
    { host: "cfase03", chan: "chan-6279_l", sourceId: "6279" },
    { host: "cfsse02", chan: "chan-5442_l", sourceId: "5442" },
    { host: "cfase02", chan: "chan-5443_l", sourceId: "5443" },
    { host: "cfase01", chan: "chan-6275_l", sourceId: "6275" },
    { host: "cfase03", chan: "chan-6276_l", sourceId: "6276" },
    { host: "cfsse05", chan: "chan-6327_l", sourceId: "6327" },
    { host: "cfsse05", chan: "chan-6328_l", sourceId: "6328" },
    { host: "cfsse03", chan: "chan-5444_l", sourceId: "5444" },
    { host: "cfase03", chan: "chan-5446_l", sourceId: "5446" },
    { host: "cfase05", chan: "chan-5445_l", sourceId: "5445" },
];

// I-26 runs through Divisions 13 and 14 — try both per camera
const DIVISIONS = ['Division 13', 'Division 14', 'Division 12'];

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    let csrfToken = null;

    page.on('request', req => {
        const h = req.headers();
        if (h['__requestverificationtoken'] && !csrfToken)
            csrfToken = h['__requestverificationtoken'];
        req.continue();
    });

    console.log('Loading drivenc.gov...');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 4000));

    // Dismiss modal
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Click Show Video to get CSRF token
    await page.waitForFunction(
        () => [...document.querySelectorAll('button,a')].some(el => /show\s*video/i.test(el.textContent?.trim())),
        { timeout: 15000 }
    );
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button,a')]
            .find(el => /show\s*video/i.test(el.textContent?.trim()));
        if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 2000));
    console.log(`CSRF: ${csrfToken ? '✓' : '✗ NOT FOUND'}`);

    // Fetch tokens for all cameras from browser context
    console.log('\nFetching tokens (sourceId = channel number)...');
    const results = await page.evaluate(async (apiUrl, cameras, divisions, csrf) => {
        const out = {};
        for (const cam of cameras) {
            let found = false;
            for (const division of divisions) {
                try {
                    const res = await fetch(apiUrl, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            '__requestverificationtoken': csrf,
                        },
                        body: JSON.stringify({
                            token: crypto.randomUUID(),
                            sourceId: cam.sourceId,
                            systemSourceId: division,
                        }),
                    });
                    const text = await res.text();
                    const m = text.match(/token=([a-f0-9]+)/);
                    if (res.status === 200 && m) {
                        out[cam.chan] = { token: m[1], division, status: 200 };
                        found = true;
                        break;
                    } else {
                        out[cam.chan] = { token: null, division, status: res.status, raw: text };
                    }
                } catch (e) {
                    out[cam.chan] = { token: null, division, status: 0, raw: e.message };
                }
            }
        }
        return out;
    }, TOKEN_API, CAMERA_CHANNELS, DIVISIONS, csrfToken);

    await browser.close();

    const captured = {};
    for (const [chan, r] of Object.entries(results)) {
        if (r.token) {
            captured[chan] = r.token;
            console.log(`✅ ${chan} (${r.division}) → ${r.token.slice(0,16)}...`);
        } else {
            console.warn(`⚠  ${chan} → HTTP ${r.status}: ${r.raw}`);
        }
    }

    if (Object.keys(captured).length === 0) {
        console.error('\n⛔ No tokens captured.');
        process.exit(1);
    }

    const indexPath = path.join(__dirname, 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    const existingMatch = html.match(/const tokenConfig = ({[\s\S]*?});/);
    let existing = {};
    if (existingMatch) { try { existing = JSON.parse(existingMatch[1]); } catch (_) {} }
    const merged = { ...existing, ...captured, updated: new Date().toISOString() };
    html = html.replace(regex,
        `$1\n        const tokenConfig = ${JSON.stringify(merged, null, 2)};\n        $2`);
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log(`\n✅ index.html updated — ${Object.keys(captured).length}/20 tokens refreshed.`);
    if (Object.keys(captured).length < 20)
        console.warn(`⚠  ${20 - Object.keys(captured).length} token(s) kept from previous run.`);
}

run().catch(err => { console.error('⛔', err.message); process.exit(1); });
