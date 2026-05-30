const fs   = require('fs');
const path = require('path');

// Base target query structure
const BASE_URL = 'https://www.drivenc.gov/cctv?filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=I-26&order%5Bi%5D=1&order%5Bdir%5D=asc&length=10';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1200 });
    await page.setUserAgent(UA);

    let liveChannelsData = {};

    // Network Sniffer
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

    // We cycle through 4 full slice windows to guarantee absolutely no row exclusions
    const slices = [0, 10, 20, 30];

    for (const startOffset of slices) {
        const targetSliceUrl = `${BASE_URL}&start=${startOffset}`;
        console.log(`\nOpening camera database index segment: start=${startOffset}...`);
        
        try {
            await page.goto(targetSliceUrl, { waitUntil: 'networkidle2', timeout: 90000 });
            await new Promise(r => setTimeout(r, 5000));
            await page.keyboard.press('Escape'); // Dismiss random banners

            // Process row collection inside browser layer
            await page.evaluate(async () => {
                const allElements = [...document.querySelectorAll('table tbody tr *')];
                const videoButtons = allElements.filter(el => el.textContent?.trim().toLowerCase() === 'show video');
                
                console.log(`Found ${videoButtons.length} active video row elements on this segment layout.`);

                for (let i = 0; i < videoButtons.length; i++) {
                    const btn = videoButtons[i];
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                    // Structured timing to prevent pipe choking
                    await new Promise(r => setTimeout(r, 2500));
                }
            });

            // Brief settlement window per segment
            await new Promise(r => setTimeout(r, 2000));

        } catch (sliceErr) {
            console.log(`Note: Segment window start=${startOffset} processing warning:`, sliceErr.message);
        }
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
    let synchronizedChannels = new Set();

    console.log('\nProcessing Captured Stream Values and merging to index.html...');
    for (const [channelName, freshData] of Object.entries(liveChannelsData)) {
        const tokenRegex = new RegExp(`("${channelName}"\\s*:\\s*")[^"]*(")`, 'gi');
        if (tokenRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(tokenRegex, `$1${freshData.token}$2`);
            console.log(`✅ Synced Token for: ${channelName} ➔ ${freshData.token || '[None]'}`);
            dynamicUpdateCounter++;
            synchronizedChannels.add(channelName);
        }

        const hostRegex = new RegExp(`({\\s*host\\s*:\\s*")[^"]*("\\s*,\\s*chan\\s*:\\s*"${channelName}")`, 'gi');
        if (hostRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(hostRegex, `$1${freshData.host}$2`);
        }
    }

    // Diagnostic Block
    console.log('\n--- DIAGNOSTIC ANALYSIS ---');
    const allExpectedChannels = [...htmlContent.matchAll(/"(chan-[0-9a-zA-Z_]+)"\s*:/gi)].map(m => m[1].toLowerCase());
    const uniqueExpectedChannels = [...new Set(allExpectedChannels)];
    const missingChannels = uniqueExpectedChannels.filter(chan => !synchronizedChannels.has(chan));
    
    if (missingChannels.length > 0) {
        console.log(`⚠️ The following ${missingChannels.length} channels exist in your index.html but were NOT captured during this session:`);
        missingChannels.forEach(chan => console.log(`   - ${chan}`));
    } else {
        console.log('✨ All camera IDs found inside index.html were successfully updated!');
    }
    console.log('---------------------------\n');

    const timestampStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    htmlContent = htmlContent.replace(/"updated"\s*:\s*"[^"]*"/g, `"updated": "${timestampStr}"`);

    if (dynamicUpdateCounter > 0) {
        fs.writeFileSync(indexPath, htmlContent, 'utf8');
        console.log(`🎉 Success! Synchronized ${dynamicUpdateCounter} target camera tokens inside index.html variables.`);
    } else {
        console.log('❌ Synchronization loop concluded but no target markers were written.');
    }
}

run().catch(err => { console.error('⛔ Critical script exception:', err); process.exit(1); });