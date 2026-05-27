const fs   = require('fs');
const path = require('path');

const TOKEN_API      = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const PROBE_SOURCE   = '589';
const PROBE_DIVISION = 'Division 14';
const UUID_RE        = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i;

async function getFreshStreamToken() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    let clientUUID = null;

    // Intercept every response on page load and look for a UUID
    page.on('response', async response => {
        const url    = response.url();
        const status = response.status();
        const ct     = response.headers()['content-type'] || '';

        // Only inspect JSON / plain-text responses
        if (!ct.includes('json') && !ct.includes('text/plain')) return;

        try {
            const text = await response.text();

            // Log every JSON response so we can see what's available
            if (ct.includes('json') && text.length < 2000) {
                console.log(`[response] ${status} ${url}`);
                console.log(`           ${text.slice(0, 300)}`);
            }

            // Grab the first UUID we find
            if (!clientUUID) {
                const m = text.match(UUID_RE);
                if (m) {
                    clientUUID = m[0];
                    console.log(`✔ UUID found in response from: ${url}`);
                    console.log(`  Value: ${clientUUID}`);
                }
            }
        } catch (_) {}
    });

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    // Extra wait for any deferred API calls
    await new Promise(r => setTimeout(r, 5000));

    if (!clientUUID) {
        // Last resort: inspect the full JS heap for UUID-shaped strings
        console.log('No UUID in responses — scanning JS heap...');
        clientUUID = await page.evaluate(() => {
            const re = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i;
            // Walk every enumerable window property one level deep
            for (const key of Object.keys(window)) {
                try {
                    const val = window[key];
                    if (typeof val === 'string' && re.test(val)) return val;
                    if (val && typeof val === 'object') {
                        const json = JSON.stringify(val);
                        const m = json.match(re);
                        if (m) return m[0];
                    }
                } catch (_) {}
            }
            return null;
        });
        if (clientUUID) console.log(`✔ UUID found in JS heap: ${clientUUID}`);
    }

    if (!clientUUID) {
        await browser.close();
        throw new Error('UUID not found in any response or JS heap. Check [response] logs above.');
    }

    // Call the token API from inside the browser (carries session cookie)
    const result = await page.evaluate(async (apiUrl, uuid, sourceId, systemSourceId) => {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ token: uuid, sourceId, systemSourceId }),
        });
        return { status: res.status, body: await res.text() };
    }, TOKEN_API, clientUUID, PROBE_SOURCE, PROBE_DIVISION);

    await browser.close();
    console.log(`Token API → HTTP ${result.status}: ${result.body}`);

    if (result.status !== 200) throw new Error(`Token API HTTP ${result.status}: ${result.body}`);

    const match = result.body.match(/token=([a-f0-9]+)/);
    if (!match) throw new Error(`Stream token not found in: ${result.body}`);

    console.log(`✅ Stream token: ${match[1]}`);
    return match[1];
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
