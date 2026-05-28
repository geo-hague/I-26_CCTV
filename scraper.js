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
    await new Promise(r => setTimeout(r, 3000));

    // Dismiss the welcome modal
    const dismissed = await page.evaluate(() => {
        // Try the X button first, then "Next"
        const close = document.querySelector('[aria-label="Close"], .close, button.close');
        if (close) { close.click(); return 'close button'; }
        const next = [...document.querySelectorAll('button')].find(b => /next|ok|close|dismiss|got it/i.test(b.textContent));
        if (next) { next.click(); return next.textContent.trim(); }
        return null;
    });
    console.log(dismissed ? `Dismissed modal via: "${dismissed}"` : 'No modal found');
    await new Promise(r => setTimeout(r, 1000));

    // Click the Show Video button already visible in the sidebar
    const btn = await page.waitForSelector('button, a', { timeout: 5000 }).catch(() => null);
    const clicked = await page.evaluate(() => {
        const all = [...document.querySelectorAll('button, a, span')];
        const showVideo = all.find(el => /show\s*video/i.test(el.textContent));
        if (!showVideo) return null;
        const rect = showVideo.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: showVideo.textContent.trim() };
    });

    if (!clicked) {
        await page.screenshot({ path: 'debug.png' });
        await browser.close();
        throw new Error('Show Video button not found after dismissing modal — see debug.png');
    }

    console.log(`Clicking "${clicked.text}" at (${clicked.x}, ${clicked.y})`);
    await page.mouse.click(clicked.x, clicked.y);

    // Wait for the token API call
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
