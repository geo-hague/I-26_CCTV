const fs   = require('fs');
const path = require('path');

const DRIVENC = 'https://www.drivenc.gov';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function run() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    // Track data mapped dynamically by channel name: { "chan-5373_l": { host: "cfase02", token: "..." } }
    let liveChannelsData = {};

    // 1. Intercept network data
    page.on('response', async (response) => {
        const url = response.url();
        try {
            if (url.includes('GetUserCameras')) {
                const text = await response.text();
                const json = JSON.parse(text);
                
                if (json && json.data && Array.isArray(json.data)) {
                    console.log(`[Network Intercept] Processing ${json.data.length} live map stream configurations.`);
                    
                    json.data.forEach(cam => {
                        if (cam.images && Array.isArray(cam.images)) {
                            cam.images.forEach(img => {
                                if (img.videoUrl) {
                                    const rawUrl = img.videoUrl;
                                    
                                    // Extract the channel identifier name directly from the streaming path URL string
                                    // Handles pulling out segments like "chan-5373_l"
                                    const chanMatch = rawUrl.match(/(chan-[0-9a-zA-Z_]+)/i);
                                    
                                    if (chanMatch) {
                                        const detectedChan = chanMatch[1].toLowerCase();
                                        
                                        try {
                                            const parsedUrl = new URL(rawUrl);
                                            const hostPrefix = parsedUrl.hostname.split('.')[0];
                                            const tokenVal = parsedUrl.searchParams.get('token') || '';

                                            liveChannelsData[detectedChan] = {
                                                host: hostPrefix,
                                                token: tokenVal
                                            };
                                        } catch (urlErr) {
                                            const hostMatch = rawUrl.match(/https?:\/\/([^.]+)\./i);
                                            const tokenMatch = rawUrl.match(/[?&]token=([^&]+)/i);
                                            if (hostMatch) {
                                                liveChannelsData[detectedChan] = {
                                                    host: hostMatch[1],
                                                    token: tokenMatch ? tokenMatch[1] : ''
                                                };
                                            }
                                        }
                                    }
                                }
                            });
                        }
                    });
                }
            }
        } catch (e) { /* Safe catch for asset frame streams */ }
    });

    console.log('Opening target dashboard...');
    await page.goto(DRIVENC, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 4000));

    // Dismiss overlay elements
    await page.keyboard.press('Escape');

    console.log('Activating Layer Layout Modules...');
    await page.evaluate(() => {
        const elements = [...document.querySelectorAll('label, span, div, input')];
        const targetLayer = elements.find(e => e.textContent?.trim() === 'Cameras');
        if (targetLayer) targetLayer.click();
    });

    console.log('Capturing streaming routing maps...');
    await new Promise(r => setTimeout(r, 8000));
    await browser.close();

    // 2. Modifying index.html Workspace Contents
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.error('❌ Missing target index.html layout asset file.');
        process.exit(1);
    }

    let htmlContent = fs.readFileSync(indexPath, 'utf8');
    let dynamicUpdateCounter = 0;

    // Scan your actual live channels caught over the network pipe 
    // and replace them one-by-one straight into your file layout configuration tables
    for (const [channelName, freshData] of Object.entries(liveChannelsData)) {
        
        // Match token parameter entry line configurations
        const tokenRegex = new RegExp(`("${channelName}"\\s*:\\s*")[^"]*(")`, 'gi');
        if (tokenRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(tokenRegex, `$1${freshData.token}$2`);
            console.log(`✅ Synced Token for: ${channelName} ➔ ${freshData.token || '[Empty/None Needed]'}`);
            dynamicUpdateCounter++;
        }

        // Match host array element configuration structures
        const hostRegex = new RegExp(`({\\s*host\\s*:\\s*")[^"]*("\\s*,\\s*chan\\s*:\\s*"${channelName}")`, 'gi');
        if (hostRegex.test(htmlContent)) {
            htmlContent = htmlContent.replace(hostRegex, `$1${freshData.host}$2`);
            console.log(`🔗 Routed Host for: ${channelName} ➔ ${freshData.host}`);
        }
    }

    // Stamp active update tracking parameters
    const timestampStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    htmlContent = htmlContent.replace(/"updated"\s*:\s*"[^"]*"/g, `"updated": "${timestampStr}"`);

    // 3. Save updates
    if (dynamicUpdateCounter > 0) {
        fs.writeFileSync(indexPath, htmlContent, 'utf8');
        console.log(`\n🎉 Success! Synchronized ${dynamicUpdateCounter} target camera tokens inside index.html variables.`);
    } else {
        console.log('\n⚠️ Map complete, but none of the channels intercepted from this region match your specific dashboard layout channel IDs.');
    }
}

run().catch(err => { console.error('⛔ Critical script exception:', err); process.exit(1); });