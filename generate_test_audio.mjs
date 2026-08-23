import fs from 'fs';

// Generate a rich 30-second 44.1kHz stereo 16-bit WAV file with chords & rhythm
const sampleRate = 44100;
const duration = 30; // 30 seconds
const numChannels = 2;
const bytesPerSample = 2;
const blockAlign = numChannels * bytesPerSample;
const byteRate = sampleRate * blockAlign;
const numSamples = sampleRate * duration;
const dataSize = numSamples * blockAlign;
const fileSize = 36 + dataSize;

const buffer = Buffer.alloc(44 + dataSize);

// RIFF header
buffer.write('RIFF', 0);
buffer.writeUInt32LE(fileSize, 4);
buffer.write('WAVE', 8);

// fmt subchunk
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20); // PCM
buffer.writeUInt16LE(numChannels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(byteRate, 28);
buffer.writeUInt16LE(blockAlign, 32);
buffer.writeUInt16LE(bytesPerSample * 8, 34);

// data subchunk
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

const bpm = 120;
const beatSec = 60 / bpm;

const chords = [
  [261.63, 329.63, 392.00, 523.25], // C major
  [220.00, 261.63, 329.63, 440.00], // A minor
  [174.61, 220.00, 261.63, 349.23], // F major
  [196.00, 246.94, 293.66, 392.00]  // G major
];

for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate;
  const bar = Math.floor(t / (beatSec * 4)) % chords.length;
  const chord = chords[bar];
  const beatInBar = (t % (beatSec * 4)) / beatSec;

  // 1. Kick on every beat
  const kickPhase = (t % beatSec) / beatSec;
  const kick = Math.sin(2 * Math.PI * (120 * Math.exp(-kickPhase * 16) + 40) * t) * Math.exp(-kickPhase * 6) * 0.4;

  // 2. Snare on beats 2 & 4
  let snare = 0;
  if ((beatInBar >= 1 && beatInBar < 2) || (beatInBar >= 3 && beatInBar < 4)) {
    const sPhase = (beatInBar % 2) - 1;
    snare = (Math.random() * 2 - 1) * Math.exp(-sPhase * 10) * 0.2;
  }

  // 3. Acoustic Harmonics pad
  let pad = 0;
  for (let c = 0; c < chord.length; c++) {
    pad += Math.sin(2 * Math.PI * chord[c] * t) * 0.06;
  }

  // 4. Arpeggio melody
  const arpIndex = Math.floor(t / (beatSec / 2)) % chord.length;
  const arpFreq = chord[arpIndex] * 2;
  const arpEnv = Math.exp(-((t % (beatSec / 2)) / (beatSec / 2)) * 4);
  const arp = Math.sin(2 * Math.PI * arpFreq * t) * arpEnv * 0.15;

  const leftVal = Math.max(-1, Math.min(1, kick + snare + pad * 1.1 + arp * 0.9));
  const rightVal = Math.max(-1, Math.min(1, kick + snare + pad * 0.9 + arp * 1.1));

  buffer.writeInt16LE(Math.floor(leftVal * 32767), 44 + i * 4);
  buffer.writeInt16LE(Math.floor(rightVal * 32767), 44 + i * 4 + 2);
}

fs.writeFileSync('/home/aizatfir/Project/Rync432/public/test_music_sample.wav', buffer);
console.log('30-second acoustic test WAV created successfully: public/test_music_sample.wav');
