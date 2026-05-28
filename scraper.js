const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';

// Our cameras: channel name → host
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

async function findSourceIds(page) {
    console.log('Intercepting camera data API calls...');

    const cameraData = [];

    // Capture any API response that looks like a camera list
    page.on('response', async response => {
        const url = response.url();
        if (!url.includes('insight-atms') && !url.includes('drivenc')) return;
        try {
            const text = await response.text();
            if (!text.includes('sourceId') && !text.includes('SourceId') && !text.includes('chan-')) return;
            console.log(`[camera data] ${url}`);
            console.log(`  ${text.slice(0, 500)}`);
            try {
                const json = JSON.parse(text);
                const items = Array.isArray(json) ? json : Object.values(json).find(v => Array.isArray(v)) || [];
                cameraData.push(...items);
            } catch (_) {}
        } catch (_) {}
    });

    // Enable the Cameras layer by clicking the checkbox
    const cameraCheckbox = await page.evaluate(() => {
        const labels = [...document.querySelectorAll('label, span, div')];
        const camLabel = labels.find(el => el.textContent?.trim() === 'Cameras');
        if (!camLabel) return null;
        const checkbox = camLabel.previousElementSibling || camLabel.querySelector('input') || document.querySelector('input[id*="amera"]');
        if (checkbox) { checkbox.click(); return true; }
        camLabel.click();
        return 'label clicked';
    });
    console.log('Cameras layer toggle:', cameraCheckbox);

    // Wait for camera data to load
    await new Promise(r => setTimeout(r, 8000));

    return cameraData;
}

async function getTokensForAllCameras(page, sourceIdMap) {
    const tokens = {};

    for (const cam of CAMERA_CHANNELS) {
        const chanBase = cam.chan.replace('_l', '');
        const entry = sourceIdMap[chanBase];

        if (!entry) {
            console.warn(`⚠ No sourceId found for ${cam.chan}`);
            continue;
        }

        try {
            const result = await page.evaluate(async (apiUrl, sourceId, systemSourceId) => {
                const res = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ token: crypto.randomUUID(), sourceId, systemSourceId }),
                });
                return { status: res.status, body: await res.text() };
            }, TOKEN_API, entry.sourceId, entry.systemSourceId);

            const m = result.body.match(/token=([a-f0-9]+)/);
            if (m) {
                tokens[cam.chan] = m[1];
                console.log(`✅ ${cam.chan} → ${m[1].slice(0, 16)}...`);
            } else {
                console.warn(`⚠ ${cam.chan}: no token in response: ${result.body}`);
            }
        } catch (e) {
            console.warn(`⚠ ${cam.chan}: ${e.message}`);
        }
    }

    return tokens;
}

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));

    // Dismiss modal
    await page.keyboard.press('Escape');
    const xBtn = await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (xBtn && xBtn.x > 0) await page.mouse.click(xBtn.x, xBtn.y);
    await new Promise(r => setTimeout(r, 1000));

    // Discover camera sourceIds from the map layer API
    const cameraData = await findSourceIds(page);
    console.log(`\nFound ${cameraData.length} camera entries from API.`);
    if (cameraData.length > 0) console.log('Sample:', JSON.stringify(cameraData[0]));

    // Build channel → sourceId map
    const sourceIdMap = {};
    for (const cam of cameraData) {
        // Look for our channel IDs in any string field of the camera object
        const str = JSON.stringify(cam);
        for (const ch of CAMERA_CHANNELS) {
            const base = ch.chan.replace('_l', '');
            if (str.includes(base)) {
                sourceIdMap[base] = {
                    sourceId: String(cam.sourceId || cam.SourceId || cam.id || cam.Id || cam.cameraId),
                    systemSourceId: cam.systemSourceId || cam.SystemSourceId || cam.division || cam.Division || ''
                };
            }
        }
    }

    console.log('\nSourceId map:', JSON.stringify(sourceIdMap, null, 2));
    await browser.close();

    if (Object.keys(sourceIdMap).length === 0) {
        throw new Error('Could not build sourceId map — check API response logs above.');
    }
}

run().catch(err => {
    console.error('⛔', err.message);
    process.exit(1);
});
