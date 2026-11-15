const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { renderVideo } = require('./react-ffmpeg');

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('real ffmpeg freezes a split frame when the analyzed full boundary is 0.2 seconds late',
  { skip: !ffmpegAvailable, timeout: 120000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'react-freeze-margin-test-'));
    const rawPath = path.join(directory, 'raw.mp4');
    const referencePath = path.join(directory, 'reference.mp4');
    const outputPath = path.join(directory, 'output.mp4');

    function run(args) {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr.toString());
      return result.stdout;
    }

    function meanTopColor(file, at, stitched = false) {
      const crop = stitched ? 'crop=1080:960:0:0' : 'crop=iw:ih/2:0:0';
      const pixels = run(['-ss', String(at), '-i', file, '-frames:v', '1', '-vf',
        `${crop},scale=16:16,format=rgb24`, '-f', 'rawvideo', 'pipe:1']);
      assert.equal(pixels.length, 16 * 16 * 3);
      const mean = [0, 0, 0];
      for (let index = 0; index < pixels.length; index++) mean[index % 3] += pixels[index];
      return mean.map(total => total / (pixels.length / 3));
    }

    function colorDistance(left, right) {
      return Math.hypot(...left.map((value, index) => value - right[index]));
    }

    try {
      run(['-f', 'lavfi', '-i', 'color=c=black:s=128x192:r=30:d=3', '-an',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', rawPath]);
      run(['-f', 'lavfi', '-i', 'color=c=red:s=128x192:r=30:d=3', '-vf',
        "drawbox=x=0:y=0:w=iw:h=ih/2:c=blue:t=fill:enable='lt(t,2)'," +
        "drawbox=x=0:y=ih/2:w=iw:h=ih/2:c=green:t=fill:enable='lt(t,2)'", '-an',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', referencePath]);

      const splitColor = meanTopColor(referencePath, 1.9);
      const fullColor = meanTopColor(referencePath, 2.1);
      assert.ok(splitColor[2] > 220 && splitColor[0] < 20, `split fixture must be blue: ${splitColor}`);
      assert.ok(fullColor[0] > 220 && fullColor[2] < 20, `full fixture must be red: ${fullColor}`);
      assert.ok(colorDistance(splitColor, fullColor) > 300, 'fixture colors must clearly distinguish the transition');

      const options = { rawPath, referencePath, outputPath, rawDuration: 3,
        rawHasAudio: false, referenceHasAudio: false, referenceAudio: false,
        crop: { top: 0, height: 0.5 }, syncMs: 0, output: 'stitched',
        analysis: { layout: [
          { start: 0, end: 2.2, kind: 'split' }, { start: 2.2, end: 3, kind: 'full' },
        ] } };

      await renderVideo(options, { env: {}, timeoutMs: 60000 });
      for (const at of [2.4, 2.85]) {
        const frozenColor = meanTopColor(outputPath, at, true);
        const splitDistance = colorDistance(frozenColor, splitColor);
        const fullDistance = colorDistance(frozenColor, fullColor);
        assert.ok(splitDistance < 10, `frozen top pane must match split image at ${at}s: ${frozenColor}`);
        assert.ok(fullDistance > 300, `frozen top pane must differ from full image at ${at}s: ${frozenColor}`);
        t.diagnostic(`safe freeze at ${at}s: RGB ${frozenColor}; split distance ${splitDistance.toFixed(2)}, ` +
          `full distance ${fullDistance.toFixed(2)}`);
      }

      // Prove the fixture catches the original failure: without the margin,
      // the last frame before the inaccurate 2.2-second boundary is already red.
      await renderVideo(options, { env: {}, freezeMarginSec: 0, timeoutMs: 60000 });
      const unsafeColor = meanTopColor(outputPath, 2.4, true);
      assert.ok(colorDistance(unsafeColor, fullColor) < 10,
        `zero-margin control must freeze the full image: ${unsafeColor}`);
      assert.ok(colorDistance(unsafeColor, splitColor) > 300,
        'zero-margin control must fail the safe split-image comparison');
      t.diagnostic(`zero-margin control at 2.4s: RGB ${unsafeColor}; ` +
        `split distance ${colorDistance(unsafeColor, splitColor).toFixed(2)}, ` +
        `full distance ${colorDistance(unsafeColor, fullColor).toFixed(2)}`);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
