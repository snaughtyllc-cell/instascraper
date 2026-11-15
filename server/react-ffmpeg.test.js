const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildFfmpegArgs, probeVideo, renderVideo, resolveFfmpegThreads } = require('./react-ffmpeg');

function options(overrides = {}) {
  return { rawPath: '/tmp/raw.mp4', referencePath: '/tmp/reference.mp4', outputPath: '/tmp/output.mp4',
    rawDuration: 3, rawHasAudio: true, referenceHasAudio: true, crop: { top: 0, height: 0.5 },
    syncMs: 0, output: 'stitched', referenceAudio: true, ...overrides };
}

function filter(args) {
  return args[args.indexOf('-filter_complex') + 1];
}

test('stitched ffmpeg graph uses the specified geometry, encoders, duration and audio mix', () => {
  const args = buildFfmpegArgs(options());
  const graph = filter(args);
  assert.match(graph, /\[0:v\].*scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1,fps=30\[bot\]/);
  assert.match(graph, /\[1:v\].*crop=iw:ih\*0.5:0:ih\*0,scale=1080:960/);
  assert.match(graph, /tpad=stop_mode=clone:stop_duration=600\[top\]/);
  assert.match(graph, /\[top\]\[bot\]vstack=inputs=2\[v\]/);
  assert.match(graph, /volume=1.0/);
  assert.match(graph, /volume=0.8/);
  assert.match(graph, /amix=inputs=2:duration=first:normalize=0,alimiter/);
  assert.equal(args[args.indexOf('-t') + 1], '3');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-preset') + 1], 'veryfast');
  assert.equal(args[args.indexOf('-crf') + 1], '20');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-b:a') + 1], '160k');
  assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
  assert.doesNotMatch(graph, /hflip/);
  assert.ok(!args.includes('-noautorotate'));
});

test('positive sync offsets the reference input and clones its first frame with one audio delay', () => {
  const args = buildFfmpegArgs(options({ syncMs: 1234 }));
  assert.deepEqual(args.slice(args.indexOf('-itsoffset'), args.indexOf('-itsoffset') + 2), ['-itsoffset', '1.234']);
  assert.ok(args.indexOf('-itsoffset') < args.indexOf('/tmp/reference.mp4'));
  assert.match(filter(args), /\[1:v\]setpts=PTS-STARTPTS/);
  assert.match(filter(args), /tpad=start_mode=clone:start_duration=1.234/);
  assert.match(filter(args), /\[1:a\]asetpts=PTS-STARTPTS,adelay=1234:all=1,volume=0.8/);
});

test('ffmpeg thread caps default to two in the filter and output option sections', () => {
  for (const output of ['stitched', 'solo']) {
    const opts = options({ output });
    const args = buildFfmpegArgs(opts);
    const graphIndex = args.indexOf('-filter_complex');
    const outputIndex = args.indexOf(opts.outputPath);
    const lastInputIndex = args.lastIndexOf('-i');
    for (const flag of ['-filter_threads', '-filter_complex_threads']) {
      assert.equal(args[args.indexOf(flag) + 1], '2');
      assert.ok(args.indexOf(flag) < graphIndex);
    }
    assert.equal(args[args.indexOf('-threads') + 1], '2');
    assert.ok(args.indexOf('-threads') > lastInputIndex + 1);
    assert.ok(args.indexOf('-threads') > graphIndex);
    assert.ok(args.indexOf('-threads') < outputIndex);
    assert.equal(args[args.indexOf('-x264-params') + 1], 'threads=2');
    assert.ok(args.indexOf('-x264-params') > lastInputIndex + 1);
    assert.ok(args.indexOf('-x264-params') < outputIndex);
    assert.equal(outputIndex, args.length - 1);
  }
});

test('ffmpeg builder uses explicit thread options and never reads the environment', () => {
  const previous = process.env.REACT_FFMPEG_THREADS;
  try {
    process.env.REACT_FFMPEG_THREADS = '12';
    const defaults = buildFfmpegArgs(options());
    assert.equal(defaults[defaults.indexOf('-threads') + 1], '2');
    const args = buildFfmpegArgs(options({ threads: 4 }));
    for (const flag of ['-threads', '-filter_threads', '-filter_complex_threads']) {
      assert.equal(args[args.indexOf(flag) + 1], '4');
    }
    assert.equal(args[args.indexOf('-x264-params') + 1], 'threads=4');
  } finally {
    if (previous === undefined) delete process.env.REACT_FFMPEG_THREADS;
    else process.env.REACT_FFMPEG_THREADS = previous;
  }
});

test('ffmpeg thread resolver rejects invalid values and clamps positive integers', () => {
  for (const value of [undefined, null, '', ' ', 'no', '2bad', 0, '0', -1, '-1', 1.5, '1.5',
    NaN, Infinity, 'Infinity', true, {}, []]) {
    assert.equal(resolveFfmpegThreads(value), 2, String(value));
  }
  for (const [value, expected] of [[1, 1], ['3', 3], [16, 16], ['17', 16], [100, 16]]) {
    assert.equal(resolveFfmpegThreads(value), expected, String(value));
  }
});

test('negative sync seeks only the reference input and does not delay audio or video', () => {
  const args = buildFfmpegArgs(options({ syncMs: -2500 }));
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2), ['-ss', '2.5']);
  assert.ok(args.indexOf('-ss') > args.indexOf('/tmp/raw.mp4'));
  assert.ok(args.indexOf('-ss') < args.indexOf('/tmp/reference.mp4'));
  assert.ok(!args.includes('-itsoffset'));
  assert.doesNotMatch(filter(args), /adelay|start_duration/);
});

test('solo ffmpeg graph contains only her portrait video and microphone', () => {
  const args = buildFfmpegArgs(options({ output: 'solo', syncMs: 500 }));
  assert.match(filter(args), /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/);
  assert.match(filter(args), /\[0:a\]/);
  assert.doesNotMatch(filter(args), /\[1:|vstack|amix/);
  assert.equal(args.filter(arg => arg === '-i').length, 1);
});

test('audio graphs handle disabled reference audio, missing input audio and silence', () => {
  for (const overrides of [{ referenceAudio: false }, { referenceHasAudio: false }]) {
    const graph = filter(buildFfmpegArgs(options(overrides)));
    assert.match(graph, /\[0:a\]/);
    assert.doesNotMatch(graph, /\[1:a\]|amix/);
  }
  const refOnly = filter(buildFfmpegArgs(options({ rawHasAudio: false, syncMs: 500 })));
  assert.match(refOnly, /\[1:a\].*adelay=500:all=1/);
  assert.doesNotMatch(refOnly, /\[0:a\]|amix/);
  const silence = filter(buildFfmpegArgs(options({ rawHasAudio: false, referenceHasAudio: false })));
  assert.match(silence, /anullsrc=r=48000:cl=stereo,atrim=duration=3\[a\]/);
  assert.doesNotMatch(silence, /\[0:a\]|\[1:a\]/);
  const soloSilence = filter(buildFfmpegArgs(options({ output: 'solo', rawHasAudio: false })));
  assert.match(soloSilence, /anullsrc=/);
  assert.doesNotMatch(soloSilence, /\[1:a\]/);
});

test('ffmpeg graph rejects nonfinite duration and unsafe graph values', () => {
  for (const overrides of [{ rawDuration: Infinity }, { rawDuration: 0 }, { syncMs: NaN },
    { crop: { top: 0, height: '0.5;unsafe' } }, { crop: { top: 0.8, height: 0.5 } }]) {
    assert.throws(() => buildFfmpegArgs(options(overrides)), /invalid_render_options/);
  }
});

function fakeSpawn({ stdout = '', code = 0, hang = false, pid = 43210 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new PassThrough();
    child.kill = signal => {
      calls.push({ signal });
      process.nextTick(() => child.emit('close', null));
    };
    calls.push({ command, args, spawnOptions });
    if (!hang) process.nextTick(() => {
      child.stdout.end(stdout);
      child.emit('close', code);
    });
    return child;
  };
  return { calls, spawnImpl, setPriorityImpl: () => {} };
}

test('renderVideo resolves thread caps from environment and execution options', async () => {
  for (const [envValue, expected] of [[undefined, '2'], ['4', '4'], ['', '2'], ['0', '2'],
    ['-1', '2'], ['1.5', '2'], ['invalid', '2'], ['100', '16']]) {
    const fake = fakeSpawn();
    await renderVideo(options({ threads: 16 }), { ...fake, env: { REACT_FFMPEG_THREADS: envValue } });
    const args = fake.calls[0].args;
    for (const flag of ['-threads', '-filter_threads', '-filter_complex_threads']) {
      assert.equal(args[args.indexOf(flag) + 1], expected, String(envValue));
    }
    assert.equal(args[args.indexOf('-x264-params') + 1], `threads=${expected}`);
  }
  const fake = fakeSpawn();
  await renderVideo(options(), { ...fake, env: { REACT_FFMPEG_THREADS: '4' }, threads: 3 });
  const args = fake.calls[0].args;
  assert.equal(args[args.indexOf('-threads') + 1], '3');
});

test('probeVideo reads metadata and supports the configured binary', async () => {
  const fake = fakeSpawn({ stdout: JSON.stringify({ format: { duration: '3.000' },
    streams: [{ codec_type: 'video', width: 720, height: 1280 }, { codec_type: 'audio' }] }) });
  assert.deepEqual(await probeVideo('/tmp/raw.mp4', { ffprobePath: '/custom/ffprobe', ...fake }),
    { durationSec: 3, hasAudio: true, width: 720, height: 1280 });
  assert.equal(fake.calls[0].command, '/custom/ffprobe');
  assert.ok(fake.calls[0].args.includes('file,pipe'));
});

test('probeVideo rejects invalid metadata with static, secret-free errors', async () => {
  for (const stdout of ['https://secret.example/token', 'null', '{}', '{"streams":{}}', '{"streams":[]}',
    '{"format":{"duration":"NaN"},"streams":[{"codec_type":"video","width":1,"height":1}]}']) {
    await assert.rejects(probeVideo('/tmp/raw.mp4', fakeSpawn({ stdout })), /^Error: invalid_video$/);
  }
});

test('renderVideo times out, kills the process and never exposes child failure output', async () => {
  const fake = fakeSpawn({ hang: true });
  await assert.rejects(renderVideo(options(), { ffmpegPath: '/custom/ffmpeg', timeoutMs: 10, ...fake }),
    /^Error: ffmpeg_timeout$/);
  assert.equal(fake.calls[0].command, '/custom/ffmpeg');
  assert.equal(fake.calls[1].signal, 'SIGKILL');
  await assert.rejects(renderVideo(options(), fakeSpawn({ stdout: 'https://secret.example/token', code: 1 })),
    /^Error: ffmpeg_failed$/);
});

test('process startup failures, probe timeouts and oversized output remain bounded and secret-free', async () => {
  const spawnImpl = () => { throw new Error('https://secret.example/token'); };
  await assert.rejects(renderVideo(options(), { spawnImpl }), /^Error: ffmpeg_failed$/);
  await assert.rejects(probeVideo('/tmp/raw.mp4', { spawnImpl }), /^Error: ffprobe_failed$/);
  const hanging = fakeSpawn({ hang: true });
  await assert.rejects(probeVideo('/tmp/raw.mp4', { timeoutMs: 10, ...hanging }), /^Error: ffprobe_timeout$/);
  assert.equal(hanging.calls[1].signal, 'SIGKILL');
  await assert.rejects(probeVideo('/tmp/raw.mp4', fakeSpawn({ stdout: 'x'.repeat(1024 * 1024 + 1) })),
    /^Error: ffprobe_invalid_output$/);
});

test('ffmpeg and ffprobe lower child CPU priority by default', async () => {
  for (const command of ['ffmpeg', 'ffprobe']) {
    const priorities = [];
    const fake = fakeSpawn({ stdout: JSON.stringify({ format: { duration: '3' },
      streams: [{ codec_type: 'video', width: 720, height: 1280 }] }) });
    const runOptions = { ...fake, env: {}, setPriorityImpl: (...args) => priorities.push(args) };
    if (command === 'ffmpeg') await renderVideo(options(), runOptions);
    else await probeVideo('/tmp/raw.mp4', runOptions);
    assert.deepEqual(priorities, [[43210, 10]], command);
  }
});

test('priority failures never fail ffmpeg or ffprobe', async () => {
  for (const code of ['EPERM', 'ESRCH', 'ENOSYS']) {
    for (const command of ['ffmpeg', 'ffprobe']) {
      const fake = fakeSpawn({ stdout: JSON.stringify({ format: { duration: '3' },
        streams: [{ codec_type: 'video', width: 720, height: 1280 }] }) });
      let attempts = 0;
      const runOptions = { ...fake, env: {}, setPriorityImpl: () => {
        attempts++;
        throw Object.assign(new Error('priority unavailable'), { code });
      } };
      if (command === 'ffmpeg') await renderVideo(options(), runOptions);
      else await probeVideo('/tmp/raw.mp4', runOptions);
      assert.equal(attempts, 1, `${command}: ${code}`);
    }
  }
});

test('priority accepts configured values, rejects unsafe values and allows disabling', async () => {
  for (const [configured, expected] of [['0', null], ['1', 1], ['19', 19], ['6', 6],
    ['', 10], ['bad', 10], ['1.5', 10], ['-1', 10], ['20', 10], ['Infinity', 10]]) {
    const priorities = [];
    await renderVideo(options(), { ...fakeSpawn(), env: { REACT_FFMPEG_NICE: configured },
      setPriorityImpl: (...args) => priorities.push(args) });
    assert.deepEqual(priorities, expected === null ? [] : [[43210, expected]], configured);
  }
  const priorities = [];
  await probeVideo('/tmp/raw.mp4', { ...fakeSpawn({ stdout: JSON.stringify({ format: { duration: '3' },
    streams: [{ codec_type: 'video', width: 720, height: 1280 }] }) }),
  nice: 0, env: { REACT_FFMPEG_NICE: '10' }, setPriorityImpl: (...args) => priorities.push(args) });
  assert.deepEqual(priorities, []);
});

test('priority never targets the parent process when spawn has no positive child pid', async () => {
  for (const pid of [undefined, null, 0, -1, NaN]) {
    const priorities = [];
    const spawnImpl = (...args) => {
      const child = fakeSpawn().spawnImpl(...args);
      child.pid = pid;
      return child;
    };
    await renderVideo(options(), { spawnImpl, env: {}, setPriorityImpl: (...args) => priorities.push(args) });
    assert.deepEqual(priorities, []);
  }
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
test('real ffmpeg renders 3s raw and 4s reference to portrait H264/AAC with positive sync',
  { skip: !ffmpegAvailable, timeout: 120000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'react-ffmpeg-test-'));
    const rawPath = path.join(directory, 'raw.mp4');
    const referencePath = path.join(directory, 'reference.mp4');
    const outputPath = path.join(directory, 'output.mp4');
    try {
      for (const [file, source, sine, duration] of [
        [rawPath, 'testsrc=size=720x1280:rate=30', '440', '3'],
        [referencePath, 'testsrc2=size=1080x1920:rate=30', '880', '4'],
      ]) {
        const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-f', 'lavfi', '-i', source, '-f', 'lavfi', '-i', `sine=frequency=${sine}:sample_rate=48000`,
          '-t', duration, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file],
        { encoding: 'utf8', timeout: 45000 });
        assert.equal(result.status, 0, result.stderr);
      }
      const raw = await probeVideo(rawPath);
      const reference = await probeVideo(referencePath);
      await renderVideo(options({ rawPath, referencePath, outputPath, rawDuration: raw.durationSec,
        rawHasAudio: raw.hasAudio, referenceHasAudio: reference.hasAudio, syncMs: 500 }), { timeoutMs: 60000 });
      const result = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath],
        { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const info = JSON.parse(result.stdout);
      const video = info.streams.find(stream => stream.codec_type === 'video');
      const audio = info.streams.filter(stream => stream.codec_type === 'audio');
      assert.equal(video.width, 1080);
      assert.equal(video.height, 1920);
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.pix_fmt, 'yuv420p');
      assert.equal(video.r_frame_rate, '30/1');
      assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.15, info.format.duration);
      assert.equal(audio.length, 1);
      assert.equal(audio[0].codec_name, 'aac');

      function decodedSample(file, at, filterGraph) {
        const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file,
          '-frames:v', '1', '-vf', filterGraph, '-f', 'rawvideo', 'pipe:1'], { timeout: 10000 });
        assert.equal(decoded.status, 0, decoded.stderr.toString());
        assert.equal(decoded.stdout.length, 32 * 32);
        return decoded.stdout;
      }
      function difference(left, right) {
        return left.reduce((total, pixel, index) => total + Math.abs(pixel - right[index]), 0) / left.length;
      }
      const topFilter = 'crop=1080:960:0:0,scale=32:32,format=gray';
      const first = decodedSample(outputPath, 0.1, topFilter);
      const stillPadded = decodedSample(outputPath, 0.4, topFilter);
      const moving = decodedSample(outputPath, 0.8, topFilter);
      const referenceAtCorrectOffset = decodedSample(referencePath, 0.3,
        'crop=iw:ih*0.5:0:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,scale=32:32,format=gray');
      assert.ok(difference(first, stillPadded) < 1, 'top must clone the first reference frame during the offset');
      assert.ok(difference(first, moving) > 2, 'reference must advance after the offset');
      assert.ok(difference(moving, referenceAtCorrectOffset) < 2, 'reference must advance by t minus the offset');

      function audioAmplitudes(at) {
        const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', outputPath,
          '-t', '0.1', '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { timeout: 10000 });
        assert.equal(decoded.status, 0, decoded.stderr.toString());
        const samples = decoded.stdout.length / 4;
        assert.ok(samples > 0);
        return [440, 880].map(frequency => {
          let real = 0;
          let imaginary = 0;
          for (let index = 0; index < samples; index++) {
            const phase = 2 * Math.PI * frequency * index / 48000;
            const sample = decoded.stdout.readFloatLE(index * 4);
            real += sample * Math.cos(phase);
            imaginary += sample * Math.sin(phase);
          }
          return Math.hypot(real, imaginary) * 2 / samples;
        });
      }
      const earlyAudio = audioAmplitudes(0.1);
      const mixedAudio = audioAmplitudes(0.8);
      assert.ok(earlyAudio[0] > 0.05, 'her microphone must play before the reference starts');
      assert.ok(earlyAudio[1] < earlyAudio[0] * 0.05, 'reference audio must be silent during the offset');
      assert.ok(mixedAudio[1] > mixedAudio[0] * 0.4, 'reference audio must join after the offset');

      const silentRaw = path.join(directory, 'raw-no-audio.mp4');
      const silentReference = path.join(directory, 'reference-no-audio.mp4');
      for (const [source, destination] of [[rawPath, silentRaw], [referencePath, silentReference]]) {
        const stripped = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', source,
          '-map', '0:v', '-c:v', 'copy', '-an', destination], { encoding: 'utf8', timeout: 10000 });
        assert.equal(stripped.status, 0, stripped.stderr);
        assert.equal((await probeVideo(destination)).hasAudio, false);
      }
      for (const overrides of [
        { rawPath: silentRaw, rawHasAudio: false },
        { referencePath: silentReference, referenceHasAudio: false, syncMs: -500 },
        { rawPath: silentRaw, rawHasAudio: false, referencePath: silentReference, referenceHasAudio: false },
        { rawPath: silentRaw, rawHasAudio: false, output: 'solo' },
      ]) {
        await renderVideo(options({ rawPath, referencePath, outputPath, rawDuration: 0.5, ...overrides }),
          { timeoutMs: 60000 });
        const rendered = await probeVideo(outputPath);
        assert.equal(rendered.width, 1080);
        assert.equal(rendered.height, 1920);
        assert.equal(rendered.hasAudio, true);
        assert.ok(Math.abs(rendered.durationSec - 0.5) < 0.15);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
