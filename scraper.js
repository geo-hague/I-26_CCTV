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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Capture the stream token from the API response the moment it fires
    let streamToken = null;
    page.on('response', async response => {
        if (!response.url().includes('GetSecureTokenUri')) return;
        try {
            const text = await response.text();
            console.log(`[GetSecureTokenUri] HTTP ${response.status()}: ${text}`);
            const m = text.match(/token=([a-f0-9]+)/);
            if (m) streamToken = m[1];
        } catch (_) {}
    });

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('Page loaded. Waiting for camera markers...');

    // Camera markers are rendered as img tags with the camera SVG
    // Wait up to 30s for at least one to appear
    try {
        await page.waitForSelector('img[src*="map_camera"]', { timeout: 30000 });
    } catch (_) {
        // Markers may be divs or use a different mechanism — log what's in the DOM
        const markerInfo = await page.evaluate(() => {
            const imgs = [...document.querySelectorAll('img')].map(i => i.src).filter(s => s.includes('511') || s.includes('camera'));
            const divs = [...document.querySelectorAll('[title], [aria-label]')]
                .slice(0, 10).map(el => ({ tag: el.tagName, title: el.title || el.getAttribute('aria-label') }));
            return { imgs, divs };
        });
        console.log('Camera img srcs found:', markerInfo.imgs);
        console.log('Titled/labelled elements:', JSON.stringify(markerInfo.divs));
    }

    // Click the first camera marker
    const clicked = await page.evaluate(() => {
        // Try img tag first
        const img = document.querySelector('img[src*="map_camera"]');
        if (img) { img.click(); return 'img[src*="map_camera"]'; }

        // Fallback: any element with title/aria-label hinting at camera
        const els = [...document.querySelectorAll('[title], [aria-label]')];
        const cam = els.find(el => {
            const label = (el.title || el.getAttribute('aria-label') || '').toLowerCase();
            return label.includes('camera') || label.includes('cctv') || label.includes('video');
        });
        if (cam) { cam.click(); return cam.title || cam.getAttribute('aria-label'); }

        return null;
    });

    if (!clicked) {
        await browser.close();
        throw new Error('No camera marker found in DOM. Check selector output above.');
    }
    console.log(`Clicked marker: ${clicked}`);

    // Wait for the info popup to appear, then find and click "Show Video"
    await new Promise(r => setTimeout(r, 3000));

    const videoClicked = await page.evaluate(() => {
        // Look for "Show Video" or "Video" button/link/span in the popup
        const all = [...document.querySelectorAll('a, button, span, div')];
        const btn = all.find(el => /show\s*video|play\s*video|view\s*video|watch/i.test(el.textContent));
        if (btn) { btn.click(); return btn.textContent.trim(); }
        return null;
    });

    if (!videoClicked) {
        // Log visible popup text to help diagnose
        const popupText = await page.evaluate(() => {
            const popup = document.querySelector('.gm-style-iw, [class*="popup"], [class*="infowindow"], [class*="info-window"]');
            return popup ? popup.innerText : '(no popup found)';
        });
        console.log('Popup text:', popupText);
        await browser.close();
        throw new Error('Could not find "Show Video" button in popup.');
    }
    console.log(`Clicked: "${videoClicked}"`);

    // Wait for the token API call to complete
    const deadline = Date.now() + 15000;
    while (!streamToken && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
    }

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
