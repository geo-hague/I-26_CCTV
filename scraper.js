const fs   = require('fs');
const path = require('path');

// Open the initial page directly, then we will use UI buttons to turn pages
const TARGET_URL = 'https://www.drivenc.gov/cctv?start=0&length=10&filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=I-26&order%5Bi%5D=1&order%5Bdir%5D=asc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(UA);

    let liveChannelsData = {};

    // 1. Intercept stream metadata from the video requests
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

    console.log('Opening camera database table list directly...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 5000));
    await page.keyboard.press('Escape'); // Clear overlays

    // We will loop through 3 pages total using UI pagination buttons
    const totalPagesToProcess = 3;

    for (let pageNum = 1; pageNum <= totalPagesToProcess; pageNum++) {
        console.log(`\nProcessing Table Page #${pageNum}...`);

        // Click every single available video button on the current view
        console.log(`Clicking every "Show Video" element on this page...`);
        try {
            await page.evaluate(async () => {
                const elements = [...document.querySelectorAll('table tbody tr button, table tbody tr a, table tbody tr span')];
                const videoButtons = elements.filter(el => el.textContent?.trim().toLowerCase() === 'show video');
                
                console.log(`Found ${videoButtons.length} total active video buttons on this view.`);
                
                for (const btn of videoButtons) {
                    btn.click();
                    await new Promise(r => setTimeout(r, 1800)); // Clear request pipeline safely
                }
            });
            await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
            console.log(`Warning during row clicks on page ${pageNum}:`, err.message);
        }

        // If we still have pages left to process, find and click the native "Next" button
        if (pageNum < totalPagesToProcess) {
            console.log('Advancing to next page via native UI Pagination Controls...');
            
            // Capture the text signature of the first row to detect when the page contents swap
            const currentFirstRowText = await page.evaluate(() => {
                const row = document.querySelector('table tbody tr');
                return row ? (row.textContent || '') : '';
            });

            const nextClicked = await page.evaluate(() => {
                // Find pagination links (Commonly "Next", "next", or buttons with specific pagination attributes)
                const buttons = [...document.querySelectorAll('button, a, li, span')];
                const nextBtn = buttons.find(el => 
                    el.textContent?.trim().toLowerCase() === 'next' || 
                    el.getAttribute('aria-label')?.toLowerCase().includes('next')
                );

                if (nextBtn) {
                    nextBtn.click();
                    return true;
                }
                return false;
            });

            if (!nextClicked) {
                console.log('⚠️ Could not find a "Next" button. Breaking loop early.');
                break;
            }

            // Wait until the first row changes, ensuring the new dataset has fully rendered in place
            try {
                await page.waitForFunction(
                    (oldText) => {
                        const row = document.querySelector('table tbody tr');
                        if (!row) return false;
                        const text = row.textContent || '';
                        return text !== oldText && !text.includes('Loading');
                    },
                    { timeout: 8000 },
                    currentFirstRowText
                );
                console.log('Data switch detected successfully.');
                await new Promise(r => setTimeout(r, 2000));
            } catch (timeoutErr) {
                console.log('⏱️ Note: Table swap wait timed out. Continuing...');
            }
        }
    }

    await browser.close();

    // 2. Modifying index.html Workspace Contents
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.error('❌ Missing target index.html layout asset file.');
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

    // 3. Save updates
    if (dynamicUpdateCounter > 0) {
        fs.writeFileSync(indexPath, htmlContent, 'utf8');
        console.log(`\n🎉 Success! Synchronized ${dynamicUpdateCounter} target camera tokens inside index.html variables.`);
    } else {
        console.log('\n❌ Synchronization loop concluded but no target markers were written.');
    }
}

run().catch(err => { console.error('⛔ Critical script exception:', err); process.exit(1); });