const fs   = require('fs');
const path = require('path');

// Our cameras — the ones we need tokens for
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

    const captured = {}; // chan → token

    // Intercept every outbound request — HLS manifest requests to services.ncdot.gov
    // contain both the channel name and token in the URL
    page.on('request', request => {
        const url = request.url();
        if (!url.includes('services.ncdot.gov')) return;
        const m = url.match(/\/(chan-\d+_l)\/index\.m3u8\?token=([a-f0-9]+)/);
        if (m) {
            const [, chan, token] = m;
            if (KNOWN_CHANS.has(chan) && !captured[chan]) {
                captured[chan] = token;
                console.log(`✅ ${chan} → ${token.slice(0, 16)}...`);
            }
        }
    });

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));

    // Dismiss modal via X button coordinates or Escape
    await page.keyboard.press('Escape');
    const xBtn = await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (xBtn && xBtn.x > 0) await page.mouse.click(xBtn.x, xBtn.y);
    await new Promise(r => setTimeout(r, 1000));

    // Navigate map to I-26 corridor (western NC, ~Asheville area) and zoom in
    // so camera markers become visible and clickable
    const mapMoved = await page.evaluate(() => {
        // Try common global map variable names used by Google Maps implementations
        const mapObj = window.map || window.gmap || window.googleMap;
        if (mapObj && mapObj.setCenter) {
            mapObj.setCenter({ lat: 35.45, lng: -82.2 });
            mapObj.setZoom(11);
            return 'moved via window.map';
        }
        // Try Google Maps instances registered on the page
        if (window.google && window.google.maps) {
            const instances = window.google.maps.Map ? 'api loaded' : 'no Map class';
            return instances;
        }
        return 'no map object found';
    });
    console.log('Map navigation:', mapMoved);
    await new Promise(r => setTimeout(r, 3000));

    // Enable Cameras layer via the legend checkbox
    await page.evaluate(() => {
        const all = [...document.querySelectorAll('label, span, input')];
        const camEl = all.find(el => el.textContent?.trim() === 'Cameras' || el.value === 'Cameras');
        if (camEl) camEl.click();
        const cb = document.querySelector('input[type="checkbox"][id*="amera"], input[type="checkbox"][name*="amera"]');
        if (cb && !cb.checked) cb.click();
    });
    await new Promise(r => setTimeout(r, 3000));

    // Cycle through sidebar camera carousel and click Show Video for each
    // Carousel has < > arrows visible in the screenshot
    const cycleCount = 20; // try up to 20 carousel positions
    for (let i = 0; i < cycleCount; i++) {
        // Click Show Video
        const btnPos = await page.evaluate(() => {
            const all = [...document.querySelectorAll('button, a')];
            const btn = all.find(el => /show\s*video/i.test(el.textContent?.trim()));
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });

        if (btnPos) {
            await page.mouse.move(btnPos.x, btnPos.y);
            await page.mouse.down();
            await new Promise(r => setTimeout(r, 100));
            await page.mouse.up();
            console.log(`[${i + 1}/${cycleCount}] Clicked Show Video`);
            await new Promise(r => setTimeout(r, 3000));
        }

        // Click the Next/Right arrow in the carousel
        const nextArrow = await page.evaluate(() => {
            const all = [...document.querySelectorAll('button, a, span, i, div')];
            // Look for right arrow by text content or class
            const arrow = all.find(el => {
                const text = el.textContent?.trim();
                const cls  = el.className || '';
                return text === '>' || text === '›' || text === '❯' ||
                       cls.includes('next') || cls.includes('right') || cls.includes('arrow-right') ||
                       el.getAttribute('aria-label')?.toLowerCase().includes('next');
            });
            if (!arrow) return null;
            const r = arrow.getBoundingClientRect();
            if (r.width === 0) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: arrow.textContent?.trim(), cls: arrow.className };
        });

        if (nextArrow) {
            await page.mouse.click(nextArrow.x, nextArrow.y);
            console.log(`  Carousel next → "${nextArrow.text}" (${nextArrow.cls})`);
            await new Promise(r => setTimeout(r, 2000));
        } else {
            console.log('  No carousel next arrow found');
            break;
        }

        const found = Object.keys(captured).length;
        console.log(`  Tokens captured so far: ${found}/${KNOWN_CHANS.size}`);
        if (found === KNOWN_CHANS.size) break;
    }

    await page.screenshot({ path: 'debug.png' });
    await browser.close();

    console.log(`\nCapture summary: ${Object.keys(captured).length}/${KNOWN_CHANS.size} tokens found`);
    return captured;
}

async function updateIndexHTML(newTokens) {
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error('index.html not found');

    let html = fs.readFileSync(indexPath, 'utf8');

    // Read existing tokenConfig so we only overwrite tokens we actually refreshed
    const existingMatch = html.match(/const tokenConfig = ({[\s\S]*?});/);
    let existing = {};
    if (existingMatch) {
        try { existing = JSON.parse(existingMatch[1]); } catch (_) {}
    }

    const merged = { ...existing, ...newTokens, updated: new Date().toISOString() };

    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(html)) throw new Error('Anchor comments not found in index.html');

    html = html.replace(regex,
        `$1\n        const tokenConfig = ${JSON.stringify(merged, null, 2)};\n        $2`);

    fs.writeFileSync(indexPath, html, 'utf8');

    const count = Object.keys(newTokens).length;
    console.log(`✅ index.html updated with ${count} refreshed token(s).`);
    if (count < 20) {
        console.warn(`⚠ Only ${count}/20 tokens refreshed — remaining tokens kept from previous run.`);
    }
}

async function main() {
    const tokens = await scrapeTokens();

    if (Object.keys(tokens).length === 0) {
        console.error('⛔ No tokens captured.');
        process.exit(1);
    }

    await updateIndexHTML(tokens);
}

main().catch(err => {
    console.error('⛔', err.message);
    process.exit(1);
});
