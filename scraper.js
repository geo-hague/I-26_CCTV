const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const DRIVENC   = 'https://www.drivenc.gov';
const UA        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Permanent sourceId map — west to east along I-26
// Obtained from DevTools inspection; these IDs are stable and won't change
const SOURCE_MAP = [
    { chan: "chan-5373_l", sourceId: "518",  division: "Division 13" },
    { chan: "chan-5374_l", sourceId: "519",  division: "Division 13" },
    { chan: "chan-5375_l", sourceId: "520",  division: "Division 13" },
    { chan: "chan-5376_l", sourceId: "521",  division: "Division 13" },
    { chan: "chan-5378_l", sourceId: "523",  division: "Division 13" },
    { chan: "chan-6332_l", sourceId: "2184", division: "Division 13" },
    { chan: "chan-5381_l", sourceId: "526",  division: "Division 13" },
    { chan: "chan-5432_l", sourceId: "577",  division: "Division 14" },
    { chan: "chan-5440_l", sourceId: "585",  division: "Division 14" },
    { chan: "chan-5441_l", sourceId: "2132", division: "Division 13" },
    { chan: "chan-6279_l", sourceId: "2137", division: "Division 13" },
    { chan: "chan-5442_l", sourceId: "587",  division: "Division 14" },
    { chan: "chan-5443_l", sourceId: "588",  division: "Division 14" },
    { chan: "chan-6275_l", sourceId: "2133", division: "Division 13" },
    { chan: "chan-6276_l", sourceId: "2134", division: "Division 14" },
    { chan: "chan-6327_l", sourceId: "2180", division: "Division 14" },
    { chan: "chan-6328_l", sourceId: "2181", division: "Division 14" },
    { chan: "chan-5444_l", sourceId: "589",  division: "Division 14" },
    { chan: "chan-5446_l", sourceId: "591",  division: "Division 14" },
    { chan: "chan-5445_l", sourceId: "590",  division: "Division 14" },
];

// ── Step 1: get a valid session UUID from drivenc.gov via Puppeteer ───────────
async function getSessionUUID() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    let uuid = null;

    page.on('request', req => {
        if (req.url().includes('GetSecureTokenUri') && req.method() === 'POST') {
            try {
                const body = JSON.parse(req.postData() || '{}');
                if (body.token && !uuid) uuid = body.token;
            } catch (_) {}
        }
        req.continue();
    });

    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 2000));

    // Dismiss modal
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 300));
    const xBtn = await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (xBtn) await page.mouse.click(xBtn.x, xBtn.y);
    await new Promise(r => setTimeout(r, 800));

    // Click Show Video to trigger a POST and capture the session UUID
    const btn = await page.evaluate(() => {
        const el = [...document.querySelectorAll('button, a')]
            .find(e => /show\s*video/i.test(e.textContent?.trim()));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (btn) {
        await page.mouse.move(btn.x, btn.y);
        await page.mouse.down(); await new Promise(r => setTimeout(r, 80)); await page.mouse.up();
        await new Promise(r => setTimeout(r, 2000));
    }

    await browser.close();

    if (!uuid) throw new Error('Session UUID not captured — Show Video button may not have fired.');
    console.log(`Session UUID: ${uuid}`);
    return uuid;
}

// ── Step 2: fetch tokens for all 20 cameras directly from Node ────────────────
async function fetchAllTokens(uuid) {
    const tokens = {};
    const headers = {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'User-Agent':   UA,
        'Referer':      DRIVENC,
        'Origin':       DRIVENC,
    };

    for (const cam of SOURCE_MAP) {
        try {
            const res  = await fetch(TOKEN_API, {
                method: 'POST',
                headers,
                body: JSON.stringify({ token: uuid, sourceId: cam.sourceId, systemSourceId: cam.division }),
            });
            const text = await res.text();
            const m    = text.match(/token=([a-f0-9]+)/);
            if (m) {
                tokens[cam.chan] = m[1];
                console.log(`✅ ${cam.chan} (${cam.sourceId}) → ${m[1].slice(0, 16)}...`);
            } else {
                console.warn(`⚠ ${cam.chan} (${cam.sourceId}) → HTTP ${res.status}: ${text}`);
            }
        } catch (e) {
            console.warn(`⚠ ${cam.chan} → ${e.message}`);
        }
    }

    return tokens;
}

// ── Step 3: write tokens into index.html ─────────────────────────────────────
async function updateIndexHTML(newTokens) {
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error('index.html not found');

    let html = fs.readFileSync(indexPath, 'utf8');
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(html)) throw new Error('Anchor comments not found in index.html');

    // Merge with existing so any un-refreshed tokens are preserved
    const existingMatch = html.match(/const tokenConfig = ({[\s\S]*?});/);
    let existing = {};
    if (existingMatch) { try { existing = JSON.parse(existingMatch[1]); } catch (_) {} }

    const merged = { ...existing, ...newTokens, updated: new Date().toISOString() };
    html = html.replace(regex,
        `$1\n        const tokenConfig = ${JSON.stringify(merged, null, 2)};\n        $2`);

    fs.writeFileSync(indexPath, html, 'utf8');
    const n = Object.keys(newTokens).length;
    console.log(`\n✅ index.html updated — ${n}/20 tokens refreshed.`);
    if (n < 20) console.warn(`⚠ ${20 - n} token(s) not refreshed — previous values kept.`);
}

async function main() {
    console.log('Step 1: Getting session UUID...');
    const uuid = await getSessionUUID();

    console.log('\nStep 2: Fetching tokens for all 20 cameras...');
    const tokens = await fetchAllTokens(uuid);

    if (Object.keys(tokens).length === 0) {
        throw new Error('No tokens fetched — the session UUID may have been rejected.');
    }

    console.log('\nStep 3: Updating index.html...');
    await updateIndexHTML(tokens);
}

main().catch(err => { console.error('⛔', err.message); process.exit(1); });
