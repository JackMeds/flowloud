const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'store-assets', 'source', 'flowloud-promo-background.png');
const output = path.join(root, 'store-assets');
const icon = path.join(root, 'extension', 'assets', 'flowloud-mark.svg');
const escape = (value) => String(value).replace(/[&<>]/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[match]));
async function promo(width, height, name, subtitle) {
  const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><style>.a{font:700 ${Math.round(height*.12)}px 'Segoe UI','Microsoft YaHei';fill:#251d38}.b{font:500 ${Math.round(height*.052)}px 'Segoe UI','Microsoft YaHei';fill:#5e566c}.c{font:700 ${Math.round(height*.035)}px 'Segoe UI';fill:#6848d0;letter-spacing:3px}</style><text x="${width*.56}" y="${height*.37}" class="c">FLOWLOUD</text><text x="${width*.56}" y="${height*.53}" class="a">流声</text><text x="${width*.56}" y="${height*.66}" class="b">${escape(subtitle)}</text></svg>`);
  await sharp(source).resize(width, height, { fit: 'cover' }).composite([{ input: overlay }]).png().toFile(path.join(output, name));
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  for (const size of [16, 32, 48, 128]) await sharp(icon).resize(size, size).png().toFile(path.join(root, 'extension', 'assets', `flowloud-${size}.png`));
  await promo(440, 280, 'edge-promo-440x280.png', '网页内容，自然流动');
  await promo(1280, 800, 'store-hero-1280x800.png', 'System · Browser · Local · Online');
})();
