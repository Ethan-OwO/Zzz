// English export strings: report.md / prompt.md / notes / duration units. Same shape as ZH_TW.
import type { ExportStrings } from './strings.ts';

const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const EN_US: ExportStrings = {
  locale: 'en-US',
  durSec: (sec) => `${sec} s`,
  durMin: (min) => `${min} min`,
  durHourMin: (h, mm) => `${h} h ${mm} min`,
  classLabel: { snore: 'Snoring', talk: 'Talking', other: 'Other', unclassified: 'Unclassified' },
  modeLabel: { formal: 'Normal', test: 'Test' },
  placementLabel: { bed: 'on the bed', nightstand: 'on the nightstand', mixed: 'on the bed part of the time' },
  gapReason: {
    'between-sessions': 'between restarts',
    'timer-gap': 'the system paused timers',
    'low-frames': 'the microphone sent almost no sound',
    'no-heartbeat': 'no activity record',
  },
  userLabel: { snore: 'Snoring', talk: 'Talking', other: 'Other', unsure: '?', 'not-snore': 'Not snoring' },
  note(n, fmtMin) {
    const num = (k: string) => Number(n[k] ?? 0);
    switch (n.code) {
      case 'test-mode': return 'This night used test mode: the trigger level was lower and snoring was recorded too, so there are more events than usual.';
      case 'gaps': return `${s(num('n'), 'stretch was', 'stretches were')} not monitored, ${fmtMin(num('min'))} in total (usually a restart after a crash, or the system pausing the microphone).`;
      case 'unfinished': return `${s(num('n'), 'event', 'events')} did not end normally, so their length may be too short.`;
      case 'over-budget': return `After the nightly recording limit (${num('hours')} h) was reached, ${s(num('n'), 'event has', 'events have')} times only, no sound.`;
      case 'dropped-snore': return 'Normal mode does not keep the sound of snoring, only its times.';
      case 'unclassified': return `${s(num('n'), 'event is', 'events are')} not classified yet.`;
      case 'not-medical': return 'This report is based only on what the phone heard and the vibration it sensed. It is not a medical test.';
      default: return n.code;
    }
  },

  mdTitle: (date) => `Zzz sleep sound report — night of ${date}`,
  mdMonitored: (from, to, dur, un) => `- Monitored: ${from} – ${to} (${dur}${un ? `, not monitored ${un}` : ''})`,
  mdModeLine: (mode, placement, tz) => `- Mode: ${mode} · Phone: ${placement} · Time zone ${tz}`,
  mdCalibration: (floor, speech, margin) => `- Calibration: background ${floor}, speech ${speech}, trigger ${margin}`,
  mdNoCalibration: '- Calibration: none',
  hSummary: 'Summary', hNotes: 'Notes', hGaps: 'Unmonitored stretches', hRestless: 'Restless stretches (possibly light sleep)',
  hEvents: 'Events', hFloor: 'Background sound', hFiles: 'Files',
  thSummary: ['Class', 'Count', 'Total length'],
  thGaps: ['Start', 'End', 'Length', 'Reason'],
  thRestless: ['Start', 'End', 'Length', '30 s intervals with movement'],
  thEvents: ['#', 'Time', 'Length', 'Class', 'Confidence', 'Your label', 'Peak dB', 'Position in night.wav'],
  thFloor: ['Time', 'Background dB (median)'],
  noGaps: 'The whole night was monitored.',
  restlessDisclaimer: '"Possibly light sleep" is only a guess: the phone can measure the bed\'s vibration, not how deeply you slept.',
  motionInsufficient: 'Not enough motion data.',
  noRestless: 'No restless stretches.',
  noEvents: 'No events were recorded.',
  noFloor: 'No background sound records.',
  noAudio: 'no audio',
  eventsTruncated: (shown, total) => `Only the first ${shown} are listed (${total} in total); see data.json for the rest.`,
  episodeBursts: (n) => `continuous snoring (${s(n, 'snore', 'snores')})`,
  fileWav: '- `night.wav`: every sound recorded this night, joined in time order into one file (16 kHz mono) with 1 s of silence between clips; the position of each clip is in the event list above.',
  fileJson: '- `data.json`: the full data (time, level and classification features of each event, and every number in this report).',
  filePrompt: '- `prompt.md`: a question template you can paste straight into an AI.',

  promptMd({ hasAudio, hasMotion, mode }) {
    const L: string[] = [];
    L.push('# Please look at my sleep sound recording from last night', '');
    L.push(hasAudio
      ? 'Attached is the data Zzz recorded with my phone while I slept: report.md is the summary, data.json is the full data, and night.wav is every recorded sound joined in time order into one file (1 s of silence between clips; the position of each clip in the file is in the event list of report.md).'
      : 'Attached is the data Zzz recorded with my phone while I slept: report.md is the summary and data.json is the full data. No sound is attached this time.');
    L.push('', '## Limits of the data', '');
    L.push('- The data is based only on what the phone heard and the vibration it sensed. It is not a medical test.');
    L.push('- The "snoring / talking / other" classes come from simple rules on the phone and can be wrong.');
    if (mode === 'formal') L.push('- This night used normal mode: snoring was logged by time only, its sound was not kept.');
    if (hasMotion) L.push('- "Restless stretches (possibly light sleep)" are only a guess from the bed\'s vibration, not sleep staging.');
    L.push('', '## Questions', '');
    L.push('1. When during the night was the snoring concentrated? How long did it last?');
    L.push(hasAudio ? '2. Roughly what was said during the sleep talking?' : '2. When did the talking events happen?');
    L.push('3. Are there sounds that come up again and again? What might they be?');
    L.push('4. Could the changes in background sound affect my sleep?');
    if (hasMotion) L.push('5. Do the sound events line up with the restless stretches (possibly light sleep)?');
    L.push(`${hasMotion ? 6 : 5}. Is there anything I should pay attention to or could improve?`);
    L.push('', '## Please note', '');
    L.push('- Please do not make a medical diagnosis. If you see signs that I should see a doctor, tell me so directly.');
    if (hasAudio) L.push('- If you cannot play or analyze night.wav, answer from report.md and data.json only, and tell me which questions need the audio.');
    L.push('');
    return L.join('\n');
  },
};
