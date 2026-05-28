const fs   = require('fs');
const path = require('path');

const CAMERA_CHANNELS = [
    { host: "cfase02", chan: "chan-5373_l" },
    { host: "cfase03", chan: "chan-5374_l" },
    { host: "cfase04", chan: "chan-5375_l" },
    { host: "cfsse11", chan: "chan-5376_l" },
    { host: "cfase01", chan: "chan-5378_l" },
    { host: "cfase02", chan: "chan-6332_l" },
    { host: "cfase04", chan: "chan-5381_l" },
    { host: "cfase04", chan: "chan-5432_l" },
    { host: "cfase03", chan: "chan-5440_l" },
    { host: "cfsse13", chan: "chan-5441_l" },
    { host: "cfase03", chan: "chan-6279_l" },
    { host: "cfsse02", chan: "chan-5442_l" },
    { host: "cfase02", chan: "chan-5443_l" },
    { host: "cfase01", chan: "chan-6275_l" },
    { host: "cfase03", chan: "chan-6276_l" },
    { host: "cfsse05", chan: "chan-6327_l" },
    { host: "cfsse05", chan: "chan-6328_l" },
    { host: "cfsse03", chan: "chan-5444_l" },
    { host: "cfase03", chan: "chan-5446_l" },
    { host: "cfase05", chan: "chan-5445_l" },
];
const KNOWN_CHANS = new Set(CAMERA_CHANNELS.map(c => c.chan));

async function scrapeTokens() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const captured = {};

    // Also intercept requests as a backup
    page.on('request', req => {
        const url = req.url();
        const m = url.match(/\/(chan-\d+_l)\/index\.m3u8\?token=([a-f0-9]+)/);
        if (m && KNOWN_CHANS.has(m[1]) && !captured[m[1]]) {
            captured[m[1]] = m[2];
            console.log(`[request intercept] ${m[1]} → ${m[2].slice(0,16)}...`);
        }
    });

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));

    // Dismiss modal
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));
    const xBtn = await page.evaluate(() => {
        const btn = document.querySelector('.modal .close, .modal-header .close, button[aria-label="Close"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (xBtn) await page.mouse.click(xBtn.x, xBtn.y);
    await new Promise(r => setTimeout(r, 1000));

    // Log the sidebar HTML so we can see the carousel structure
    const sidebarHTML = await page.evaluate(() => {
        const sidebar = document.querySelector('#cameras-panel, .camera-panel, [class*="camera"], #myCameras, .my-cameras');
        if (sidebar) return sidebar.innerHTML.slice(0, 2000);
        // Fallback: find the Show Video button and get its parent
        const btn = [...document.querySelectorAll('button,a')].find(el => /show\s*video/i.test(el.textContent));
        return btn ? btn.closest('[class]')?.innerHTML?.slice(0, 2000) : 'sidebar not found';
    });
    console.log('\n--- Sidebar HTML ---\n', sidebarHTML, '\n---\n');

    const cycleCount = 25;
    for (let i = 0; i < cycleCount; i++) {
        // Click Show Video
        const showVideoPos = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button, a')]
                .find(el => /show\s*video/i.test(el.textContent?.trim()));
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        });

        if (!showVideoPos) { console.log(`[${i+1}] No Show Video button`); break; }

        await page.mouse.move(showVideoPos.x, showVideoPos.y);
        await page.mouse.down(); await new Promise(r => setTimeout(r, 100)); await page.mouse.up();
        await new Promise(r => setTimeout(r, 2000));

        // Read the stream URL directly from every video/source element in the DOM
        const videoUrls = await page.evaluate(() => {
            const urls = [];
            document.querySelectorAll('video, source').forEach(el => {
                if (el.src) urls.push(el.src);
                if (el.currentSrc) urls.push(el.currentSrc);
            });
            // Also check for HLS src in any data attributes or angular/react state
            document.querySelectorAll('[src*="ncdot"], [data-src*="ncdot"]').forEach(el => {
                urls.push(el.src || el.dataset.src);
            });
            // Check for stream URLs in any script-injected style or attribute
            const allText = document.body.innerHTML;
            const matches = allText.match(/https?:\/\/[^"'\s]*services\.ncdot\.gov[^"'\s]*/g) || [];
            return [...new Set([...urls, ...matches])];
        });

        for (const url of videoUrls) {
            const m = url.match(/\/(chan-\d+_l)\/index\.m3u8\?token=([a-f0-9]+)/);
            if (m && KNOWN_CHANS.has(m[1]) && !captured[m[1]]) {
                captured[m[1]] = m[2];
                console.log(`[DOM] ${m[1]} → ${m[2].slice(0,16)}...`);
            }
        }

        // Log camera name and any URLs found
        const camName = await page.evaluate(() => {
            const el = document.querySelector('[class*="camera-name"], [class*="cameraName"], [class*="camera-title"]');
            return el?.textContent?.trim() || null;
        });
        console.log(`[${i+1}] Camera: ${camName || '?'} | URLs found: ${videoUrls.length} | Tokens: ${Object.keys(captured).length}/${KNOWN_CHANS.size}`);
        if (videoUrls.length > 0) console.log('  URLs:', videoUrls.slice(0,3));

        if (Object.keys(captured).length === KNOWN_CHANS.size) break;

        // Navigate carousel — find arrows relative to the camera preview widget
        // (avoid the main navbar by restricting to the sidebar/left panel area)
        const arrowPos = await page.evaluate(() => {
            // Get all buttons in the left sidebar (x < 400px)
            const candidates = [...document.querySelectorAll('button, a, span')]
                .filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.x < 400 && r.x > 0 && r.y > 300;
                });

            // Find a right-facing arrow
            const arrow = candidates.find(el => {
                const text = el.textContent?.trim();
                const cls  = (el.className || '') + (el.getAttribute('aria-label') || '');
                return text === '>' || text === '›' || text === '❯' || text === '▶' ||
                       /next|right|forward/i.test(cls);
            });

            if (!arrow) {
                // Log all sidebar candidates to help diagnose
                return {
                    found: false,
                    candidates: candidates.slice(0, 10).map(el => ({
                        tag: el.tagName, text: el.textContent?.trim().slice(0,20),
                        cls: el.className?.slice(0,40),
                        x: Math.round(el.getBoundingClientRect().x),
                        y: Math.round(el.getBoundingClientRect().y),
                    }))
                };
            }
            const r = arrow.getBoundingClientRect();
            return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, text: arrow.textContent?.trim(), cls: arrow.className };
        });

        if (arrowPos.found) {
            await page.mouse.click(arrowPos.x, arrowPos.y);
            console.log(`  → Carousel next at (${arrowPos.x}, ${arrowPos.y})`);
            await new Promise(r => setTimeout(r, 2000));
        } else {
            console.log('  → No carousel arrow. Sidebar candidates:', JSON.stringify(arrowPos.candidates));
            break;
        }
    }

    await page.screenshot({ path: 'debug.png' });
    await browser.close();
    return captured;
}

async function updateIndexHTML(newTokens) {
    const indexPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error('index.html not found');
    let html = fs.readFileSync(indexPath, 'utf8');

    const existingMatch = html.match(/const tokenConfig = ({[\s\S]*?});/);
    let existing = {};
    if (existingMatch) { try { existing = JSON.parse(existingMatch[1]); } catch (_) {} }

    const merged = { ...existing, ...newTokens, updated: new Date().toISOString() };
    const regex = /(\/\/ --- START TOKENS ---)[\s\S]*?(\/\/ --- END TOKENS ---)/;
    if (!regex.test(html)) throw new Error('Anchor comments not found in index.html');

    html = html.replace(regex,
        `$1\n        const tokenConfig = ${JSON.stringify(merged, null, 2)};\n        $2`);
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log(`✅ index.html updated — ${Object.keys(newTokens).length} tokens refreshed.`);
    if (Object.keys(newTokens).length < 20)
        console.warn(`⚠ ${20 - Object.keys(newTokens).length} tokens not refreshed — previous values kept.`);
}

async function main() {
    const tokens = await scrapeTokens();
    if (Object.keys(tokens).length === 0) {
        console.error('⛔ No tokens captured. Check sidebar HTML log and debug.png above.');
        process.exit(1);
    }
    await updateIndexHTML(tokens);
}

main().catch(err => { console.error('⛔', err.message); process.exit(1); });
