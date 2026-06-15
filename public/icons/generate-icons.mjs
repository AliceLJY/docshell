import sharp from 'sharp';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = join(__dirname, 'icon.svg');
const svgBuffer = readFileSync(svgPath);

const sizes = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-180.png', size: 180 },
];

for (const { name, size } of sizes) {
  const outPath = join(__dirname, name);
  await sharp(svgBuffer, { density: 300 })
    .resize(size, size)
    .png()
    .toFile(outPath);
  console.log(`Created ${name} (${size}x${size})`);
}

console.log('Done!');
