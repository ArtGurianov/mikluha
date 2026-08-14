#!/usr/bin/env node
/**
 * One-off dev tool: generates placeholder master photos for the local mock
 * content set (lib/cms/fixtures/assets/). Not part of the production build
 * pipeline — real photos replace these fixtures long before launch.
 *
 * Usage: node scripts/dev/generate-placeholder-photos.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../lib/cms/fixtures/assets");

const WIDTH = 2000;
const HEIGHT = 1333;

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function gradientPhotoSvg({ width, height, from, to, angle, label, sublabel }) {
  const rad = (angle * Math.PI) / 180;
  const x2 = 50 + 50 * Math.cos(rad);
  const y2 = 50 + 50 * Math.sin(rad);
  const x1 = 50 - 50 * Math.cos(rad);
  const y1 = 50 - 50 * Math.sin(rad);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">
        <stop offset="0%" stop-color="${from}"/>
        <stop offset="100%" stop-color="${to}"/>
      </linearGradient>
      <filter id="noise">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="noise"/>
        <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.03 0"/>
      </filter>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#g)"/>
    <rect width="${width}" height="${height}" filter="url(#noise)"/>
    <text x="50%" y="46%" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="72" fill="white" fill-opacity="0.92">${escapeXml(label)}</text>
    ${sublabel ? `<text x="50%" y="54%" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" letter-spacing="4" fill="white" fill-opacity="0.7">${escapeXml(sublabel.toUpperCase())}</text>` : ""}
    <text x="50%" y="94%" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" fill="white" fill-opacity="0.55">ТЕСТОВОЕ ИЗОБРАЖЕНИЕ — ЗАМЕНИТЕ ПЕРЕД ЗАПУСКОМ</text>
  </svg>`;
}

function qrPlaceholderSvg({ size = 1200 }) {
  const cell = size / 12;
  let modules = "";
  const seed = [
    "111101110111",
    "100001010001",
    "101101010101",
    "101101010101",
    "100001010001",
    "111101110111",
    "000000000000",
    "110100111010",
    "001011000101",
    "111101110111",
    "100001010001",
    "101101010101",
  ];
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      if (seed[row][col] === "1") {
        modules += `<rect x="${col * cell}" y="${row * cell}" width="${cell}" height="${cell}" fill="#24211c"/>`;
      }
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${size}" height="${size}" fill="#ffffff"/>
    <g opacity="0.85">${modules}</g>
    <rect x="0" y="0" width="${size}" height="${size}" fill="none" stroke="#e14f2a" stroke-width="14" stroke-dasharray="30 18"/>
    <rect x="${size * 0.18}" y="${size * 0.42}" width="${size * 0.64}" height="${size * 0.16}" fill="#ffffff" stroke="#e14f2a" stroke-width="6"/>
    <text x="50%" y="52%" text-anchor="middle" font-family="Arial, sans-serif" font-weight="bold" font-size="${size * 0.06}" fill="#e14f2a">ТЕСТОВЫЙ QR</text>
  </svg>`;
}

const photos = [
  // Altai tour
  { file: "altai-cover.jpg", from: "#1d5e6b", to: "#3f8f5c", angle: 30, label: "Горный Алтай", sublabel: "обложка" },
  { file: "altai-gallery-1.jpg", from: "#2a6f4d", to: "#7fae3f", angle: 45, label: "Горный Алтай", sublabel: "фото 1" },
  { file: "altai-gallery-2.jpg", from: "#174f6b", to: "#4a8fae", angle: 120, label: "Горный Алтай", sublabel: "фото 2" },
  { file: "altai-gallery-3.jpg", from: "#3a6f3a", to: "#9db84a", angle: 200, label: "Горный Алтай", sublabel: "фото 3" },
  { file: "altai-gallery-4.jpg", from: "#1d3f5c", to: "#5c8fae", angle: 300, label: "Горный Алтай", sublabel: "фото 4" },
  // Krasnoyarsk Stolby tour
  { file: "stolby-cover.jpg", from: "#334c3a", to: "#6a7f5c", angle: 30, label: "Красноярские Столбы", sublabel: "обложка" },
  { file: "stolby-gallery-1.jpg", from: "#3f4f3a", to: "#8f9f6a", angle: 60, label: "Красноярские Столбы", sublabel: "фото 1" },
  { file: "stolby-gallery-2.jpg", from: "#2a3f4a", to: "#5c7f8f", angle: 150, label: "Красноярские Столбы", sublabel: "фото 2" },
  { file: "stolby-gallery-3.jpg", from: "#4a3f2a", to: "#8f7a5c", angle: 220, label: "Красноярские Столбы", sublabel: "фото 3" },
  { file: "stolby-gallery-4.jpg", from: "#2f4a3f", to: "#6a9f7f", angle: 280, label: "Красноярские Столбы", sublabel: "фото 4" },
  // Hero / OG
  { file: "hero.jpg", from: "#173a5c", to: "#e07a3f", angle: 25, label: "Миклуха Маклай", sublabel: "путешествия и походы" },
  // Reports
  { file: "report-altai-cover.jpg", from: "#245c4a", to: "#a3c95c", angle: 40, label: "Отчёт: Алтай", sublabel: "август" },
  { file: "report-altai-1.jpg", from: "#1f5c3f", to: "#7fae4a", angle: 80, label: "Алтай", sublabel: "поход 1" },
  { file: "report-altai-2.jpg", from: "#1a4f6b", to: "#4a8fae", angle: 140, label: "Алтай", sublabel: "поход 2" },
  { file: "report-altai-3.jpg", from: "#3a5f2a", to: "#9db84a", angle: 210, label: "Алтай", sublabel: "поход 3" },
  { file: "report-altai-4.jpg", from: "#1d3f5c", to: "#6a9fae", angle: 260, label: "Алтай", sublabel: "поход 4" },
  { file: "report-altai-5.jpg", from: "#2a4f3a", to: "#8fae5c", angle: 320, label: "Алтай", sublabel: "поход 5" },
  { file: "report-stolby-cover.jpg", from: "#3f4a2a", to: "#8f9f5c", angle: 40, label: "Отчёт: Столбы", sublabel: "июль" },
  { file: "report-stolby-1.jpg", from: "#334f3a", to: "#7f9f6a", angle: 90, label: "Столбы", sublabel: "поход 1" },
  { file: "report-stolby-2.jpg", from: "#2a3f5c", to: "#5c7fae", angle: 160, label: "Столбы", sublabel: "поход 2" },
  { file: "report-stolby-3.jpg", from: "#4a3f2a", to: "#9f8a5c", angle: 230, label: "Столбы", sublabel: "поход 3" },
  { file: "report-stolby-4.jpg", from: "#2f4a3f", to: "#6aaf8f", angle: 270, label: "Столбы", sublabel: "поход 4" },
  { file: "report-stolby-5.jpg", from: "#3a2f4a", to: "#8f6aae", angle: 330, label: "Столбы", sublabel: "поход 5" },
  // Organizer
  { file: "organizer-alexey.jpg", from: "#5c3a24", to: "#c98f4a", angle: 35, label: "Алексей", sublabel: "организатор" },
  // Reviews (chat-bubble mock style, softer)
  { file: "review-1.jpg", from: "#e8e4dc", to: "#c9d9c9", angle: 20, label: "Отзыв", sublabel: "переписка 1" },
  { file: "review-2.jpg", from: "#e4e8dc", to: "#c9d0d9", angle: 60, label: "Отзыв", sublabel: "переписка 2" },
  { file: "review-3.jpg", from: "#e8e0dc", to: "#d9c9c9", angle: 100, label: "Отзыв", sublabel: "переписка 3" },
  { file: "review-4.jpg", from: "#dce4e8", to: "#c9d9d0", angle: 140, label: "Отзыв", sublabel: "переписка 4" },
  { file: "review-5.jpg", from: "#e8e4dc", to: "#d0c9d9", angle: 180, label: "Отзыв", sublabel: "переписка 5" },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const photo of photos) {
    const svg = gradientPhotoSvg({ width: WIDTH, height: HEIGHT, ...photo });
    const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
    await writeFile(path.join(OUT_DIR, photo.file), buffer);
    console.log(`wrote ${photo.file}`);
  }

  const qrSvg = qrPlaceholderSvg({ size: 1200 });
  const qrBuffer = await sharp(Buffer.from(qrSvg)).png().toBuffer();
  await writeFile(path.join(OUT_DIR, "qr-default.png"), qrBuffer);
  console.log("wrote qr-default.png");

  console.log(`Done. ${photos.length + 1} placeholder assets in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
