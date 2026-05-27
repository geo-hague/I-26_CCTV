const fs   = require('fs');
const path = require('path');

const TOKEN_API      = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const PROBE_SOURCE   = '589';
const PROBE_DIVISION = 'Division 14';

async function getSessionUUID() {
    const puppeteer = require('puppeteer');
    console.log('Launching browser to extract session UUID...');

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Intercept the real API call if it fires — captures UUID + returns stream token directly
    let streamToken = null;
    page.on('response', async response => {
        if (response.url().includes('GetSecureTokenUri') && !streamToken) {
            try {
                const text = await response.text();
                const m = text.match(/token=([a-f0-9]+)/);
                if (m) { streamToken = m[1]; console.log(`[intercept] Stream token: ${streamToken}`); }
            } catch (_) {}
        }
    });

    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('Page loaded.');

    // Search every likely location for the UUID
    const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

    const uuid = await page.evaluate((uuidPattern) => {
        const re = new RegExp(uuidPattern, 'i');

        // 1. localStorage
        for (let i = 0; i < localStorage.length; i++) {
            const val = localStorage.getItem(localStorage.key(i));
            if (re.test(val)) return val;
        }

        // 2. sessionStorage
        for (let i = 0; i < sessionStorage.length; i++) {
            const val = sessionStorage.getItem(sessionStorage.key(i));
            if (re.test(val)) return val;
        }

        // 3. Common window variable names
        const candidates = ['token','sessionToken','clientToken','authToken','uuid',
                            'sessionId','clientId','userToken','accessToken','apiToken'];
        for (const key of candidates) {
            if (window[key] && re.test(window[key])) return window[key];
        }

        // 4. Dump all localStorage/sessionStorage keys so we can see what's there
        const lsKeys = Array.from({length: localStorage.length}, (_, i) => localStorage.key(i));
        const ssKeys = Array.from({length: sessionStorage.length}, (_, i) => sessionStorage.key(i));
        return { notFound: true, localStorage: lsKeys, sessionStorage: ssKeys };

    }, '^[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}$');

    if (typeof uuid === 'object' && uuid.notFound) {
        console.log('UUID not found in storage. Keys present:',
            'localStorage:', uuid.localStorage,
            '| sessionStorage:', uuid.sessionStorage);
    }

    // If the page already triggered a token API call, we're done
    if (streamToken) { await browser.close(); return { streamToken }; }

    // Otherwise use the UUID we found to call the API ourselves
    if (typeof uuid === 'string') {
        console.log(`UUID found: ${uuid}`);
        await browser.close();
        return { sessionUUID: uuid };
    }

    await browser.close();
    throw new Error('UUID not found — check logs above for storage keys');
}

async function getFreshStreamToken() {
    const result = await getSessionUUID();

    // Lucky path — page already triggered the API call and we intercepted the token
    if (result.streamToken) return result.streamToken;

    // Normal path — call the API with the UUID we extracted
    const { sessionUUID } = result;
    console.log(`Calling token API with UUID: ${sessionUUID}`);

    const res = await fetch(TOKEN_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/json',
            'Referer':      'https://www.drivenc.gov/',
            'Origin':       'https://www.drivenc.gov',
        },
        body: JSON.stringify({
            token:          sessionUUID,
            sourceId:       PROBE_SOURCE,
            systemSourceId: PROBE_DIVISION,
        }),
    });

    if (!res.ok) throw new Error(`Token API HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    console.log('Token API response:', JSON.stringify(data));

    const match = String(data).match(/token=([a-f0-9]+)/);
    if (!match) throw new Error(`Stream token not found in: ${JSON.stringify(data)}`);
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
