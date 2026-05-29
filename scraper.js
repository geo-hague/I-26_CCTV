const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const DRIVENC   = 'https://www.drivenc.gov';

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Step 1: Use Puppeteer just to get a valid session UUID + cookies ──────────
async function getSession() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    let sessionUUID = null;
    let cookies     = null;

    page.on('request', req => {
        if (req.url().includes('GetSecureTokenUri') && req.method() === 'POST') {
            try {
                const body = JSON.parse(req.postData() || '{}');
                if (body.token && !sessionUUID) {
                    sessionUUID = body.token;
                    console.log(`[UUID] ${sessionUUID}`);
                }
            } catch (_) {}
        }
        req.continue();
    });

    // Also intercept ALL drivenc.gov JSON responses to find camera data
    const cameraApiResponses = [];
    page.on('response', async res => {
        const url = res.url();
        if (!url.includes('drivenc.gov')) return;
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        try {
            const text = await res.text();
            // Only keep responses that look like they contain camera source data
            if (text.includes('sourceId') || text.includes('SourceId') ||
                text.includes('chan-') || text.includes('itemId')) {
                console.log(`[drivenc API] ${url}`);
                console.log(`  ${text.slice(0, 400)}`);
                cameraApiResponses.push({ url, text });
            }
        } catch (_) {}
    });

    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 2000));

    // Dismiss modal
    await page.keyboard.press('Escape');
    const xBtn = await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (xBtn) await page.mouse.click(xBtn.x, xBtn.y);
    await new Promise(r => setTimeout(r, 800));

    // Click Show Video to get UUID
    const btn = await page.evaluate(() => {
        const el = [...document.querySelectorAll('button,a')].find(e => /show\s*video/i.test(e.textContent));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (btn) {
        await page.mouse.move(btn.x, btn.y);
        await page.mouse.down(); await new Promise(r => setTimeout(r, 80)); await page.mouse.up();
        await new Promise(r => setTimeout(r, 2000));
    }

    // Enable Cameras layer and wait for the data API call
    await page.evaluate(() => {
        const all = [...document.querySelectorAll('label, span, div, input')];
        const el  = all.find(e => e.textContent?.trim() === 'Cameras');
        if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 5000));

    // Also try fetching camera endpoints directly from the browser (carries cookies)
    const camEndpoints = [
        '/map/Cameras',
        '/map/mapData/Cameras',
        '/api/map/Cameras',
        '/api/Cameras',
        '/map/mapIcons/Cameras?includeData=true',
        '/map/GetCameras',
        '/VideoService/Cameras',
    ];
    console.log('\nProbing drivenc.gov camera endpoints from browser (with cookies)...');
    for (const ep of camEndpoints) {
        const result = await page.evaluate(async (endpoint) => {
            try {
                const r = await fetch(endpoint, { headers: { Accept: 'application/json' } });
                return { status: r.status, body: (await r.text()).slice(0, 300) };
            } catch (e) { return { status: 0, body: e.message }; }
        }, ep);
        console.log(`  ${ep} → ${result.status}: ${result.body.slice(0, 120)}`);
    }

    // Get cookies for use in Node.js fetch calls
    const pageCookies = await page.cookies();
    cookies = pageCookies.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();
    return { sessionUUID, cookies, cameraApiResponses };
}

// ── Step 2: Call insight-atms APIs directly from Node (no CORS) ───────────────
async function findSourceIds(sessionUUID, cookies) {
    const headers = {
        'User-Agent':  UA,
        'Accept':      'application/json',
        'Referer':     DRIVENC,
        'Origin':      DRIVENC,
        'Cookie':      cookies,
    };

    console.log('\nProbing insight-atms from Node.js (no CORS)...');
    const endpoints = [
        `https://vds.nc.insight-atms.com/api/Sources`,
        `https://vds.nc.insight-atms.com/api/Sources/GetAll`,
        `https://vds.nc.insight-atms.com/api/Cameras`,
        `https://vds.nc.insight-atms.com/api/VideoSources`,
        `https://vds.nc.insight-atms.com/api/Sources/GetBySystem?systemId=14`,
        `https://vds.nc.insight-atms.com/api/Sources/GetBySystem?systemId=Division+14`,
        `https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSources`,
        `https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSources?token=${sessionUUID}`,
    ];

    for (const url of endpoints) {
        try {
            const res  = await fetch(url, { headers });
            const text = await res.text();
            console.log(`  ${url.split('/').slice(-1)[0].slice(0,40)} → ${res.status}: ${text.slice(0,200)}`);
            if (res.ok && text.includes('chan-')) {
                console.log('  *** Contains channel data! ***');
                return JSON.parse(text);
            }
        } catch (e) { console.log(`  ${url.split('/').slice(-1)[0]} → error: ${e.message}`); }
    }

    return null;
}

// ── Step 3: Fetch a token for each camera using session UUID ──────────────────
async function getToken(sessionUUID, cookies, sourceId, division) {
    const res = await fetch(TOKEN_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/json',
            'User-Agent':   UA,
            'Referer':      DRIVENC,
            'Origin':       DRIVENC,
            'Cookie':       cookies,
        },
        body: JSON.stringify({ token: sessionUUID, sourceId, systemSourceId: division }),
    });
    const text = await res.text();
    const m = text.match(/token=([a-f0-9]+)/);
    return { status: res.status, token: m?.[1] || null, raw: text };
}

async function main() {
    const { sessionUUID, cookies, cameraApiResponses } = await getSession();

    if (!sessionUUID) {
        console.error('⛔ No session UUID captured.');
        process.exit(1);
    }

    // See if any drivenc.gov API response contained camera data
    if (cameraApiResponses.length > 0) {
        console.log(`\n${cameraApiResponses.length} drivenc.gov response(s) with camera data logged above.`);
    }

    // Try insight-atms directly from Node
    await findSourceIds(sessionUUID, cookies);

    // Test a few known sourceId/division combos from the Divisions I-26 spans
    // I-26 in NC runs through NCDOT Divisions 13 and 14
    console.log('\nTesting known Division 13/14 combos for chan-5373_l...');
    for (const div of ['Division 13', 'Division 14', 'Division 12']) {
        // Try sourceId as small integers near 589 (our one known value)
        // and also try the channel numbers directly
        for (const sid of ['589', '590', '591', '580', '581', '582', '583', '584', '585', '586', '587', '588']) {
            const r = await getToken(sessionUUID, cookies, sid, div);
            if (r.status === 200 && r.token) {
                console.log(`  ✅ sourceId=${sid} ${div} → token: ${r.token.slice(0,16)}...`);
            }
        }
    }
}

main().catch(err => { console.error('⛔', err.message); process.exit(1); });
