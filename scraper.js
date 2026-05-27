const fs   = require('fs');
const path = require('path');

const TOKEN_API   = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const CAMERAS_API = 'https://www.drivenc.gov/map/mapIcons/Cameras';

const HEADERS = {
    'Accept':   'application/json, text/plain, */*',
    'Referer':  'https://www.drivenc.gov/',
    'Origin':   'https://www.drivenc.gov',
};

async function getSourceId() {
    console.log(`Fetching camera list from: ${CAMERAS_API}`);
    const res = await fetch(CAMERAS_API, { headers: HEADERS });
    if (!res.ok) throw new Error(`Camera list HTTP ${res.status}: ${await res.text()}`);

    const data = await res.json();

    // Log the first entry so we can see the data shape
    const first = Array.isArray(data) ? data[0] : Object.values(data)[0];
    console.log('Camera list sample entry:', JSON.stringify(first));

    // Find any entry whose channel/name matches one of our known channels
    const KNOWN_CHANNELS = [
        'chan-5373_l','chan-5374_l','chan-5375_l','chan-5376_l','chan-5378_l',
        'chan-6332_l','chan-5381_l','chan-5432_l','chan-5440_l','chan-5441_l',
        'chan-6279_l','chan-5442_l','chan-5443_l','chan-6275_l','chan-6276_l',
        'chan-6327_l','chan-6328_l','chan-5444_l','chan-5446_l','chan-5445_l',
    ];

    const list = Array.isArray(data) ? data : Object.values(data);
    for (const cam of list) {
        const vals = Object.values(cam).map(v => String(v).toLowerCase());
        if (KNOWN_CHANNELS.some(ch => vals.some(v => v.includes(ch.replace('_l',''))))) {
            console.log('Matched camera entry:', JSON.stringify(cam));
            // Return whichever field looks like a numeric or primary ID
            return cam.id ?? cam.Id ?? cam.sourceId ?? cam.SourceId ?? cam.cameraId ?? cam.CameraId ?? null;
        }
    }

    // No match — just return the first entry's ID so we can still test the token API
    console.warn('No channel match found; using first camera ID as probe.');
    return first?.id ?? first?.Id ?? first?.sourceId ?? first?.SourceId ?? null;
}

async function getFreshToken() {
    const sourceId = await getSourceId();
    if (!sourceId) throw new Error('Could not determine a sourceId from the camera list.');
    console.log(`Using sourceId: ${sourceId}`);

    const res = await fetch(TOKEN_API, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId }),
    });

    if (!res.ok) throw new Error(`Token API HTTP ${res.status}: ${await res.text()}`);

    const data = await res.json();
    console.log('Token API response:', JSON.stringify(data));

    // Extract token from common response shapes
    const raw = typeof data === 'string' ? data
        : data.uri ?? data.Uri ?? data.url ?? data.URL ?? data.streamUrl
       ?? data.token ?? data.Token ?? '';

    const match = String(raw).match(/token=([a-f0-9]+)/);
    if (!match) throw new Error(`Token not found in: ${JSON.stringify(data)}`);

    console.log(`✅ Token captured: ${match[1]}`);
    return match[1];
}

async function updateIndexHTML() {
    const token = await getFreshToken();

    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error(`index.html not found at ${indexPath}`);

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
