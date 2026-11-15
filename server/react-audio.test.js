const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildFfmpegArgs } = require('./react-ffmpeg');

const sampleRate = 48000;
const duration = 2;
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffmpegAvailable = spawnSync(ffmpegPath, ['-version'], { timeout: 5000 }).status === 0;

function level(buffer, start, end) {
  const first = Math.round(start * sampleRate), last = Math.round(end * sampleRate);
  assert.ok(last > first && buffer.length >= last * 4, 'measured window must contain samples');
  let power = 0;
  for (let index = first; index < last; index++) power += buffer.readFloatLE(index * 4) ** 2;
  return 10 * Math.log10(power / (last - first));
}

function audioGraph() {
  const args = buildFfmpegArgs({ rawPath: 'mic.f32', referencePath: 'reference.f32', outputPath: 'output.mp4',
    rawDuration: duration, rawHasAudio: true, referenceHasAudio: true, crop: { top: 0, height: 0.5 },
    syncMs: 0, output: 'stitched', referenceAudio: true });
  const nodes = args[args.indexOf('-filter_complex') + 1].split(';');
  const node = prefix => {
    const found = nodes.find(part => part.startsWith(prefix));
    assert.ok(found, `production graph must contain ${prefix}`);
    return found;
  };
  // Keep every production audio filter, including the final mix and limiter.
  // Extra splits expose its actual mic, ducked reference and unducked baseline;
  // subtracting two independently limited mixes would not isolate either stem.
  return [node('[0:a]'), node('[1:a]'),
    '[refaudio]asplit=2[refinput][baseline]', node('[mic]asplit='),
    node('[refaudio][sidechain]').replace('[refaudio][sidechain]', '[refinput][sidechain]'),
    '[micmix]asplit=2[micstem][micinput]', '[ducked]asplit=2[refstem][duckinput]',
    node('[micmix][ducked]').replace('[micmix][ducked]', '[micinput][duckinput]')].join(';');
}

test('real ffmpeg keeps a weak half-second voice above mastered reference and releases ducking in noise',
  { skip: !ffmpegAvailable, timeout: 30000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'react-audio-levels-'));
    try {
      const mic = Buffer.alloc(sampleRate * duration * 4), reference = Buffer.alloc(mic.length);
      let seed = 137;
      for (let index = 0; index < sampleRate * duration; index++) {
        const time = index / sampleRate;
        seed = (1664525 * seed + 1013904223) >>> 0;
        const noise = seed / 0x80000000 - 1;
        // The harmonic voice is about -26 dBFS RMS, followed by -65 dBFS noise.
        const voice = 0.062 * (Math.sin(2 * Math.PI * 220 * time) +
          0.5 * Math.sin(2 * Math.PI * 440 * time) + 0.25 * Math.sin(2 * Math.PI * 660 * time));
        mic.writeFloatLE(time < 0.5 ? voice : 0.001 * noise, index * 4);
        reference.writeFloatLE(0.2821727 * Math.sin(2 * Math.PI * 1100 * time), index * 4);
      }
      const micPath = path.join(directory, 'mic.f32'), referencePath = path.join(directory, 'reference.f32');
      await Promise.all([fs.writeFile(micPath, mic), fs.writeFile(referencePath, reference)]);
      assert.ok(Math.abs(level(mic, 0.05, 0.45) + 26) < 1, 'fixture voice must be weak');
      assert.ok(Math.abs(level(reference, 0.05, 0.45) + 14) < 1, 'fixture reference must be mastered');
      assert.ok(level(mic, 1.4, 1.9) < -60, 'fixture must contain low noise after the voice');

      const stems = ['micstem', 'refstem', 'baseline', 'a'];
      const outputPaths = stems.map(stem => path.join(directory, `${stem}.f32`));
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'f32le', '-ar', String(sampleRate), '-ac', '1', '-i', micPath,
        '-f', 'f32le', '-ar', String(sampleRate), '-ac', '1', '-i', referencePath,
        '-filter_complex_threads', '1', '-filter_complex', audioGraph()];
      stems.forEach((stem, index) => args.push('-map', `[${stem}]`, '-t', String(duration),
        '-ar', String(sampleRate), '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', outputPaths[index]));
      const result = spawnSync(ffmpegPath, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
      const [micStem, duckedStem, baseline, mixed] = await Promise.all(outputPaths.map(file => fs.readFile(file)));
      const voicedMic = level(micStem, 0.05, 0.45), voicedReference = level(duckedStem, 0.05, 0.45);
      const voicedBaseline = level(baseline, 0.05, 0.45);
      // Measure after the 350 ms compressor release, while the mic carries noise.
      const quietReference = level(duckedStem, 1.4, 1.9), quietBaseline = level(baseline, 1.4, 1.9);
      const lead = voicedMic - voicedReference, attenuation = quietBaseline - quietReference;
      t.diagnostic(`voiced mic ${voicedMic.toFixed(2)} dBFS; ducked reference ${voicedReference.toFixed(2)} dBFS; ` +
        `mic lead ${lead.toFixed(2)} dB; quiet reference attenuation ${attenuation.toFixed(2)} dB`);
      assert.ok(voicedMic > -24 && voicedMic < -8, `processed voice must be audible: ${voicedMic} dBFS`);
      assert.ok(voicedBaseline > -24 && voicedBaseline < -20,
        `normalized baseline reference must remain present: ${voicedBaseline} dBFS`);
      assert.ok(lead >= 8, `voiced microphone must exceed ducked reference by at least 8 dB, got ${lead}`);
      assert.ok(voicedBaseline - voicedReference >= 6, 'voice must cause at least 6 dB of reference ducking');
      assert.ok(attenuation >= -0.1 && attenuation <= 3,
        `reference must recover within 3 dB after voice ends, got ${attenuation} dB attenuation`);
      assert.ok(Math.abs(quietBaseline - voicedBaseline) < 0.1, 'reference fixture must stay continuous');
      let peak = 0;
      for (let offset = 0; offset < mixed.length; offset += 4) peak = Math.max(peak, Math.abs(mixed.readFloatLE(offset)));
      assert.ok(peak > 0.05 && peak < 0.89, `production mixed audio must be present and below limiting: ${peak}`);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
