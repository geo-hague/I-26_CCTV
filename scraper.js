const fs   = require('fs');
const path = require('path');

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
    await page.keyboard.press('Escape');

    const totalPagesToProcess = 3;

    for (let pageNum = 1; pageNum <= totalPagesToProcess; pageNum++) {
        console.log(`\nProcessing Table Page #${pageNum}...`);

        // Extra verification step: Hard sleep to give any slow DOM animations a chance to rest
        await new Promise(r => setTimeout(r, 2000));

        console.log(`Clicking every "Show Video" element on this page...`);
        try {
            await page.evaluate(async () => {
                const elements = [...document.querySelectorAll('table tbody tr button, table tbody tr a, table tbody tr span')];
                const videoButtons = elements.filter(el => el.textContent?.trim().toLowerCase() === 'show video');
                
                console.log(`Found ${videoButtons.length} total active video buttons on this view.`);
                
                for (const btn of videoButtons) {
                    btn.click();
                    // Keep interaction stable to avoid choking the response pipeline
                    await new Promise(r => setTimeout(r, 2200)); 
                }
            });
            await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
            console.log(`Warning during row clicks on page ${pageNum}:`, err.message);
        }

        if (pageNum < totalPagesToProcess) {
            console.log('Advancing to next page via native UI Pagination Controls...');
            
            // Track the text signature of the current table info label (e.g. "Showing 1 to 10 of...")
            const currentTableInfoText = await page.evaluate(() => {
                const infoEl = document.querySelector('.dataTables_info, [id*="info" i], .pagination-info');
                return infoEl ? (infoEl.textContent || '') : '';
            });

            const nextClicked = await page.evaluate(() => {
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
                console.log('走 ⚠️ Could not find a "Next" button. Breaking loop early.');
                break;
            }

            // EXPLICIT SYNC GATING: Wait specifically until the page info marker text flips to the next block
            try {
                await page.waitForFunction(
                    (oldInfoString) => {
                        const currentInfoEl = document.querySelector('.dataTables_info, [id*="info" i], .pagination-info');
                        if (!currentInfoEl) return true; // Fallback if element vanishes
                        const text = currentInfoEl.textContent || '';
                        return text !== oldInfoString && !text.includes('Loading');
                    },
                    { timeout: 10000 },
                    currentTableInfoText
                );
                console.log('Pagination index shift detected. Waiting for row states to swap completely...');
                
                // Allow a generous structural pause for rows to tear down and rebuild
                await new Promise(r => setTimeout(r, 4000)); 
            } catch (timeoutErr) {
                console.log('⏱️ Note: Table swap wait timed out. Forcing structural rest interval...');
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    await browser.close();

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

    if (dynamicUpdateCounter > 0) {
        fs.writeFileSync(indexPath, htmlContent, 'utf8');
        console.log(`\n🎉 Success! Synchronized ${dynamicUpdateCounter} target camera tokens inside index.html variables.`);
    } else {
        console.log('\n❌ Synchronization loop concluded but no target markers were written.');
    }
}

run().catch(err => { console.error('⛔ Critical script exception:', err); process.exit(1); });