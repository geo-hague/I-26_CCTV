const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';

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

async function scrapeTokens() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);

    const captured   = {};  // chan → token
    const sourceIdMap = {}; // sourceId → { chan, division }
    let sessionUUID  = null;

    page.on('request', req => {
        const url = req.url();

        // Intercept POST to capture UUID and build sourceId → token mapping
        if (url.includes('GetSecureTokenUri') && req.method() === 'POST') {
            try {
                const body = JSON.parse(req.postData() || '{}');
                if (body.token && !sessionUUID) {
                    sessionUUID = body.token;
                    console.log(`[UUID] ${sessionUUID}`);
                }
                if (body.sourceId) {
                    sourceIdMap[body.sourceId] = {
                        division: body.systemSourceId,
                        requested: Date.now()
                    };
                }
            } catch (_) {}
        }

        // Intercept stream URL — channel name + token together
        if (url.includes('services.ncdot.gov')) {
            const m = url.match(/\/(chan-[\d]+_l)\/index\.m3u8\?token=([a-f0-9]+)/);
            if (m && KNOWN_CHANS.has(m[1]) && !captured[m[1]]) {
                captured[m[1]] = m[2];
                console.log(`✅ ${m[1]} → ${m[2].slice(0,16)}...  (${Object.keys(captured).length}/20)`);
            }
        }

        req.continue();
    });

    // Also watch responses — when a POST returns a token AND we know the stream URL
    // is about to be requested, correlate them
    page.on('response', async res => {
        if (!res.url().includes('GetSecureTokenUri')) return;
        try {
            const text = await res.text();
            const m = text.match(/token=([a-f0-9]+)/);
            if (m) console.log(`[POST response] stream token: ${m[1].slice(0,16)}...`);
        } catch (_) {}
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

    // Click initial Show Video to get the session UUID
    const initialBtn = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, a')]
            .find(el => /show\s*video/i.test(el.textContent?.trim()));
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (initialBtn) {
        await page.mouse.move(initialBtn.x, initialBtn.y);
        await page.mouse.down(); await new Promise(r => setTimeout(r, 100)); await page.mouse.up();
        await new Promise(r => setTimeout(r, 2000));
    }

    // Enable the Cameras layer
    console.log('Enabling Cameras layer...');
    await page.evaluate(() => {
        const all = [...document.querySelectorAll('label, span, input, div')];
        const camEl = all.find(el => el.textContent?.trim() === 'Cameras');
        if (camEl) camEl.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    // Search for I-26 to pan the map to the right area
    console.log('Searching for I-26...');
    const searchBox = await page.$('input[placeholder*="Search"], input[placeholder*="search"], #search-input, .search-input');
    if (searchBox) {
        await searchBox.click();
        await searchBox.type('I-26 Asheville NC', { delay: 50 });
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));
        console.log('Search submitted.');
    } else {
        // Fallback: use Google Maps API directly to pan
        await page.evaluate(() => {
            try {
                // Find the Google Maps instance
                const maps = Object.values(window).find(v =>
                    v && typeof v === 'object' && v.getCenter && v.setCenter && v.setZoom
                );
                if (maps) {
                    maps.setCenter({ lat: 35.45, lng: -82.3 });
                    maps.setZoom(11);
                }
            } catch (_) {}
        });
        await new Promise(r => setTimeout(r, 3000));
        console.log('Map panned via API.');
    }

    await page.screenshot({ path: 'debug-before-click.png' });

    // Now click camera markers on the map
    // Camera markers are in the map area (x > 380) and have img src containing camera
    console.log('Looking for camera markers to click...');
    for (let attempt = 0; attempt < 30 && Object.keys(captured).length < 20; attempt++) {
        const markers = await page.evaluate(() => {
            return [...document.querySelectorAll('img')]
                .filter(el => {
                    const src = el.src || '';
                    const r   = el.getBoundingClientRect();
                    return src.includes('camera') && r.x > 380 && r.width > 0 && r.y > 100;
                })
                .map(el => {
                    const r = el.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2, src: el.src };
                });
        });

        if (markers.length === 0) {
            console.log(`[attempt ${attempt+1}] No camera markers visible — zooming in...`);
            // Click the + zoom button
            const zoomIn = await page.$('.gm-control-active[title*="zoom in"], [aria-label*="Zoom in"]');
            if (zoomIn) await zoomIn.click();
            else await page.evaluate(() => {
                const btn = [...document.querySelectorAll('button')].find(b => b.title?.includes('Zoom in') || b.getAttribute('aria-label')?.includes('Zoom in'));
                if (btn) btn.click();
            });
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }

        console.log(`[attempt ${attempt+1}] ${markers.length} camera markers visible`);

        for (const marker of markers) {
            await page.mouse.click(marker.x, marker.y);
            await new Promise(r => setTimeout(r, 1500));

            // Click Show Video in the popup
            const showBtn = await page.evaluate(() => {
                const btn = [...document.querySelectorAll('button, a')]
                    .find(el => /show\s*video/i.test(el.textContent?.trim()));
                if (!btn) return null;
                const r = btn.getBoundingClientRect();
                return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
            });

            if (showBtn) {
                await page.mouse.move(showBtn.x, showBtn.y);
                await page.mouse.down(); await new Promise(r => setTimeout(r, 100)); await page.mouse.up();
                await new Promise(r => setTimeout(r, 2000));
                console.log(`  Clicked Show Video. Tokens so far: ${Object.keys(captured).length}/20`);
            }

            if (Object.keys(captured).length === 20) break;
        }

        // Pan east along I-26 to find more cameras
        await page.evaluate(() => window.scrollBy && window.scrollBy(200, 0));
        const mapEl = await page.$('#map, .map-container, [id*="map"]');
        if (mapEl) {
            const r = await mapEl.boundingBox();
            if (r) {
                // Drag map eastward
                await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
                await page.mouse.down();
                await page.mouse.move(r.x + r.width / 2 - 200, r.y + r.height / 2, { steps: 10 });
                await page.mouse.up();
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    await page.screenshot({ path: 'debug.png' });
    await browser.close();

    console.log(`\nFinal: ${Object.keys(captured).length}/20 tokens captured.`);
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
    if (Object.keys(newTokens).length < 20)
        console.warn(`⚠ ${20 - Object.keys(newTokens).length} tokens kept from previous run.`);
}

async function main() {
    const tokens = await scrapeTokens();
    if (Object.keys(tokens).length === 0) {
        console.error('⛔ No tokens captured. Check debug screenshots in artifacts.');
        process.exit(1);
    }
    await updateIndexHTML(tokens);
}

main().catch(err => { console.error('⛔', err.message); process.exit(1); });
