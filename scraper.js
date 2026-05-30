const fs   = require('fs');
const path = require('path');

// Using your confirmed length=50 URL that displays all your cameras on one page
const TARGET_URL = 'https://www.drivenc.gov/cctv?start=0&length=50&filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=I-26&order%5Bi%5D=1&order%5Bdir%5D=asc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 3000 }); // Tall viewport
    await page.setUserAgent(UA);

    let liveChannelsData = {};

    // Intercept stream tokens over the network pipe
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('index.m3u8') || url.includes('manifest.m3u8')) {
            const chanMatch = url.match(/(chan-[0-9a-zA-Z_]+)/i);
            if (chanMatch) {
                const detectedChan = chanMatch[1].toLowerCase();
                try {
                    const parsedUrl = new URL(url);
                    const hostPrefix = parsedUrl.hostname.split('.')[0];
                    const tokenVal = parsedUrl.searchParams.get('token') || '';

                    liveChannelsData[detectedChan] = {
                        host: hostPrefix,
                        token: tokenVal
                    };
                    console.log(`[Captured] ${detectedChan} via network pipeline connection.`);
                } catch (e) {}
            }
        }
    });

    console.log('Opening camera database list (length=50)...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 6000)); 
    await page.keyboard.press('Escape'); 

    console.log('Processing camera rows systematically...');
    try {
        // Get the total number of rows first
        const rowCount = await page.evaluate(() => {
            return document.querySelectorAll('table tbody tr').length;
        });
        console.log(`Found ${rowCount} total data rows on the screen.`);

        // Loop through rows one by one from the main thread so we can handle open/close pacing securely
        for (let i = 0; i < rowCount; i++) {
            await page.evaluate(async (rowIndex) => {
                const rows = document.querySelectorAll('table tbody tr');
                const currentRow = rows[rowIndex];
                if (!currentRow) return;

                const btn = currentRow.querySelector('button, a, span');
                if (btn && btn.textContent?.trim().toLowerCase() === 'show video') {
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                }
            }, i);

            // Wait 3.5 seconds for the stream request to safely fire and register
            await new Promise(r => setTimeout(r, 3500));

            // CRITICAL STEP: Close the active video player popup/modal to clear network bandwidth before clicking the next camera
            await page.evaluate(() => {
                // Look for common close buttons ("Close", "X", or modal dismiss attributes)
                const closeButtons = [...document.querySelectorAll('button, a, span')];
                const closeBtn = closeButtons.find(el => 
                    el.textContent?.trim().toLowerCase() === 'close' || 
                    el.textContent?.trim() === '×' ||
                    el.classList.contains('close') ||
                    el.getAttribute('data-dismiss') === 'modal'
                );
                if (closeBtn) {
                    closeBtn.click();
                }
            });

            // Brief pause after closing to let the DOM settle
            await new Promise(r => setTimeout(r, 500));
        }
        
    } catch (err) {
        console.log(`Warning during comprehensive click sequence:`, err.message);
    }

    await browser.close();

    // 2. Modifying index.html Contents
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.error('❌ Missing target index.html asset file.');
        process.exit(1);
    }

    let htmlContent = fs.readFileSync(indexPath, 'utf8');
    let dynamicUpdateCounter = 0;

    console.log('\nProcessing Captured Stream Values and merging to index.html...');
    for (const [channelName, freshData] of Object.entries(liveChannelsData)) {
        const tokenRegex = new RegExp(`("${channelName}"\\s*:\\s*")[^"]*(")`, 'gi');
        if (tokenRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(tokenRegex, `$1${freshData.token}$2`);
            console.log(`✅ Synced Token for: ${channelName} ➔ ${freshData.token || '[None]'}`);
            dynamicUpdateCounter++;
        }

        const hostRegex = new RegExp(`({\\s*host\\s*:\\s*")[^"]*("\\s*,\\s*chan\\s*:\\s*"${channelName}")`, 'gi');
        if (hostRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(hostRegex, `$1${freshData.host}$2`);
        }
    }

    const timestampStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    htmlContent = htmlContent.replace(/"updated"\s*:\s*"[^"]*"/g, `"updated": "${timestampStr}"`);

    if (dynamicUpdateCounter > 0) {
        fs.writeFileSync(indexPath, htmlContent, 'utf8');
        console.log(`\n🎉 Success! Synchronized ${dynamicUpdateCounter} target camera tokens inside index.html variables.`);
    } else {
        console.log('\n❌ Synchronization loop concluded but no target markers were written.');
    }
}

run().catch(err => { console.error('⛔ Critical script exception:', err); process.exit(1); });