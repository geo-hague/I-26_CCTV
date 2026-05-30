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
    await page.setViewport({ width: 1440, height: 3000 }); 
    await page.setUserAgent(UA);

    let liveChannelsData = {};

    // Broad Network Sniffer: Catches all video playlist formats (.m3u8, .mp4, manifests, etc.)
    page.on('response', async (response) => {
        const url = response.url();
        
        if (url.includes('m3u8') || url.includes('mp4') || url.includes('manifest') || url.includes('stream')) {
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

    console.log('Clicking every row action down the entire table matrix...');
    await page.evaluate(async () => {
        const rows = [...document.querySelectorAll('table tbody tr')];
        console.log(`Found ${rows.length} total interactive table rows.`);

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            
            // Finds the primary interactive element in the row, regardless of what text it has
            const clickableElement = row.querySelector('button, a, span, .btn');
            
            if (clickableElement) {
                clickableElement.scrollIntoView({ block: 'center' });
                clickableElement.click();
                
                // Give the stream token ample time to hit the network pipeline
                await new Promise(r => setTimeout(r, 3500));
            }
        }
    });

    await new Promise(r => setTimeout(r, 4000));
    await browser.close();

    // Merge values back to index.html workspace
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.error('❌ Missing target index.html file.');
        process.exit(1);
    }

    let htmlContent = fs.readFileSync(indexPath, 'utf8');
    let dynamicUpdateCounter = 0;

    console.log('\nProcessing Captured Stream Values and merging to index.html...');
    
    for (const [channelName, freshData] of Object.entries(liveChannelsData)) {
        const numMatch = channelName.match(/\d+/);
        if (!numMatch) continue;
        const numId = numMatch[0];

        // Flexible regex to match single/double quotes and case variations (_l vs _L)
        const looserTokenRegex = new RegExp(`(['"]chan-${numId}_[lL]['"]\\s*:\\s*['"])[^'"]*(['"])`, 'g');
        const looserHostRegex = new RegExp(`({\\s*host\\s*:\\s*['"])[^'"]*(['"]\\s*,\\s*chan\\s*:\\s*['"]chan-${numId}_[lL]['"])`, 'g');

        if (looserTokenRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(looserTokenRegex, `$1${freshData.token}$2`);
            console.log(`✅ Synced Token for Camera Number: ${numId} ➔ ${freshData.token || '[None]'}`);
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