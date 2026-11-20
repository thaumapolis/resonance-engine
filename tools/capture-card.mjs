/**
 * tools/capture-card.mjs — paint the showcase card image, docs/card.png.
 *
 * The front page builds each card at 2:1 (thaumapolis.github.io's
 * tools/make_thumbs.py: THUMB_ASPECT). Resonance-engine previously fell back to
 * the generated motif, so its card showed nothing of the piece.
 *
 * The field is captured at 2:1 with the control panel hidden, so nothing but the
 * simulation is on screen. The pose matters more than the framing: an IDLE field
 * is a genuinely incoherent grid (measured mean local disagreement 0.434, ~60
 * phase fronts per scanline at the default coupling), so a card taken from idle
 * advertises noise. `wavefront` is the state the piece is actually about -- a
 * travelling crest -- and after the per-frame brightness normalisation it reads as
 * broad diagonal bands with real dark troughs.
 *
 * Captured through a composited copy of the canvas: the live context is created
 * with { alpha: false }, and a screenshot of such a canvas has here come out
 * black while reading its pixels with the same call returns correct data.
 *
 * Deterministic: the pose is seeded, and reduced motion removes the decorative
 * transitions that would otherwise make the capture depend on timing.
 *
 *   PLAYWRIGHT_ENTRY=... node tools/capture-card.mjs
 *
 * Re-run after anything that changes the field's appearance.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.PLAYWRIGHT_ENTRY;
if (!entry) {
  process.stderr.write('PLAYWRIGHT_ENTRY is not set (absolute path to playwright-core index.mjs).\n');
  process.exit(1);
}
const { firefox } = await import(entry);

// The card aspect, matched to the front page. Above the display size so the card
// is a downscale, never an upscale.
const CARD_W = 1400;
const CARD_H = 700;

const browser = await firefox.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
await page.waitForTimeout(1200);

// The seeded wavefront pose: the state the piece is about. See the header note
// for why not idle.
//
// setRunning(false) is not optional and belongs AFTER settlePose. The animation
// loop keeps stepping the field, so a pose taken while it runs is evolved away
// before the capture -- measured: posing 'wavefront' while running left a field
// whose luminance histogram was identical to 'idle' (dominant bin 22.2%), i.e. the
// card would quietly show noise while the code said 'wavefront'. This is the same
// order tests/browser.test.mjs uses.
await page.evaluate(async () => {
  const api = window.__resonance;
  // Same recipe as freezePose() in tests/browser.test.mjs, which is what paints
  // the wavefront golden this card is meant to match. resetDefaults + setVisuals
  // matter: without them a palette/scale left over from an earlier interaction
  // (or from a test that cycled the selects) ends up in the image.
  api.resetDefaults();
  api.setVisuals({ palette: 'abyss', scale: 'aeolian', root: 'C', map: 'diagonal' });
  // burst() is the gesture the intro invites; then advance a fixed number of
  // steps so the frame is the emergent banded state a visitor actually sees
  // (~6 s after bursting) rather than the synthetic ruled 'wavefront' pose, which
  // reads as a test pattern, and rather than idle, which is genuine incoherence
  // and reads as noise. Fixed step count, not wall time, so the card is stable.
  // Burst, then evolve a fixed number of steps -- the emergent banded state a
  // visitor sees ~6 s after pressing it. Fixed step count rather than wall time
  // so the card is reproducible. Driven through the exposed field so this needs
  // no new app surface; the loop is the same one settlePose('idle') uses.
  api.burst();
  api.setRunning(false);
  const { field, state } = api;
  for (let i = 0; i < 360; i++) field.step(1 / 60, { coupling: state.coupling, noise: state.noise });
  // Two frames after pausing so the canvas shows the frozen state rather than
  // the frame that happened to be in flight when time stopped.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

/*
 * Render the field into an explicitly 2:1 canvas rather than screenshotting the
 * page. The stage fills a CSS grid cell, so its own aspect tracks the viewport
 * and was measured at 1.649 here -- a full-page or element screenshot would then
 * be cropped by the front page's 2:1 framing. drawImage resamples the field's
 * bitmap to exactly CARD_W x CARD_H, so the source handed to make_thumbs.py is
 * already the right shape and letterboxing (or cropping) costs nothing.
 */
const dataUrl = await page.evaluate(
  ({ w, h }) => {
    const field = document.getElementById('field');
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(field, 0, 0, w, h);
    return out.toDataURL('image/png');
  },
  { w: CARD_W * 2, h: CARD_H * 2 },
);

mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
writeFileSync(
  path.join(ROOT, 'docs', 'card.png'),
  Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
);

if (errors.length > 0) {
  throw new Error(`page errors during capture: ${errors.join('; ')}`);
}
await context.close();
process.exit(0);
