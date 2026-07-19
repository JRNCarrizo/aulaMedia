const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const size = 512;
const radius = Math.round(size * 0.22);
const root = path.join(__dirname, '..');
const src = path.join(root, 'assets', 'icon-source.png');
const out = path.join(root, 'assets', 'icon.png');

if (!fs.existsSync(src)) {
  console.error('Falta assets/icon-source.png');
  process.exit(1);
}

const svgMask = Buffer.from(
  `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>` +
    `</svg>`
);

(async () => {
  // 1) Quitar bordes vacíos para quedarnos con el cuadrado crema del dibujo
  const trimmed = await sharp(src).trim({ threshold: 12 }).png().toBuffer();

  // 2) Llenar el canvas con ese cuadrado (así el crema llega a los bordes)
  const filled = await sharp(trimmed)
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .ensureAlpha()
    .png()
    .toBuffer();

  // 3) Máscara redondeada: las puntas del crema quedan transparentes (curvas reales)
  const tmp = path.join(root, 'assets', 'icon.tmp.png');
  await sharp(filled)
    .composite([{ input: svgMask, blend: 'dest-in' }])
    .png()
    .toFile(tmp);

  fs.renameSync(tmp, out);
  console.log('Listo: cuadrado crema con puntas redondeadas ->', out);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
