const fs   = require('fs');
const path = require('path');

const TOKEN_API      = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const PROBE_SOURCE   = '589';
const PROBE_DIVISION = 'Division 14';

async function getFreshStreamToken() {
    const puppeteer = require('puppeteer');
    console.log('Launching browser...');

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('Page loaded — session cookie acquired.');

    // Make the token API call from inside the browser so session cookies are sent automatically.
    // The UUID field may just need to be any valid UUID format.
    const result = await page.evaluate(async (apiUrl, sourceId, systemSourceId) => {
        const uuid = crypto.randomUUID();
        console.log('Using UUID:', uuid);

        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept':       'application/json',
                'Referer':      'https://www.drivenc.gov/',
                'Origin':       'https://www.drivenc.gov',
            },
            body: JSON.stringify({ token: uuid, sourceId, systemSourceId }),
        });

        const text = await res.text();
        return { status: res.status, body: text, uuid };
    }, TOKEN_API, PROBE_SOURCE, PROBE_DIVISION);

    await browser.close();

    console.log(`API call from browser context → HTTP ${result.status}: ${result.body}`);
    console.log(`UUID used: ${result.uuid}`);

    if (result.status !== 200) {
        throw new Error(`Token API HTTP ${result.status}: ${result.body}`);
    }

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
