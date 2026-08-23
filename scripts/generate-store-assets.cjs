const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'store-assets', 'source', 'flowloud-promo-background.png');
const output = path.join(root, 'store-assets');
const icon = path.join(root, 'extension', 'assets', 'flowloud-mark.svg');
const toolbarStates = {
  idle: '#64748b',
  playing: '#16a34a',
  paused: '#d97706',
  error: '#dc2626',
};
const escape = (value) => String(value).replace(/[&<>]/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[match]));
async function promo(width, height, name, subtitle) {
  const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><style>.a{font:700 ${Math.round(height*.12)}px 'Segoe UI','Microsoft YaHei';fill:#251d38}.b{font:500 ${Math.round(height*.052)}px 'Segoe UI','Microsoft YaHei';fill:#5e566c}.c{font:700 ${Math.round(height*.035)}px 'Segoe UI';fill:#6848d0;letter-spacing:3px}</style><text x="${width*.56}" y="${height*.37}" class="c">FLOWLOUD</text><text x="${width*.56}" y="${height*.53}" class="a">流声</text><text x="${width*.56}" y="${height*.66}" class="b">${escape(subtitle)}</text></svg>`);
  await sharp(source).resize(width, height, { fit: 'cover' }).composite([{ input: overlay }]).png().toFile(path.join(output, name));
}

async function safeLogo(size) {
  const inset = Math.max(1, Math.round(size * .08));
  const logoSize = size - inset * 2;
  const logoBuffer = await sharp(icon).resize(logoSize, logoSize).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: logoBuffer, left: inset, top: inset }])
    .png()
    .toBuffer();
}

async function toolbarLogo(size, color) {
  const inset = Math.max(1, Math.round(size * .06));
  const canvas = 128;
  const stateSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas} ${canvas}">
    <rect width="${canvas}" height="${canvas}" rx="30" fill="${color}"/>
    <path d="M22 66c10-20 19-20 28 0s19 20 28 0 19-20 28 0" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round"/>
    <path d="M30 43h35M30 91h55" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".84"/>
  </svg>`);
  const rendered = await sharp(stateSvg).resize(size - inset * 2, size - inset * 2).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: rendered, left: inset, top: inset }])
    .png()
    .toBuffer();
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await fs.writeFile(path.join(root, 'extension', 'assets', `flowloud-${size}.png`), await safeLogo(size));
  }
  for (const size of [16, 32]) {
    for (const [state, color] of Object.entries(toolbarStates)) {
      await fs.writeFile(path.join(root, 'extension', 'assets', `flowloud-toolbar-${state}-${size}.png`), await toolbarLogo(size, color));
    }
  }
  await promo(440, 280, 'edge-promo-440x280.png', '网页内容，自然流动');
  await promo(1280, 800, 'store-hero-1280x800.png', 'System · Browser · Local · Online');
})();
