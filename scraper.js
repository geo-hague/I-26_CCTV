const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function getFreshToken() {
    console.log("Launching headless browser to fetch fresh token...");
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
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
        await page.goto('https://drivenc.gov/', { waitUntil: 'networkidle2', timeout: 60000 });
        // Give map asset calls enough breathing room to complete
        await new Promise(r => setTimeout(r, 15000));
    } catch (err) {
        console.error("Navigation encountered a timeout error, evaluating captured requests...", err);
    }

    await browser.close();
    return foundToken;
}

async function updateIndexHTML() {
    const token = await getFreshToken();
    if (!token) {
        console.error("Failed to find an active token query parameters. Aborting write operation.");
        process.exit(1);
    }

    const indexPath = path.join(__dirname, 'index.html');
    let htmlContent = fs.readFileSync(indexPath, 'utf8');

    const configObject = {
        token: token,
        updated: new Date().toISOString()
    };

    // Replace the configuration chunk safely via regex target limits
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    const replacement = `$1\n        const tokenConfig = ${JSON.stringify(configObject, null, 2)};\n        $2`;

    htmlContent = htmlContent.replace(regex, replacement);
    fs.writeFileSync(indexPath, htmlContent, 'utf8');
    console.log("index.html configuration updated successfully with fresh tokens!");
}

updateIndexHTML();