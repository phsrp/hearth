// Renders build/icon.png (Tabler "flame" on a Rosé Pine tile). Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const glyph = fs.readFileSync(path.join(__dirname, '../node_modules/@tabler/icons/icons/outline/flame.svg'), 'utf8')
  .replace(/<svg[\s\S]*?>/, '').replace('</svg>', '');
const html = `<html><body style="margin:0;background:transparent">
<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#26233a"/><stop offset="1" stop-color="#191724"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <rect x="8.5" y="8.5" width="239" height="239" rx="55.5" fill="none" stroke="#403d52" stroke-width="2"/>
  <g transform="translate(40 40) scale(7.33)" fill="none" stroke="#ebbcba" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
</svg></body></html>`;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), img.resize({ width: 256, height: 256 }).toPNG());
  app.quit();
});
