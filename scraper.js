const fs   = require('fs');
const path = require('path');

const TARGET_URL = 'https://www.drivenc.gov/cctv?start=0&length=50&filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=I-26&order%5Bi%5D=1&order%5Bdir%5D=asc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 4000 }); 
    await page.setUserAgent(UA);

    let liveChannelsData = {};

    // Network sniffer
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('index.m3u8') || url.includes('manifest.m3u8') || url.includes('stream')) {
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
                    console.log(`[Captured] ${detectedChan}`);
                } catch (e) {}
            }
        }
    });

    console.log('Opening camera database list (length=50)...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 6000)); 
    await page.keyboard.press('Escape'); 

    console.log('Processing video rows with strict modal closure tracking...');
    
    const totalRows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
    console.log(`Processing ${totalRows} data rows sequentially.`);

    for (let i = 0; i < totalRows; i++) {
        const clicked = await page.evaluate(async (rowIndex) => {
            const rows = document.querySelectorAll('table tbody tr');
            const targetRow = rows[rowIndex];
            if (!targetRow) return false;

            targetRow.scrollIntoView({ block: 'center', behavior: 'instant' });
            
            const cellElements = [...targetRow.querySelectorAll('button, a, span, td')];
            const actionBtn = cellElements.find(el => el.textContent?.trim().toLowerCase() === 'show video');
            
            if (actionBtn) {
                actionBtn.click();
                return true;
            }
            return false;
        }, i);

        if (clicked) {
            // Give the stream token ample time to manifest over the pipe
            await new Promise(r => setTimeout(r, 3500));

            // CRITICAL STEP: Close the player immediately to release network pipelines
            await page.evaluate(() => {
                const closeElements = [...document.querySelectorAll('button, a, span, .close, [data-dismiss="modal"]')];
                const closeBtn = closeElements.find(el => {
                    const txt = el.textContent?.trim() || '';
                    return txt.toLowerCase() === 'close' || txt === '×' || el.classList.contains('close');
                });
                if (closeBtn) {
                    closeBtn.click();
                }
            });

            // Brief settlement window before the next row selection click
            await new Promise(r => setTimeout(r, 500));
        }
    }

    await new Promise(r => setTimeout(r, 4000));
    await browser.close();

    // Merge captured tokens to index.html variables
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.error('❌ Missing target index.html layout asset file.');
        process.exit(1);
    }

    let htmlContent = fs.readFileSync(indexPath, 'utf8');
    let dynamicUpdateCounter = 0;

    console.log('\nProcessing Captured Stream Values and merging to index.html...');
    for (const [channelName, freshData] of Object.entries(liveChannelsData)) {
        const numMatch = channelName.match(/\d+/);
        if (!numMatch) continue;
        const numId = numMatch[0];

        const looserTokenRegex = new RegExp(`(['"]chan-${numId}_[lL]['"]\\s*:\\s*['"])[^'"]*(['"])`, 'g');
        const looserHostRegex = new RegExp(`({\\s*host\\s*:\\s*['"])[^'"]*(['"]\\s*,\\s*chan\\s*:\\s*['"]chan-${numId}_[lL]['"])`, 'g');

        if (looserTokenRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(looserTokenRegex, `$1${freshData.token}$2`);
            console.log(`✅ Synced Token for Camera Number: ${numId} ➔ ${freshData.token}`);
            dynamicUpdateCounter++;
        }

        if (looserHostRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(looserHostRegex, `$1${freshData.host}$2`);
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