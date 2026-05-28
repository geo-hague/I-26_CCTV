const fs   = require('fs');
const path = require('path');

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
const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';

async function scrapeTokens() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Enable interception so we can read POST bodies
    await page.setRequestInterception(true);

    const captured    = {};
    let sessionUUID   = null;
    let sampleSourceId = null;
    let sampleDivision = null;

    page.on('request', req => {
        const url = req.url();

        // Capture POST body to insight-atms
        if (url.includes('GetSecureTokenUri') && req.method() === 'POST') {
            try {
                const body = JSON.parse(req.postData() || '{}');
                if (body.token && !sessionUUID) {
                    sessionUUID   = body.token;
                    sampleSourceId = body.sourceId;
                    sampleDivision = body.systemSourceId;
                    console.log(`[UUID captured] ${sessionUUID}`);
                    console.log(`[sample camera] sourceId=${sampleSourceId} division=${sampleDivision}`);
                }
            } catch (_) {}
        }

        // Capture tokens from stream URLs
        if (url.includes('services.ncdot.gov')) {
            const m = url.match(/\/(chan-[\d]+_l)\/index\.m3u8\?token=([a-f0-9]+)/);
            if (m && KNOWN_CHANS.has(m[1]) && !captured[m[1]]) {
                captured[m[1]] = m[2];
                console.log(`[stream URL] ${m[1]} → ${m[2].slice(0,16)}...`);
            }
        }

        req.continue();
    });

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));

    // Dismiss modal
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 300));
    const xBtn = await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (xBtn) await page.mouse.click(xBtn.x, xBtn.y);
    await new Promise(r => setTimeout(r, 1000));

    // Click Show Video to fire a POST and get the session UUID
    const showVideoPos = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, a')]
            .find(el => /show\s*video/i.test(el.textContent?.trim()));
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (showVideoPos) {
        await page.mouse.move(showVideoPos.x, showVideoPos.y);
        await page.mouse.down(); await new Promise(r => setTimeout(r, 100)); await page.mouse.up();
        console.log('Clicked Show Video...');
        await new Promise(r => setTimeout(r, 3000));
    }

    if (!sessionUUID) {
        console.error('⛔ Session UUID not captured — POST interception failed.');
        await page.screenshot({ path: 'debug.png' });
        await browser.close();
        process.exit(1);
    }

    // Use session UUID to probe insight-atms for a full source listing
    console.log('\nProbing insight-atms API for camera source list...');
    const probeUrls = [
        `https://vds.nc.insight-atms.com/api/Sources/GetAll`,
        `https://vds.nc.insight-atms.com/api/Sources`,
        `https://vds.nc.insight-atms.com/api/Sources/GetBySystem`,
        `https://vds.nc.insight-atms.com/api/VideoSources`,
        `https://vds.nc.insight-atms.com/api/Cameras/GetAll`,
        `https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSources`,
        // Try with session token as query param
        `https://vds.nc.insight-atms.com/api/Sources?token=${sessionUUID}`,
    ];

    for (const url of probeUrls) {
        const result = await page.evaluate(async (u, uuid) => {
            try {
                const res = await fetch(u, {
                    headers: {
                        'Accept': 'application/json',
                        'Authorization': `Bearer ${uuid}`,
                        'X-Token': uuid,
                    }
                });
                return { status: res.status, body: (await res.text()).slice(0, 400) };
            } catch (e) { return { status: 0, body: e.message }; }
        }, url, sessionUUID);
        console.log(`  ${url.split('/').slice(-1)[0].slice(0,40)} → ${result.status}: ${result.body.slice(0,120)}`);
    }

    // Try fetching tokens for all cameras using our known channel numbers as sourceIds
    // Channel numbers like chan-5373 likely correspond to numeric sourceIds
    // Try extracting the number and using it directly
    console.log('\nTrying channel-number-as-sourceId for each camera...');
    for (const cam of CAMERA_CHANNELS) {
        if (captured[cam.chan]) continue;
        // Extract numeric part from channel name: chan-5373_l → 5373
        const numericId = cam.chan.match(/chan-(\d+)/)?.[1];
        if (!numericId) continue;

        for (const division of ['Division 14', 'Division 13', 'Division 12', 'Division 11', sampleDivision].filter(Boolean)) {
            if (captured[cam.chan]) break;
            const result = await page.evaluate(async (apiUrl, uuid, sourceId, div) => {
                try {
                    const res = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        body: JSON.stringify({ token: uuid, sourceId, systemSourceId: div }),
                    });
                    return { status: res.status, body: await res.text() };
                } catch (e) { return { status: 0, body: e.message }; }
            }, TOKEN_API, sessionUUID, numericId, division);

            if (result.status === 200) {
                const m = result.body.match(/token=([a-f0-9]+)/);
                if (m) {
                    captured[cam.chan] = m[1];
                    console.log(`  ✅ ${cam.chan} (sourceId=${numericId}, ${division}) → ${m[1].slice(0,16)}...`);
                    break;
                }
            }
        }
        if (!captured[cam.chan]) {
            console.log(`  ✗ ${cam.chan} (tried sourceId=${numericId})`);
        }
    }

    await page.screenshot({ path: 'debug.png' });
    await browser.close();

    console.log(`\nCaptured ${Object.keys(captured).length}/20 tokens.`);
    return captured;
}

async function updateIndexHTML(newTokens) {
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error('index.html not found');
    let html = fs.readFileSync(indexPath, 'utf8');
    const existingMatch = html.match(/const tokenConfig = ({[\s\S]*?});/);
    let existing = {};
    if (existingMatch) { try { existing = JSON.parse(existingMatch[1]); } catch (_) {} }
    const merged = { ...existing, ...newTokens, updated: new Date().toISOString() };
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(html)) throw new Error('Anchor comments not found in index.html');
    html = html.replace(regex,
        `$1\n        const tokenConfig = ${JSON.stringify(merged, null, 2)};\n        $2`);
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log(`✅ index.html updated — ${Object.keys(newTokens).length}/20 tokens refreshed.`);
}

async function main() {
    const tokens = await scrapeTokens();
    if (Object.keys(tokens).length === 0) {
        console.error('⛔ No tokens captured.');
        process.exit(1);
    }
    await updateIndexHTML(tokens);
}

main().catch(err => { console.error('⛔', err.message); process.exit(1); });
