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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

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

    // Capture per-camera UUIDs from POST bodies as the page fires them
    const capturedUUIDs = {}; // sourceId → uuid
    page.on('request', req => {
        if (req.url().includes('GetSecureTokenUri') && req.method() === 'POST') {
            try {
                const body = JSON.parse(req.postData() || '{}');
                if (body.token && body.sourceId && body.token !== NULL_UUID) {
                    capturedUUIDs[body.sourceId] = body.token;
                    console.log(`[POST intercepted] sourceId=${body.sourceId} uuid=${body.token}`);
                }
            } catch (_) {}
        }
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

    // ── Look for per-camera UUIDs in the page HTML and JS variables ───────────
    console.log('\nSearching DOM for per-camera UUID data...');
    const domUUIDs = await page.evaluate((uuidPattern, nullUuid, sourceIds) => {
        const re = new RegExp(uuidPattern, 'gi');
        const results = { bySourceId: {}, inDataAttrs: [], inScripts: [], inWindowVars: [] };

        // 1. Search all data-* attributes on every element
        document.querySelectorAll('*').forEach(el => {
            for (const attr of el.attributes) {
                if (re.test(attr.value) && !attr.value.includes(nullUuid)) {
                    re.lastIndex = 0;
                    const uuid = attr.value.match(new RegExp(uuidPattern, 'i'))?.[0];
                    if (uuid) {
                        results.inDataAttrs.push({ tag: el.tagName, attr: attr.name, value: attr.value.slice(0, 100), uuid });
                        // Check if nearby data attribute has a sourceId
                        for (const sid of sourceIds) {
                            if (el.closest(`[data-source-id="${sid}"], [data-id="${sid}"], [data-camera-id="${sid}"]`) ||
                                el.getAttribute('data-source-id') === sid ||
                                el.getAttribute('data-id') === sid) {
                                results.bySourceId[sid] = uuid;
                            }
                        }
                    }
                    re.lastIndex = 0;
                }
            }
        });

        // 2. Search inline script tags
        document.querySelectorAll('script:not([src])').forEach(s => {
            const text = s.textContent;
            const matches = [...text.matchAll(new RegExp(uuidPattern, 'gi'))]
                .map(m => m[0]).filter(u => u !== nullUuid);
            if (matches.length) {
                // Find context around each UUID
                matches.forEach(uuid => {
                    const idx = text.indexOf(uuid);
                    results.inScripts.push(text.slice(Math.max(0, idx - 80), idx + 80));
                });
            }
        });

        // 3. Check common window variable names for camera data
        const checkObj = (obj, path, depth = 0) => {
            if (depth > 3 || !obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj).slice(0, 50)) {
                try {
                    const val = obj[key];
                    if (typeof val === 'string' && re.test(val) && !val.includes(nullUuid)) {
                        re.lastIndex = 0;
                        results.inWindowVars.push({ path: `${path}.${key}`, value: val });
                    } else {
                        checkObj(val, `${path}.${key}`, depth + 1);
                    }
                    re.lastIndex = 0;
                } catch (_) {}
            }
        };
        checkObj(window.MapComp, 'MapComp');
        checkObj(window.cameraData, 'cameraData');
        checkObj(window.cameras, 'cameras');
        checkObj(window.layerData, 'layerData');

        return results;
    }, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
       NULL_UUID, SOURCE_MAP.map(c => c.sourceId));

    console.log('UUIDs matched by sourceId:', JSON.stringify(domUUIDs.bySourceId));
    console.log(`Data attr UUIDs found: ${domUUIDs.inDataAttrs.length}`);
    if (domUUIDs.inDataAttrs.length) console.log('Samples:', JSON.stringify(domUUIDs.inDataAttrs.slice(0, 3)));
    console.log(`Script UUIDs found: ${domUUIDs.inScripts.length}`);
    if (domUUIDs.inScripts.length) console.log('Samples:', domUUIDs.inScripts.slice(0, 3));
    console.log(`Window var UUIDs found: ${domUUIDs.inWindowVars.length}`);
    if (domUUIDs.inWindowVars.length) console.log('Samples:', JSON.stringify(domUUIDs.inWindowVars.slice(0, 3)));

    // ── Enable cameras layer and re-check DOM ─────────────────────────────────
    console.log('\nEnabling cameras layer and re-scanning...');
    await page.evaluate(() => {
        const all = [...document.querySelectorAll('label, span, div, input')];
        const el = all.find(e => e.textContent?.trim() === 'Cameras');
        if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 5000));

    // Check all camera marker elements for data attributes
    const markerData = await page.evaluate((sourceIds) => {
        const results = [];
        // Camera markers with any data attributes
        document.querySelectorAll('[data-source-id], [data-camera-id], [data-id], [data-token], [data-uuid]').forEach(el => {
            const attrs = {};
            for (const attr of el.attributes) attrs[attr.name] = attr.value;
            results.push(attrs);
        });
        // Also check img camera markers
        document.querySelectorAll('img[src*="camera"]').forEach(el => {
            const attrs = {};
            for (const attr of el.attributes) attrs[attr.name] = attr.value;
            const parent = el.parentElement;
            if (parent) for (const attr of parent.attributes) attrs['parent_' + attr.name] = attr.value;
            results.push(attrs);
        });
        return results.slice(0, 20);
    }, SOURCE_MAP.map(c => c.sourceId));

    console.log(`Camera marker elements with data attrs: ${markerData.length}`);
    if (markerData.length) console.log('Samples:', JSON.stringify(markerData.slice(0, 3), null, 2));

    // ── Also probe the camera data API endpoints with our session ─────────────
    console.log('\nProbing camera data endpoints...');
    const apiResults = await page.evaluate(async (sourceIds) => {
        const endpoints = [
            '/map/mapIcons/Cameras',
            '/map/Cameras',
            '/Camera/GetCamerasByIds?ids=' + sourceIds.join(','),
            '/Camera/GetCameraToken',
            '/Camera/GetVideoUrl',
        ];
        const out = {};
        for (const ep of endpoints) {
            try {
                const r = await fetch(ep, { credentials: 'include', headers: { Accept: 'application/json' } });
                out[ep] = { status: r.status, body: (await r.text()).slice(0, 200) };
            } catch (e) { out[ep] = { status: 0, body: e.message }; }
        }
        return out;
    }, SOURCE_MAP.map(c => c.sourceId));

    for (const [ep, r] of Object.entries(apiResults)) {
        console.log(`  ${ep} → ${r.status}: ${r.body.slice(0, 100)}`);
    }

    await browser.close();
}

run().catch(err => { console.error('⛔', err.message); process.exit(1); });
