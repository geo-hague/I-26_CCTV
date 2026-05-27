const fs   = require('fs');
const path = require('path');

const TOKEN_API   = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const DRIVENC_URL = 'https://www.drivenc.gov/';

// Known working values from DevTools inspection
const PROBE_SOURCE_ID    = '589';
const PROBE_SYSTEM_ID    = 'Division 14';

const BASE_HEADERS = {
    'Accept':          'application/json, text/plain, */*',
    'Referer':         'https://www.drivenc.gov/',
    'Origin':          'https://www.drivenc.gov',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

async function getSessionToken() {
    console.log('Fetching drivenc.gov to extract session token...');
    const res = await fetch(DRIVENC_URL, {
        headers: { ...BASE_HEADERS, 'Accept': 'text/html' }
    });
    if (!res.ok) throw new Error(`drivenc.gov returned HTTP ${res.status}`);

    const html = await res.text();

    // Look for a UUID in the page source
    const match = html.match(/['"]([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})['"]/i);
    if (match) {
        console.log(`Session token found in page: ${match[1]}`);
        return { token: match[1], cookies: res.headers.get('set-cookie') };
    }

    // Log a snippet around any 'token' keyword to help diagnose
    const idx = html.toLowerCase().indexOf('token');
    if (idx !== -1) {
        console.log('Token context in page HTML:', html.slice(Math.max(0, idx - 50), idx + 150));
    } else {
        console.log('No "token" keyword found in page HTML at all.');
    }

    throw new Error('Could not find session UUID in drivenc.gov page source.');
}

async function getFreshStreamToken(sessionToken, cookies) {
    console.log(`Calling token API with sourceId=${PROBE_SOURCE_ID}...`);

    const headers = { ...BASE_HEADERS, 'Content-Type': 'application/json' };
    if (cookies) headers['Cookie'] = cookies;

    const res = await fetch(TOKEN_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            token:          sessionToken,
            sourceId:       PROBE_SOURCE_ID,
            systemSourceId: PROBE_SYSTEM_ID,
        }),
    });

    if (!res.ok) throw new Error(`Token API HTTP ${res.status}: ${await res.text()}`);

    const data = await res.json();
    console.log('Token API response:', JSON.stringify(data));

    // Response is just the query string: "?token=XXXX"
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    const match = raw.match(/token=([a-f0-9]+)/);
    if (!match) throw new Error(`Stream token not found in: ${raw}`);

    console.log(`✅ Stream token: ${match[1]}`);
    return match[1];
}

async function updateIndexHTML() {
    const { token: sessionToken, cookies } = await getSessionToken();
    const streamToken = await getFreshStreamToken(sessionToken, cookies);

    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error('index.html not found');

    let html = fs.readFileSync(indexPath, 'utf8');
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(html)) throw new Error('Anchor comments not found in index.html');

    const config = { token: streamToken, updated: new Date().toISOString() };
    html = html.replace(regex,
        `$1\n        const tokenConfig = ${JSON.stringify(config, null, 2)};\n        $2`);

    fs.writeFileSync(indexPath, html, 'utf8');
    console.log('✅ index.html updated successfully.');
}

updateIndexHTML().catch(err => {
    console.error('⛔', err.message);
    process.exit(1);
});
