const fs   = require('fs');
const path = require('path');

const TOKEN_API = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const DRIVENC   = 'https://www.drivenc.gov';
const UA        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

    console.log('Loading drivenc.gov...');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 4000));

    // Dismiss overlay modal
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Enable cameras layer explicitly to trigger data parsing structures
    console.log('Activating Cameras Layer...');
    await page.evaluate(() => {
        const all = [...document.querySelectorAll('label, span, div, input')];
        const el = all.find(e => e.textContent?.trim() === 'Cameras');
        if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 5000));

    // Target the newly discovered window structure
    console.log('Extracting camera configuration tokens via window context...');
    const extractedData = await page.evaluate(() => {
        // Fallback checks for the explicit configurations found inside myCameraTooltip
        return {
            myCameras: window.MyCameras || null,
            mapComp: window.MapComp ? Object.keys(window.MapComp) : null
        };
    });

    console.log('-------------------------------------------');
    console.log('Extracted window.MyCameras:', JSON.stringify(extractedData.myCameras, null, 2));
    console.log('-------------------------------------------');

    // If data is collected, process and match against your SOURCE_MAP
    if (extractedData.myCameras) {
        const tokenMapping = {};
        
        // Loop through the source engine payload structure discovered
        extractedData.myCameras.forEach(group => {
            if (group.cameras && Array.isArray(group.cameras)) {
                group.cameras.forEach(cam => {
                    if (cam.cameraSiteId) {
                        tokenMapping[cam.cameraSiteId] = group.id || cam.token;
                    }
                });
            }
        });

        console.log('Processed token mapping table matches:');
        console.dir(tokenMapping);
        
        // Write out your fresh payload configuration update tracking file
        fs.writeFileSync('tokens.json', JSON.stringify(tokenMapping, null, 2));
    } else {
        console.log('⚠️ window.MyCameras was empty. Forcing full DOM extraction profile.');
    }

    await browser.close();
}

run().catch(err => { console.error('⛔ Error running scraper:', err.message); process.exit(1); });