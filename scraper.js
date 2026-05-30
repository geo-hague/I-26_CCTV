const fs   = require('fs');
const path = require('path');

const DRIVENC = 'https://www.drivenc.gov';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    // Array to capture potential target response payloads
    let capturedPayloads = [];

    // Listen to network responses in real-time
    page.on('response', async (response) => {
        const url = response.url();
        const type = response.request().resourceType();

        // Target API traffic (XHR/Fetch requests) matching common patterns
        if (type === 'xhr' || type === 'fetch' || url.includes('Camera') || url.includes('Map')) {
            try {
                const status = response.status();
                if (status === 200) {
                    const text = await response.text();
                    
                    // Look for indicators of camera lists or tokens inside the response text
                    if (text.includes('camera') || text.includes('token') || text.includes('SourceId')) {
                        console.log(`[Network Intercepted] Captured matching endpoint: ${url.substring(0, 90)}...`);
                        capturedPayloads.push({
                            url: url,
                            data: text
                        });
                    }
                }
            } catch (e) {
                // Silently ignore responses that can't be read (binary files, images, etc.)
            }
        }
    });

    console.log('Loading drivenc.gov...');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 4000));

    // Clear initial popups
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    console.log('Activating Cameras Layer...');
    await page.evaluate(() => {
        const all = [...document.querySelectorAll('label, span, div, input')];
        const el = all.find(e => e.textContent?.trim() === 'Cameras');
        if (el) el.click();
    });

    console.log('Waiting 8 seconds to capture active API responses...');
    await new Promise(r => setTimeout(r, 8000));

    console.log('Processing Captured Network Traffic...');
    if (capturedPayloads.length === 0) {
        console.log('❌ No matching JSON API strings passed through the network logs.');
    } else {
        console.log(`\nFound ${capturedPayloads.length} potential background data streams.`);
        
        // Let's print out snippets of what we caught so we can locate the tokens
        capturedPayloads.forEach((payload, index) => {
            console.log(`\n--- Payload #${index + 1} Source URL: ${payload.url} ---`);
            console.log(payload.data.substring(0, 600)); // Print first 600 characters
            
            // If it smells like a JSON string containing token blocks, save it out!
            if (payload.data.includes('token') || payload.data.includes('SecureToken')) {
                fs.writeFileSync(`captured-tokens-${index}.json`, payload.data);
                console.log(`💾 Saved target stream data payload to captured-tokens-${index}.json`);
            }
        });
    }

    await browser.close();
}

run().catch(err => { console.error('⛔ Error running scraper:', err.message); process.exit(1); });