const fs   = require('fs');
const path = require('path');

// One probe channel is enough — the token is shared across all cameras
const PROBE_SOURCE_ID = 'chan-5373_l';
const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';

async function getFreshToken() {
    const url = `${TOKEN_API}?sourceId=${PROBE_SOURCE_ID}`;
    console.log(`Fetching token from: ${url}`);

    const res = await fetch(url, {
        headers: {
            'Accept':          'application/json, text/plain, */*',
            'Referer':         'https://www.drivenc.gov/',
            'Origin':          'https://www.drivenc.gov',
        }
    });

    if (!res.ok) {
        throw new Error(`API returned HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    console.log('API response:', JSON.stringify(data));

    // Extract token from wherever it sits in the response.
    // Common shapes: { uri: "...?token=XXX" }  or  { token: "XXX" }  or  just a plain string URL
    let token = null;

    if (typeof data === 'string') {
        token = data.match(/token=([a-f0-9]+)/)?.[1] ?? null;
    } else if (data.uri || data.url || data.streamUrl || data.Uri || data.URL) {
        const uri = data.uri ?? data.url ?? data.streamUrl ?? data.Uri ?? data.URL;
        token = uri.match(/token=([a-f0-9]+)/)?.[1] ?? null;
    } else if (data.token || data.Token) {
        token = data.token ?? data.Token;
    }

    if (!token) {
        throw new Error(`Could not find token in response: ${JSON.stringify(data)}`);
    }

    console.log(`✅ Token captured: ${token}`);
    return token;
}

async function updateIndexHTML() {
    const token = await getFreshToken();

    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) {
        throw new Error(`index.html not found at ${indexPath}`);
    }

    let html = fs.readFileSync(indexPath, 'utf8');

    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(html)) {
        throw new Error("Anchor comments not found in index.html");
    }

    const config = { token, updated: new Date().toISOString() };
    html = html.replace(
        regex,
        `$1\n        const tokenConfig = ${JSON.stringify(config, null, 2)};\n        $2`
    );

    fs.writeFileSync(indexPath, html, 'utf8');
    console.log('✅ index.html updated successfully.');
}

updateIndexHTML().catch(err => {
    console.error('⛔', err.message);
    process.exit(1);
});
