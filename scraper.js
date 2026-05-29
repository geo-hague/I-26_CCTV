const fs   = require('fs');
const path = require('path');

const DRIVENC = 'https://www.drivenc.gov';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Pure diagnostic — find the endpoint that issues per-camera UUIDs
async function findInitEndpoint() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    // Log every single network request and response
    const allRequests = [];

    page.on('request', req => {
        allRequests.push({ type: 'req', method: req.method(), url: req.url(), body: req.postData()?.slice(0,200) });
        req.continue();
    });

    page.on('response', async res => {
        const url = res.url();
        // Skip noise: images, fonts, maps tiles, analytics
        if (/\.(png|jpg|gif|svg|woff|woff2|css)(\?|$)/i.test(url)) return;
        if (url.includes('google') || url.includes('qualtrics') || url.includes('googleapis')) return;

        try {
            const ct   = res.headers()['content-type'] || '';
            const text = await res.text();

            // Log everything from insight-atms or drivenc regardless
            if (url.includes('insight-atms') || url.includes('drivenc.gov')) {
                console.log(`\n[${res.status()}] ${url}`);
                if (ct.includes('json') || ct.includes('text')) {
                    console.log(`  ${text.slice(0, 400)}`);
                }
            }

            // Flag any response containing a UUID pattern before Show Video is clicked
            const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
            const validUUIDs = uuids.filter(u => u !== '00000000-0000-0000-0000-000000000000');
            if (validUUIDs.length > 0 && !url.includes('google') && !url.includes('qualtrics')) {
                console.log(`\n*** UUID(s) found in response from: ${url}`);
                console.log(`    ${validUUIDs.join(', ')}`);
                console.log(`    Body: ${text.slice(0, 300)}`);
            }
        } catch (_) {}
    });

    console.log('Loading drivenc.gov and logging ALL network activity...\n');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 5000));

    // Dismiss modal then wait without clicking Show Video
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    // Log the page's JS bundle URLs — the UUID generation logic is in one of them
    const scripts = await page.evaluate(() =>
        [...document.querySelectorAll('script[src]')].map(s => s.src)
    );
    console.log('\nLoaded scripts:');
    scripts.forEach(s => console.log(' ', s));

    // Check if the Angular/JS app exposes any camera data on window
    const windowData = await page.evaluate(() => {
        const result = {};
        // Check common Angular/React data stores
        for (const key of ['__INITIAL_STATE__', '__STORE__', 'appData', 'cameraData', 'cameras', 'vdsData']) {
            if (window[key]) result[key] = JSON.stringify(window[key]).slice(0, 300);
        }
        // Check Angular root scope if available
        try {
            const appEl = document.querySelector('[ng-app], [data-ng-app], app-root, [ng-controller]');
            if (appEl) {
                const scope = angular?.element(appEl)?.scope?.();
                if (scope) result['ngScope'] = JSON.stringify(scope).slice(0, 300);
            }
        } catch (_) {}
        return result;
    });
    if (Object.keys(windowData).length > 0) {
        console.log('\nWindow app data:', JSON.stringify(windowData, null, 2));
    }

    await browser.close();
}

findInitEndpoint().catch(err => { console.error('⛔', err.message); process.exit(1); });
