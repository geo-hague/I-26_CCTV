const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function getFreshToken() {
    console.log("Launching headless browser to fetch fresh token...");
    const browser = await puppeteer.launch({
        headless: true,  // 'new' is deprecated in Puppeteer v22+; true uses the new headless mode
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Expose extra headers a real browser would send
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
    });

    let foundToken = null;

    // Intercept ALL requests so we catch the token the moment any stream fires
    page.on('request', request => {
        const url = request.url();
        if (url.includes('index.m3u8?token=') && !foundToken) {
            const match = url.match(/token=([a-f0-9]+)/);
            if (match && match[1]) {
                foundToken = match[1];
                console.log(`✅ Token captured: ${foundToken}`);
            }
        }
    });

    try {
        // The interactive traffic-camera map on DriveNC
        const TARGET = 'https://drivenc.gov/';
        console.log(`Navigating to ${TARGET} ...`);
        await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 90000 });
        console.log("Page loaded. Waiting for map to initialise...");

        // Let map tiles and initial JS fully settle
        await new Promise(r => setTimeout(r, 8000));

        // -----------------------------------------------------------------------
        // Strategy 1: click the first visible camera icon on the map.
        // DriveNC uses Leaflet/ArcGIS; camera markers usually carry an <img> or
        // a div with a class that includes "camera" or "cctv".
        // We try several common selectors in order.
        // -----------------------------------------------------------------------
        const cameraSelectors = [
            'img[src*="camera"]',
            'img[src*="cctv"]',
            'img[src*="Camera"]',
            'div[class*="camera"]',
            'div[class*="cctv"]',
            '.leaflet-marker-icon',   // any Leaflet marker — broad fallback
        ];

        let clicked = false;
        for (const sel of cameraSelectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    console.log(`Clicking marker with selector: ${sel}`);
                    await el.click();
                    clicked = true;
                    break;
                }
            } catch (_) { /* selector not found, try next */ }
        }

        if (!clicked) {
            console.warn("⚠️  No camera marker found via selectors. Trying coordinate click on map centre...");
            // Fall back: click the geographic centre of I-26 on the viewport
            const viewport = page.viewport() || { width: 1280, height: 800 };
            await page.mouse.click(viewport.width / 2, viewport.height / 2);
        }

        // -----------------------------------------------------------------------
        // Strategy 2: if still no token, try clicking any <a> or button whose
        // text / href hints at camera or video.
        // -----------------------------------------------------------------------
        if (!foundToken) {
            console.log("No token yet — scanning for camera links in page content...");
            await page.evaluate(() => {
                const links = [...document.querySelectorAll('a[href*="camera"], a[href*="cctv"], a[href*="video"]')];
                if (links.length) links[0].click();
            });
            await new Promise(r => setTimeout(r, 5000));
        }

        // -----------------------------------------------------------------------
        // Strategy 3: wait generously for a stream request to appear in response
        // to whichever click landed.
        // -----------------------------------------------------------------------
        if (!foundToken) {
            console.log("Waiting up to 30 s for a stream token to appear...");
            const deadline = Date.now() + 30000;
            while (!foundToken && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

    } catch (err) {
        console.error("Navigation or interaction error:", err.message);
    }

    await browser.close();
    return foundToken;
}

async function updateIndexHTML() {
    const token = await getFreshToken();

    if (!token) {
        console.error("⛔ CRITICAL ERROR: No token found after all strategies. Aborting.");
        console.error("   Tip: run locally with headless:false to watch what the page is doing.");
        process.exit(1);
    }

    const indexPath = path.join(__dirname, 'index.html');

    if (!fs.existsSync(indexPath)) {
        console.error(`⛔ CRITICAL ERROR: index.html missing at ${indexPath}`);
        process.exit(1);
    }

    let htmlContent = fs.readFileSync(indexPath, 'utf8');

    const configObject = {
        token: token,
        updated: new Date().toISOString()
    };

    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(htmlContent)) {
        console.error("⛔ CRITICAL ERROR: Anchor comments not found in index.html.");
        process.exit(1);
    }

    const replacement = `$1\n        const tokenConfig = ${JSON.stringify(configObject, null, 2)};\n        $2`;
    htmlContent = htmlContent.replace(regex, replacement);
    fs.writeFileSync(indexPath, htmlContent, 'utf8');
    console.log("✅ SUCCESS: index.html updated with fresh token.");
}

updateIndexHTML();
