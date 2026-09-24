#!/usr/bin/env node
/**
 * Check an exported .eml or raw MIME file for the outbound tracking pixel.
 *
 *   npm run verify:tracking -- path/to/message.eml
 *
 * This does not call Gmail or the tracker. It only reads the file you pass.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run verify:tracking -- path/to/message.eml');
  process.exit(2);
}

const raw = readFileSync(file, 'utf8');
const pixels = [...raw.matchAll(/<img\b[^>]*\bsrc=["']([^"']*\/open\/(trk_[A-Za-z0-9_-]+))/gi)];
const links = [...raw.matchAll(/href=["'][^"']*\/c\/(clk_[A-Za-z0-9_-]+)/gi)];
const ids = [...new Set(pixels.map((match) => match[2]).filter(Boolean))];

if (!pixels.length) {
  console.log('Tracking pixel found: NO');
  process.exitCode = 1;
} else {
  console.log('Tracking pixel found: YES');
  console.log(`Tracking ID: ${ids.join(', ')}`);
  console.log(`Pixel count: ${pixels.length}`);
  console.log(`Tracked links: ${links.length}`);
}
