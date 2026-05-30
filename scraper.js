const fs   = require('fs');
const path = require('path');

const DRIVENC = 'https://www.drivenc.gov';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Your defined target configurations
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

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    // Track active data structures mapped by sourceId
    let liveCamsData = {};

    // 1. Monitor network background streams
    page.on('response', async (response) => {
        const url = response.url();
        try {
            if (url.includes('GetUserCameras')) {
                const text = await response.text();
                const json = JSON.parse(text);
                
                if (json && json.data && Array.isArray(json.data)) {
                    console.log(`[Network Intercept] Processing ${json.data.length} live map stream configurations.`);
                    
                    json.data.forEach(cam => {
                        if (cam.sourceId && cam.images?.[0]?.videoUrl) {
                            const rawUrl = cam.images[0].videoUrl; // Ex: "https://cfase03.services.ncdot.gov:8887/chan-5440_l/index.m3u8"
                            
                            try {
                                const parsedUrl = new URL(rawUrl);
                                const hostPrefix = parsedUrl.hostname.split('.')[0]; // Extracts "cfase03"
                                const tokenVal = parsedUrl.searchParams.get('token') || '';

                                liveCamsData[cam.sourceId] = {
                                    host: hostPrefix,
                                    token: tokenVal,
                                    fullUrl: rawUrl
                                };
                            } catch (urlErr) {
                                // Fallback parsing for partial stream paths if encountered
                                const hostMatch = rawUrl.match(/https?:\/\/([^.]+)\./i);
                                const tokenMatch = rawUrl.match(/[?&]token=([^&]+)/i);
                                if (hostMatch) {
                                    liveCamsData[cam.sourceId] = {
                                        host: hostMatch[1],
                                        token: tokenMatch ? tokenMatch[1] : '',
                                        fullUrl: rawUrl
                                    };
                                }
                            }
                        }
                    });
                }
            }
        } catch (e) { /* Catch frame allocation errors */ }
    });

    console.log('Opening target dashboard...');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 4000));

    // Clear system modals
    await page.keyboard.press('Escape');

    console.log('Activating Layer Layout Modules...');
    await page.evaluate(() => {
        const elements = [...document.querySelectorAll('label, span, div, input')];
        const targetLayer = elements.find(e => e.textContent?.trim() === 'Cameras');
        if (targetLayer) targetLayer.click();
    });

    console.log('Capturing streaming routing maps...');
    await new Promise(r => setTimeout(r, 8000));
    await browser.close();

    // 2. Modifying index.html Workspace Contents
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.error('❌ Missing target index.html layout asset file.');
        process.exit(1);
    }

    let htmlContent = fs.readFileSync(indexPath, 'utf8');
    let dynamicUpdateCounter = 0;

    SOURCE_MAP.forEach(camera => {
        const freshData = liveCamsData[camera.sourceId];
        
        if (freshData) {
            // Fix #1: Dynamically update the specific token property value inside tokenConfig object
            const tokenRegex = new RegExp(`("${camera.chan}"\\s*:\\s*")[^"]*(")`, 'g');
            if (tokenRegex.test(htmlContent)) {
                htmlContent = htmlContent.replace(tokenRegex, `$1${freshData.token}$2`);
                dynamicUpdateCounter++;
            }

            // Fix #2: Update matching host values inside cameraChannels setup array block
            const hostRegex = new RegExp(`({\\s*host\\s*:\\s*")[^"]*("\\s*,\\s*chan\\s*:\\s*"${camera.chan}")`, 'g');
            if (hostRegex.test(htmlContent)) {
                htmlContent = htmlContent.replace(hostRegex, `$1${freshData.host}$2`);
            }
        }
    });

    // Fix #3: Stamp dynamic status updates tracking parameter inside text document block
    const timestampStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    htmlContent = htmlContent.replace(/"updated"\s*:\s*"[^"]*"/g, `"updated": "${timestampStr}"`);

    // 3. Save updates
    if (dynamicUpdateCounter > 0) {
        fs.writeFileSync(indexPath, htmlContent, 'utf8');
        console.log(`\n🎉 Success! Synchronized ${dynamicUpdateCounter} target camera tokens inside index.html configuration tables.`);
    } else {
        console.log('\n❌ Failed to sync: No parameters matched. Ensure the app maps components using correct sourceId identifiers.');
    }
}

run().catch(err => { console.error('⛔ Critical script exception:', err); process.exit(1); });