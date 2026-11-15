const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mergeLayout, snapCreatorCues, muteCreator } = require('./react-analysis-media');

test('smoothed layouts always cover fractional durations without gaps or short interior segments', () => {
  for (let length = 1; length <= 9; length++) {
    for (let mask = 0; mask < 2 ** length; mask++) {
      const kinds = Array.from({ length }, (_, index) => (mask >> index & 1) ? 'split' : 'full');
      const duration = (length - 0.25) / 4;
      const layout = mergeLayout(kinds, duration);
      assert.equal(layout[0].start, 0);
      assert.equal(layout.at(-1).end, duration);
      layout.forEach((segment, index) => {
        assert.ok(segment.end > segment.start);
        if (index) assert.equal(segment.start, layout[index - 1].end);
        if (layout.length > 1) assert.ok(segment.end - segment.start >= 0.5);
      });
    }
  }
});

test('snapping remains inside a fractional duration after timestamp rounding', () => {
  const duration = 0.123456789;
  const cues = snapCreatorCues([{ role: 'creator', start: -1, end: 1, text: 'Hello' }], [], duration);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 0);
  assert.ok(cues[0].end <= duration);
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
test('real creator mute fades both stereo channels and handles overlapping, boundary and absent audio',
  { skip: !ffmpegAvailable, timeout: 30000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'react-mute-edges-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const input = path.join(directory, 'input.mp4'), output = path.join(directory, 'output.mp4');
    const silent = path.join(directory, 'silent.mp4');
    function run(args) {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
        { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr.toString());
      return result.stdout;
    }
    function channelRms(at, duration) {
      const samples = run(['-ss', String(at), '-i', output, '-t', String(duration),
        '-map', '0:a', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1']);
      assert.ok(samples.length > 0);
      return [0, 1].map(channel => {
        let square = 0;
        for (let offset = channel * 4; offset < samples.length; offset += 8) square += samples.readFloatLE(offset) ** 2;
        return Math.sqrt(square / (samples.length / 8));
      });
    }
    run(['-f', 'lavfi', '-i', 'color=c=blue:s=90x160:r=4:d=3', '-f', 'lavfi', '-i',
      'aevalsrc=0.2*sin(2*PI*400*t)|0.1*sin(2*PI*800*t):s=48000:d=3',
      '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-shortest', input]);
    await muteCreator(input, output, [{ start: 0, end: 0.15 }, { start: 1, end: 1.7 },
      { start: 1.5, end: 2 }, { start: 2.85, end: 3 }], true, 3,
    { env: { REACT_FFMPEG_THREADS: '1' } });
    const baseline = channelRms(0.5, 0.1);
    assert.ok(baseline[0] > 0.1 && baseline[1] > 0.05);
    for (const [start, duration] of [[0.01, 0.08], [1.05, 0.8], [2.9, 0.08]]) {
      channelRms(start, duration).forEach(value => assert.ok(value < 0.0001, `creator leaked: RMS ${value}`));
    }
    for (const start of [0.97, 2.02]) {
      channelRms(start, 0.01).forEach((value, channel) => {
        const ratio = value / baseline[channel];
        assert.ok(ratio > 0.4 && ratio < 0.8, `expected 40 ms fade, got RMS ratio ${ratio}`);
      });
    }
    run(['-i', input, '-map', '0:v', '-c:v', 'copy', '-an', silent]);
    await muteCreator(silent, output, [], false, 3, { env: { REACT_FFMPEG_THREADS: '1' } });
    channelRms(0.5, 0.1).forEach(value => assert.ok(value < 0.0001));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(probe.status, 0, probe.stderr);
    const info = JSON.parse(probe.stdout), audio = info.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(audio.codec_name, 'aac');
    assert.equal(audio.channels, 2);
    assert.equal(audio.sample_rate, '48000');
    assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.1);
  });
