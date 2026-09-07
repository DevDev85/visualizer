// Soundbank render worker: libfluidsynth (WASM, libsndfile build so SF3 /
// ogg banks load too) driven by js-synthesizer. The main thread sends the
// backing-band notes of one loop window as timed MIDI events; this renders
// them offline, block by block, into stereo float PCM and posts it back.
// Same events + same bank = bit-identical audio, so the live preview and
// the export hear exactly the same take.
/* global JSSynth, Module */
importScripts('/fluidsynth.js', '/js-synth.js');

let synth = null;
let sfontId = -1;
let rate = 48000;
const BLOCK = 256; // frames per render call → 5.3 ms event resolution at 48 kHz

async function load(msg) {
  await JSSynth.waitForReady();
  JSSynth.disableLogging(); // the WASM build logs harmless "function X is a stub" lines on every file probe
  rate = msg.sampleRate || 48000;
  if (synth) { try { synth.close(); } catch { /* fine */ } }
  synth = new JSSynth.Synthesizer();
  synth.init(rate, {
    polyphony: 512,
    reverbActive: true, reverbRoomSize: 0.42, reverbDamp: 0.25, reverbWidth: 0.7, reverbLevel: 0.32,
    chorusActive: false,
    midiBankSelect: 'gs',
    minNoteLength: 4,
    initialGain: 0.6,
  });
  synth.setInterpolation(7); // 7th-order sinc: the cleanest resampling fluidsynth has
  synth.setGain(Number.isFinite(msg.gain) ? msg.gain : 0.6); // per-bank level trim
  // stream the bank so the UI can show progress (these files are 40–220 MB)
  const resp = await fetch(msg.url);
  if (!resp.ok) throw new Error(`Soundbank HTTP ${resp.status}`);
  const total = Number(resp.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) postMessage({ type: 'progress', phase: 'download', p: got / total });
  }
  const bin = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { bin.set(c, o); o += c.length; }
  postMessage({ type: 'progress', phase: 'parse', p: 1 });
  sfontId = await synth.loadSFont(bin.buffer);
  return { sfontId };
}

// events: [{ t, kind: 'on'|'off'|'bend'|'pc'|'sens', chan, key, vel, val, bank, prog }] sorted by t
function render(msg) {
  if (!synth || sfontId < 0) throw new Error('Soundbank not loaded');
  const seconds = Math.max(0.5, Math.min(1800, msg.seconds || 1));
  const frames = Math.ceil(seconds * rate);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const evs = msg.events || [];
  // fresh state: silence every channel, plain GM programs
  synth.midiAllNotesOff();
  for (let c = 0; c < 16; c++) { synth.midiControl(c, 121, 0); synth.midiPitchBend(c, 8192); }
  const blockL = new Float32Array(BLOCK);
  const blockR = new Float32Array(BLOCK);
  let ei = 0;
  for (let pos = 0; pos < frames; pos += BLOCK) {
    const tEnd = (pos + BLOCK) / rate;
    while (ei < evs.length && evs[ei].t < tEnd) {
      const e = evs[ei++];
      switch (e.kind) {
        case 'pc':
          synth.midiProgramSelect(e.chan, sfontId, e.bank || 0, e.prog || 0);
          break;
        case 'sens':
          synth.midiPitchWheelSensitivity(e.chan, e.val);
          break;
        case 'on':
          synth.midiNoteOn(e.chan, e.key, e.vel);
          break;
        case 'off':
          synth.midiNoteOff(e.chan, e.key);
          break;
        case 'bend':
          synth.midiPitchBend(e.chan, e.val);
          break;
        case 'cc':
          synth.midiControl(e.chan, e.ctrl, e.val);
          break;
        default:
      }
    }
    synth.render([blockL, blockR]);
    const n = Math.min(BLOCK, frames - pos);
    L.set(n === BLOCK ? blockL : blockL.subarray(0, n), pos);
    R.set(n === BLOCK ? blockR : blockR.subarray(0, n), pos);
    if ((pos / BLOCK) % 400 === 0) postMessage({ type: 'progress', phase: 'render', p: pos / frames, jobTag: msg.tag });
  }
  synth.midiAllNotesOff();
  return { L, R, rate };
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const r = await load(m);
      postMessage({ type: 'loaded', jobId: m.jobId, ...r });
    } else if (m.type === 'render') {
      const r = render(m);
      postMessage({ type: 'rendered', jobId: m.jobId, tag: m.tag, L: r.L, R: r.R, rate: r.rate }, [r.L.buffer, r.R.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', jobId: m.jobId, message: String(err?.message || err) });
  }
};
