const fs   = require('fs');
const path = require('path');

const TOKEN_API  = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const CAMERAS_EP = 'https://www.drivenc.gov/Camera/GetUserCameras';
const DRIVENC    = 'https://www.drivenc.gov';
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CAMERA_CHANNELS = [
    { host: "cfase02", chan: "chan-5373_l" },
    { host: "cfase03", chan: "chan-5374_l" },
    { host: "cfase04", chan: "chan-5375_l" },
    { host: "cfsse11", chan: "chan-5376_l" },
    { host: "cfase01", chan: "chan-5378_l" },
    { host: "cfase02", chan: "chan-6332_l" },
    { host: "cfase04", chan: "chan-5381_l" },
    { host: "cfase04", chan: "chan-5432_l" },
    { host: "cfase03", chan: "chan-5440_l" },
    { host: "cfsse13", chan: "chan-5441_l" },
    { host: "cfase03", chan: "chan-6279_l" },
    { host: "cfsse02", chan: "chan-5442_l" },
    { host: "cfase02", chan: "chan-5443_l" },
    { host: "cfase01", chan: "chan-6275_l" },
    { host: "cfase03", chan: "chan-6276_l" },
    { host: "cfsse05", chan: "chan-6327_l" },
    { host: "cfsse05", chan: "chan-6328_l" },
    { host: "cfsse03", chan: "chan-5444_l" },
    { host: "cfase03", chan: "chan-5446_l" },
    { host: "cfase05", chan: "chan-5445_l" },
];
const KNOWN_CHANS = new Set(CAMERA_CHANNELS.map(c => c.chan));

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
        // Capture CSRF token from any POST
        const h = req.headers();
        if (h['__requestverificationtoken'] && !csrfToken) {
            csrfToken = h['__requestverificationtoken'];
        }
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

    // Click Show Video to get the CSRF token
    await page.waitForFunction(
        () => [...document.querySelectorAll('button, a')].some(el => /show\s*video/i.test(el.textContent?.trim())),
        { timeout: 15000 }
    );
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, a')]
            .find(el => /show\s*video/i.test(el.textContent?.trim()));
        if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 2000));
    console.log(`CSRF token: ${csrfToken ? csrfToken.slice(0,20) + '...' : 'NOT FOUND'}`);

    // ── Step 1: Fetch ALL cameras from GetUserCameras ─────────────────────────
    // This endpoint returns videoUrl + sourceId + source for each camera.
    // Paginate if needed — try large page sizes and offsets.
    console.log('\nFetching camera list from /Camera/GetUserCameras...');

    const allCameras = [];
    // Try different query patterns to get more cameras
    const endpoints = [
        '/Camera/GetUserCameras',
        '/Camera/GetUserCameras?pageSize=500',
        '/Camera/GetAllCameras',
        '/Camera/GetAllCameras?pageSize=500',
        '/map/mapData/Cameras',
        '/Camera/GetCameras',
    ];

    for (const ep of endpoints) {
        const result = await page.evaluate(async (url) => {
            try {
                const r = await fetch(url, {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json' }
                });
                return { status: r.status, body: await r.text() };
            } catch (e) { return { status: 0, body: e.message }; }
        }, ep);

        console.log(`  ${ep} → HTTP ${result.status}: ${result.body.slice(0, 200)}`);

        if (result.status === 200) {
            try {
                const json = JSON.parse(result.body);
                const items = json.data || json.cameras || json.items || (Array.isArray(json) ? json : []);
                if (items.length > 0) {
                    allCameras.push(...items);
                    console.log(`    → ${items.length} cameras`);
                }
            } catch (_) {}
        }
    }

    // ── Step 2: Match our channels to sourceIds ───────────────────────────────
    const sourceMap = {};
    for (const cam of allCameras) {
        // Flatten nested images array
        const images = cam.images || [cam];
        for (const img of images) {
            const videoUrl = img.videoUrl || '';
            const m = videoUrl.match(/\/(chan-[\d]+_l)\//);
            if (m && KNOWN_CHANS.has(m[1])) {
                const sourceId = String(cam.sourceId || img.sourceId || '');
                const source   = String(cam.source   || img.source   || '');
                // Extract division from source field e.g. "IVDs-Division 14" → "Division 14"
                const divMatch = source.match(/Division\s+\d+/i);
                const division = divMatch ? divMatch[0] : source;
                sourceMap[m[1]] = { sourceId, division, source };
                console.log(`  Matched ${m[1]} → sourceId=${sourceId} source="${source}"`);
            }
        }
    }

    console.log(`\nMatched ${Object.keys(sourceMap).length}/20 cameras from API.`);

    if (Object.keys(sourceMap).length === 0) {
        console.log('\nNo cameras matched — the API may not return our specific cameras.');
        console.log('Sample camera data:', JSON.stringify(allCameras.slice(0,2), null, 2));
        await browser.close();
        return;
    }

    // ── Step 3: Fetch a token for each matched camera ─────────────────────────
    console.log('\nFetching stream tokens...');
    const uuid = crypto.randomUUID(); // Use fresh UUID — sourceIds from the API should be valid
    const captured = {};

    for (const [chan, info] of Object.entries(sourceMap)) {
        const result = await page.evaluate(async (apiUrl, uuid, sourceId, division, csrf) => {
            try {
                const res = await fetch(apiUrl, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        '__requestverificationtoken': csrf,
                    },
                    body: JSON.stringify({ token: uuid, sourceId, systemSourceId: division }),
                });
                return { status: res.status, body: await res.text() };
            } catch (e) { return { status: 0, body: e.message }; }
        }, TOKEN_API, uuid, info.sourceId, info.division, csrfToken);

        const m = result.body.match(/token=([a-f0-9]+)/);
        if (m) {
            captured[chan] = m[1];
            console.log(`✅ ${chan} → ${m[1].slice(0,16)}...`);
        } else {
            console.warn(`⚠  ${chan} (sourceId=${info.sourceId}, ${info.division}) → HTTP ${result.status}: ${result.body}`);
        }
    }

    await browser.close();

    if (Object.keys(captured).length === 0) {
        console.error('\n⛔ No tokens captured.');
        process.exit(1);
    }

    // ── Step 4: Update index.html ─────────────────────────────────────────────
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
}

run().catch(err => { console.error('⛔', err.message); process.exit(1); });
