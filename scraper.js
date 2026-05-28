const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';

async function getFreshStreamToken() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Intercept the token API response the moment it fires
    let streamToken = null;
    page.on('response', async response => {
        if (!response.url().includes('GetSecureTokenUri')) return;
        try {
            const text = await response.text();
            console.log(`[token API] HTTP ${response.status()}: ${text}`);
            const m = text.match(/token=([a-f0-9]+)/);
            if (m) streamToken = m[1];
        } catch (_) {}
    });

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('Page loaded. Waiting for camera markers...');

    // Wait for camera marker images to be in the DOM
    await page.waitForSelector('img[src*="map_camera"]', { timeout: 30000 });

    // Get the screen coordinates of the first camera marker and mouse-click it
    const markerPos = await page.evaluate(() => {
        const img = document.querySelector('img[src*="map_camera"]');
        if (!img) return null;
        const rect = img.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

    if (!markerPos) throw new Error('Camera marker not found in DOM.');
    console.log(`Mouse-clicking marker at (${markerPos.x}, ${markerPos.y})`);
    await page.mouse.click(markerPos.x, markerPos.y);

    // Wait for InfoWindow / popup to appear
    await new Promise(r => setTimeout(r, 3000));

    // Log the popup content so we know exactly what text/buttons are inside
    const popupInfo = await page.evaluate(() => {
        const sel = '.gm-style-iw, [class*="info"], [class*="popup"], [class*="tooltip"]';
        const popup = document.querySelector(sel);
        if (!popup) return null;
        return {
            text: popup.innerText?.slice(0, 500),
            buttons: [...popup.querySelectorAll('a, button, [role="button"]')]
                .map(el => ({ tag: el.tagName, text: el.innerText?.trim(), class: el.className }))
        };
    });

    if (!popupInfo) {
        // Take a screenshot for debugging
        await page.screenshot({ path: 'debug.png', fullPage: false });
        console.log('No popup found — saved debug.png');
        await browser.close();
        throw new Error('No popup appeared after clicking camera marker.');
    }

    console.log('Popup text:', popupInfo.text);
    console.log('Popup buttons:', JSON.stringify(popupInfo.buttons));

    // Mouse-click the Show Video button using its coordinates
    const videoBtn = await page.evaluate(() => {
        const all = [...document.querySelectorAll('a, button, [role="button"], span, div')];
        const btn = all.find(el => /show.?video|play|video|watch|stream/i.test(el.textContent?.trim()));
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: btn.textContent?.trim() };
    });

    if (!videoBtn) {
        await browser.close();
        throw new Error('Could not find Show Video button — check popup buttons logged above.');
    }

    console.log(`Mouse-clicking "${videoBtn.text}" at (${videoBtn.x}, ${videoBtn.y})`);
    await page.mouse.click(videoBtn.x, videoBtn.y);

    // Wait for token API call
    const deadline = Date.now() + 15000;
    while (!streamToken && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));

    await browser.close();
    if (!streamToken) throw new Error('Token API was not called after clicking Show Video.');

    console.log(`✅ Stream token: ${streamToken}`);
    return streamToken;
}

async function updateIndexHTML() {
    const token = await getFreshStreamToken();

    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error('index.html not found');

    let html = fs.readFileSync(indexPath, 'utf8');
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(html)) throw new Error('Anchor comments not found in index.html');

    const config = { token, updated: new Date().toISOString() };
    html = html.replace(regex,
        `$1\n        const tokenConfig = ${JSON.stringify(config, null, 2)};\n        $2`);

    fs.writeFileSync(indexPath, html, 'utf8');
    console.log('✅ index.html updated successfully.');
}

updateIndexHTML().catch(err => {
    console.error('⛔', err.message);
    process.exit(1);
});
