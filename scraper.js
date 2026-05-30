const fs   = require('fs');
const path = require('path');

const BASE_LIST_URL = 'https://www.drivenc.gov/cctv?filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=I-26&order%5Bi%5D=1&order%5Bdir%5D=asc';
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

    // Check pages 1, 2, and 3 cleanly
    const pageOffsets = [0, 10, 20];
    let lastPageFirstRowText = "";

    for (const offset of pageOffsets) {
        const targetUrl = `${BASE_LIST_URL}&start=${offset}&length=10`;
        console.log(`\nOpening camera database table list index slice: start=${offset}...`);
        
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
        
        // Anti-race condition logic: Wait for table contents to change from the previous page iteration
        try {
            await page.waitForFunction(
                (previousText) => {
                    const firstRow = document.querySelector('table tbody tr');
                    if (!firstRow) return false;
                    const text = firstRow.textContent || '';
                    return text !== previousText && !text.includes('Loading');
                },
                { timeout: 10000 },
                lastPageFirstRowText
            );
        } catch (timeoutErr) {
            console.log('⏱️ Note: Table contents didn\'t change or loaded quickly.');
        }

        // Cache the current first row signature text before interactions clear it
        lastPageFirstRowText = await page.evaluate(() => {
            const row = document.querySelector('table tbody tr');
            return row ? (row.textContent || '') : '';
        });

        // Dismiss modal overlays if any appeared
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 1000));

        // Click every single available video button on this freshly loaded page view
        console.log(`Clicking every "Show Video" element on this table view page...`);
        try {
            await page.evaluate(async () => {
                const elements = [...document.querySelectorAll('table tbody tr button, table tbody tr a, table tbody tr span')];
                const videoButtons = elements.filter(el => el.textContent?.trim().toLowerCase() === 'show video');
                
                console.log(`Found ${videoButtons.length} total video buttons on this slice page.`);
                
                for (const btn of videoButtons) {
                    btn.click();
                    await new Promise(r => setTimeout(r, 1800)); // Slightly increased delay to guarantee network capture
                }
            });
            
            await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
            console.log(`Interaction block handling warning at slice index ${offset}:`, err.message);
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