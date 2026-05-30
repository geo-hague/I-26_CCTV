const fs   = require('fs');
const path = require('path');

const DRIVENC = 'https://www.drivenc.gov';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Your defined targets
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

    // Track active live stream paths captured: { sourceId: "https://...videoUrl..." }
    let liveCameraUrls = {};

    // 1. Intercept network pipeline background data
    page.on('response', async (response) => {
        const url = response.url();
        try {
            if (url.includes('GetUserCameras')) {
                const text = await response.text();
                const json = JSON.parse(text);
                
                if (json && json.data && Array.isArray(json.data)) {
                    console.log(`[Parser] Successfully intercepted ${json.data.length} live platform cameras.`);
                    
                    json.data.forEach(cam => {
                        if (cam.sourceId && cam.images && cam.images[0] && cam.images[0].videoUrl) {
                            // Map via the real string ID
                            liveCameraUrls[cam.sourceId] = cam.images[0].videoUrl;
                        }
                    });
                }
            }
        } catch (e) {
            console.error('Network parsing warning:', e.message);
        }
    });

    console.log('Loading drivenc.gov...');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 4000));

    // Clear UI overlays
    await page.keyboard.press('Escape');

    console.log('Monitoring dynamic data transmissions for live URLs...');
    await new Promise(r => setTimeout(r, 6000)); // Wait for GetUserCameras background call to wrap up
    await browser.close();

    // 2. Modifying index.html File Layer
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.error('❌ index.html not found in workspace root.');
        process.exit(1);
    }

    let htmlContent = fs.readFileSync(indexPath, 'utf8');
    let dynamicUpdateCounter = 0;

    // Cross-reference live API URLs with your SOURCE_MAP definitions
    SOURCE_MAP.forEach(camera => {
        const freshUrl = liveCameraUrls[camera.sourceId];
        
        if (freshUrl) {
            // Find existing video source tags containing your specific channel name
            // matches patterns like: src="https://.../chan-5373_l/..." or src="OLD_URL"
            const escapedChan = camera.chan.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const urlRegex = new RegExp(`src=["']https?:\/\/[^"']*${escapedChan}[^"']*["']`, 'gi');

            if (urlRegex.test(htmlContent)) {
                htmlContent = htmlContent.replace(urlRegex, `src="${freshUrl}"`);
                console.log(`✅ Updated HTML Link for ${camera.chan} → ${freshUrl}`);
                dynamicUpdateCounter++;
            } else {
                console.log(`⚠️ Match structural fallback: Found live data for ${camera.chan} but couldn't find matching pattern inside index.html`);
            }
        }
    });

    // 3. Save updates
    if (dynamicUpdateCounter > 0) {
        fs.writeFileSync(indexPath, htmlContent, 'utf8');
        console.log(`\n🎉 Success! Synchronized ${dynamicUpdateCounter} video stream links directly in index.html.`);
    } else {
        console.log('\n⚠️ Process finished but no active matches were updated. Ensure your index.html source matches structural elements (e.g., includes the chan string code like chan-5373_l).');
    }
}

run().catch(err => { console.error('⛔ Critical script crash:', err); process.exit(1); });