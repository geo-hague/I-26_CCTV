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

    // Log ALL insight-atms responses
    page.on('response', async response => {
        const url = response.url();
        if (!url.includes('insight-atms')) return;
        try {
            const text = await response.text();
            console.log(`[insight-atms] ${response.status()} ${url}`);
            console.log(`  body: ${text.slice(0, 300)}`);
        } catch (_) {}
    });

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));

    // Dismiss modal
    await page.evaluate(() => {
        const close = document.querySelector('[aria-label="Close"], .close, button.close');
        if (close) { close.click(); return; }
        const next = [...document.querySelectorAll('button')].find(b => /next|ok|close|dismiss/i.test(b.textContent));
        if (next) next.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    // Find Show Video button and use full mouse event sequence
    const pos = await page.evaluate(() => {
        const all = [...document.querySelectorAll('button, a, span, div')];
        const btn = all.find(el => /show\s*video/i.test(el.textContent?.trim()));
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            text: btn.textContent.trim(),
            tag: btn.tagName,
            className: btn.className
        };
    });

    if (!pos) throw new Error('Show Video button not found.');
    console.log(`Found: <${pos.tag} class="${pos.className}">${pos.text}</${pos.tag}> at (${pos.x}, ${pos.y})`);

    // Full mouse sequence: move → down → up → click
    await page.mouse.move(pos.x, pos.y);
    await new Promise(r => setTimeout(r, 300));
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 100));
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 3000));

    // Screenshot to see what happened after the click
    await page.screenshot({ path: 'debug.png' });
    console.log('Screenshot taken after click.');

    // Log what changed in the DOM — any new modals, video players, etc.
    const domChanges = await page.evaluate(() => {
        const videos = [...document.querySelectorAll('video')].map(v => ({ src: v.src, currentSrc: v.currentSrc }));
        const iframes = [...document.querySelectorAll('iframe')].map(f => f.src);
        const modals = [...document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"]')]
            .map(el => ({ class: el.className, text: el.innerText?.slice(0, 100) }));
        return { videos, iframes, modals };
    });

    console.log('Videos in DOM:', JSON.stringify(domChanges.videos));
    console.log('Iframes:', JSON.stringify(domChanges.iframes));
    console.log('Modals/dialogs:', JSON.stringify(domChanges.modals));

    // Wait longer for any deferred API call
    console.log('Waiting 15s for token API call...');
    let streamToken = null;
    page.on('response', async response => {
        if (!response.url().includes('GetSecureTokenUri')) return;
        try {
            const text = await response.text();
            const m = text.match(/token=([a-f0-9]+)/);
            if (m) streamToken = m[1];
        } catch (_) {}
    });

    const deadline = Date.now() + 15000;
    while (!streamToken && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));

    await browser.close();
    if (!streamToken) throw new Error('Token API not called — check debug.png and logs above.');

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
