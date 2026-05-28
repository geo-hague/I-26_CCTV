const fs   = require('fs');
const path = require('path');

async function main() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    console.log('Loading drivenc.gov...');
    await page.goto('https://www.drivenc.gov/', { waitUntil: 'networkidle2', timeout: 90000 });

    console.log('Waiting 10s for map to fully render...');
    await new Promise(r => setTimeout(r, 10000));

    await page.screenshot({ path: 'debug.png' });
    console.log('Screenshot saved.');

    const domInfo = await page.evaluate(() => {
        const imgs = [...new Set(
            [...document.querySelectorAll('img')].map(el => el.src).filter(Boolean)
        )];

        const bgDivs = [...new Set(
            [...document.querySelectorAll('*')]
                .map(el => getComputedStyle(el).backgroundImage)
                .filter(s => s && s !== 'none' && (s.includes('camera') || s.includes('511') || s.includes('map')))
        )].slice(0, 20);

        return { imgs, bgDivs };
    });

    console.log('\nAll img srcs on page:');
    domInfo.imgs.forEach(s => console.log(' ', s));
    console.log('\nBackground-image containing camera/511/map:');
    domInfo.bgDivs.forEach(s => console.log(' ', s));

    await browser.close();
}

main().catch(err => {
    console.error('⛔', err.message);
    process.exit(1);
});
