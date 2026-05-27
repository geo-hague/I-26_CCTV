const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';

// Probe camera — any valid camera on the system works since the token is global
const PROBE_SOURCE_ID    = '589';
const PROBE_SYSTEM_ID    = 'Division 14';

async function getFreshStreamToken() {
    // Generate a fresh client-side UUID the same way the browser does
    const sessionToken = crypto.randomUUID();
    console.log(`Session UUID: ${sessionToken}`);

    const res = await fetch(TOKEN_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/json, text/plain, */*',
            'Referer':      'https://www.drivenc.gov/',
            'Origin':       'https://www.drivenc.gov',
        },
        body: JSON.stringify({
            token:          sessionToken,
            sourceId:       PROBE_SOURCE_ID,
            systemSourceId: PROBE_SYSTEM_ID,
        }),
    });

    if (!res.ok) throw new Error(`Token API HTTP ${res.status}: ${await res.text()}`);

    const data = await res.json();
    console.log('Token API response:', JSON.stringify(data));

    // Response shape: "?token=XXXX"
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
