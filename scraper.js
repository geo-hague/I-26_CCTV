const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function getFreshToken() {
    console.log("Launching headless browser to fetch fresh token...");
    const browser = await puppeteer.launch({
        // 'new' headless mode mimics standard Chrome much better to evade bot detection
        headless: 'new', 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled' // Hides automation signatures
        ]
    });
    
    const page = await browser.newPage();
    
    // Set a realistic user agent so security systems don't immediately drop the request
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let foundToken = null;

    // Monitor background network requests
    page.on('request', request => {
        const url = request.url();
        if (url.includes('index.m3u8?token=') && !foundToken) {
            const match = url.match(/token=([a-f0-9]+)/);
            if (match && match[1]) {
                foundToken = match[1];
                console.log(`Token captured successfully: ${foundToken}`);
            }
        }
    });

    try {
        // Direct link to the map camera context
        console.log("Navigating to target portal...");
        await page.goto('https://drivenc.gov/', { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Give map asset calls enough breathing room to complete
        console.log("Waiting for stream tokens to populate...");
        await new Promise(r => setTimeout(r, 15000));
    } catch (err) {
        console.error("Navigation encountered an error or timeout, checking captured requests...", err.message);
    }

    await browser.close();
    return foundToken;
}

async function updateIndexHTML() {
    const token = await getFreshToken();
    if (!token) {
        console.error("⛔ CRITICAL ERROR: Failed to find an active token query parameter. Aborting write operation.");
        process.exit(1);
    }

    const indexPath = path.join(__dirname, 'index.html');
    
    if (!fs.existsSync(indexPath)) {
        console.error(`⛔ CRITICAL ERROR: Target file missing at ${indexPath}`);
        process.exit(1);
    }

    let htmlContent = fs.readFileSync(indexPath, 'utf8');

    const configObject = {
        token: token,
        updated: new Date().toISOString()
    };

    // Verify regex targets exist before substituting
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(htmlContent)) {
        console.error("⛔ CRITICAL ERROR: The anchor comments '// --- START TOKENS ---' or '// --- END TOKENS ---' were not found in your index.html file.");
        process.exit(1);
    }

    const replacement = `$1\n        const tokenConfig = ${JSON.stringify(configObject, null, 2)};\n        $2`;

    htmlContent = htmlContent.replace(regex, replacement);
    fs.writeFileSync(indexPath, htmlContent, 'utf8');
    console.log("✅ SUCCESS: index.html configuration updated successfully with fresh tokens!");
}

updateIndexHTML();