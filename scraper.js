const fs   = require('fs');
const path = require('path');

const TARGET_URL = 'https://www.drivenc.gov/cctv?start=0&length=50&filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=I-26&order%5Bi%5D=1&order%5Bdir%5D=asc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Guide to Gecko) Chrome/124.0.0.0 Safari/537.36';

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 3000 });
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

    console.log('Opening camera database list (length=50)...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 6000)); 
    await page.keyboard.press('Escape'); 

    console.log('Clicking every video row sequentially on the single view page...');
    await page.evaluate(async () => {
        const allElements = [...document.querySelectorAll('table tbody tr *')];
        const videoButtons = allElements.filter(el => el.textContent?.trim().toLowerCase() === 'show video');
        
        console.log(`Found ${videoButtons.length} clickable video rows on the screen.`);

        for (let i = 0; i < videoButtons.length; i++) {
            const btn = videoButtons[i];
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            await new Promise(r => setTimeout(r, 3000));
        }
    });

    await new Promise(r => setTimeout(r, 4000));
    await browser.close();

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

    // DIAGNOSTIC CODE: Find what is missing in index.html
    console.log('\n--- DIAGNOSTIC ANALYSIS ---');
    const allExpectedChannels = [...htmlContent.matchAll(/"(chan-[0-9a-zA-Z_]+)"\s*:/gi)].map(m => m[1].toLowerCase());
    const uniqueExpectedChannels = [...new Set(allExpectedChannels)];
    
    const missingChannels = uniqueExpectedChannels.filter(chan => !synchronizedChannels.has(chan));
    
    if (missingChannels.length > 0) {
        console.log(`⚠️ The following ${missingChannels.length} channels exist in your index.html but were NEVER captured on DriveNC's I-26 page:`);
        missingChannels.forEach(chan => console.log(`   - ${chan}`));
        console.log('\nPossible reasons: These cameras might belong to a different highway filter, use a different channel prefix style, or are currently offline/missing from the live database table.');
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