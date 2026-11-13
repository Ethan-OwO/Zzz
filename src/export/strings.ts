// Every human-readable string of report.md / prompt.md / notes / duration units (design_M6-M7 §6.3.1).
// Pure. To add a language, write another ExportStrings; nothing else changes.
// Callers pass already formatted values (clock strings, durations), so this file imports no runtime code.
import type { Gap, ItemClass, NightReport, ReportNote } from '../report/types.ts';

export interface PromptContext {
  hasAudio: boolean;   // night.wav is in the zip
  hasMotion: boolean;  // the report has motion data
  mode: 'formal' | 'test';
}

export interface ExportStrings {
  locale: string;
  // units (format.ts)
  durSec(sec: number): string;
  durMin(min: number): string;
  durHourMin(h: number, mm: string): string;
  classLabel: Record<ItemClass, string>;
  modeLabel: Record<NightReport['mode'], string>;
  placementLabel: Record<NightReport['placement'], string>;
  gapReason: Record<Gap['reason'], string>;
  userLabel: Record<string, string>;        // raw label value → text; unknown values are shown as is
  note(n: ReportNote, fmtMin: (min: number) => string): string;

  // report.md
  mdTitle(date: string): string;
  mdMonitored(from: string, to: string, dur: string, unmonitored: string | null): string;
  mdModeLine(mode: string, placement: string, tz: string): string;
  mdCalibration(floor: string, speech: string, margin: string): string;
  mdNoCalibration: string;
  hSummary: string; hNotes: string; hGaps: string; hRestless: string; hEvents: string; hFloor: string; hFiles: string;
  thSummary: [string, string, string];
  thGaps: [string, string, string, string];
  thRestless: [string, string, string, string];
  thEvents: [string, string, string, string, string, string, string, string];
  thFloor: [string, string];
  noGaps: string;
  restlessDisclaimer: string;
  motionInsufficient: string;
  noRestless: string;
  noEvents: string;
  noFloor: string;
  noAudio: string;
  eventsTruncated(shown: number, total: number): string;
  episodeBursts(n: number): string;
  fileWav: string; fileJson: string; filePrompt: string;

  // prompt.md
  promptMd(ctx: PromptContext): string;
}

export const ZH_TW: ExportStrings = {
  locale: 'zh-TW',
  durSec: (s) => `${s} 秒`,
  durMin: (m) => `${m} 分`,
  durHourMin: (h, mm) => `${h} 小時 ${mm} 分`,
  classLabel: { snore: '打呼', talk: '說話', other: '其他', unclassified: '未分類' },
  modeLabel: { formal: '正式', test: '測試' },
  placementLabel: { bed: '床上', nightstand: '床頭櫃', mixed: '部分時間在床上' },
  gapReason: {
    'between-sessions': '重新開始之間',
    'timer-gap': '系統暫停了計時',
    'low-frames': '麥克風幾乎沒有送出聲音',
    'no-heartbeat': '沒有運作紀錄',
  },
  userLabel: { snore: '打呼', talk: '說話', other: '其他', unsure: '?', 'not-snore': '不是打呼' },
  note(n, fmtMin) {
    const num = (k: string) => Number(n[k] ?? 0);
    switch (n.code) {
      case 'test-mode': return '這晚是測試模式：觸發門檻較低，打呼也有錄音，事件數會比平常多。';
      case 'gaps': return `有 ${num('n')} 段沒有監測到，共 ${fmtMin(num('min'))}(多半是當機後重新開始、或系統暫停了麥克風)。`;
      case 'unfinished': return `有 ${num('n')} 個事件沒有正常結束，時長可能偏短。`;
      case 'over-budget': return `錄音達到每晚上限(${num('hours')} 小時)後的 ${num('n')} 個事件只有時間，沒有聲音。`;
      case 'dropped-snore': return '正式模式不保存打呼的聲音，只保留時間。';
      case 'unclassified': return `${num('n')} 個事件還沒有分類。`;
      case 'not-medical': return '這份報告只根據手機聽到的聲音和感測到的震動，不是醫療檢查。';
      default: return n.code;
    }
  },

  mdTitle: (date) => `Zzz 睡眠聲音報告 — ${date} 晚上`,
  mdMonitored: (from, to, dur, un) => `- 監測：${from} – ${to}(${dur}${un ? `，未監測 ${un}` : ''})`,
  mdModeLine: (mode, placement, tz) => `- 模式：${mode} · 放置：${placement} · 時區 ${tz}`,
  mdCalibration: (floor, speech, margin) => `- 校準：背景 ${floor}、說話 ${speech}、門檻 ${margin}`,
  mdNoCalibration: '- 校準：無',
  hSummary: '摘要', hNotes: '注意事項', hGaps: '未監測時段', hRestless: '動作較多的時段(疑似淺眠)',
  hEvents: '事件列表', hFloor: '背景聲音', hFiles: '檔案說明',
  thSummary: ['類別', '次數', '總時長'],
  thGaps: ['開始', '結束', '長度', '原因'],
  thRestless: ['開始', '結束', '長度', '有動作的 30 秒區間'],
  thEvents: ['#', '時間', '長度', '類別', '信心', '你的標記', '最大 dB', 'night.wav 位置'],
  thFloor: ['時間', '背景 dB(中位數)'],
  noGaps: '整段都有監測到。',
  restlessDisclaimer: '「疑似淺眠」只是推測：手機只量得到床的震動，判斷不了睡眠深淺。',
  motionInsufficient: '動作資料不足。',
  noRestless: '沒有動作較多的時段。',
  noEvents: '沒有錄到任何事件。',
  noFloor: '沒有背景聲音紀錄。',
  noAudio: '無音訊',
  eventsTruncated: (shown, total) => `只列出前 ${shown} 個(共 ${total} 個),其餘見 data.json。`,
  episodeBursts: (n) => `持續打呼(${n} 聲)`,
  fileWav: '- `night.wav`:這晚所有被錄到的聲音依時間接成一個檔(16 kHz 單聲道),片段之間有 1 秒靜音;每段的位置見上方事件列表。',
  fileJson: '- `data.json`:完整數據(每個事件的時間、音量、分類特徵，以及這份報告的全部數字)。',
  filePrompt: '- `prompt.md`:可以直接貼給 AI 的問題範本。',

  promptMd({ hasAudio, hasMotion, mode }) {
    const L: string[] = [];
    L.push('# 請幫我看看昨晚的睡眠聲音紀錄', '');
    L.push(hasAudio
      ? '附件是 Zzz 在我睡覺時用手機錄下的資料：report.md 是摘要，data.json 是完整數據，night.wav 是所有被錄到的聲音依時間接成的一個檔(片段之間有 1 秒靜音，每段在檔案中的位置見 report.md 的事件列表)。'
      : '附件是 Zzz 在我睡覺時用手機錄下的資料：report.md 是摘要，data.json 是完整數據。這次的檔案沒有附上聲音。');
    L.push('', '## 資料的限制', '');
    L.push('- 這份資料只根據手機聽到的聲音和感測到的震動，不是醫療檢查。');
    L.push('- 「打呼 / 說話 / 其他」的分類是手機上的簡單規則，可能判錯。');
    if (mode === 'formal') L.push('- 這晚是正式模式：打呼只記錄時間，沒有保存聲音。');
    if (hasMotion) L.push('- 「動作較多的時段(疑似淺眠)」只是根據床的震動推測，不是睡眠分期。');
    L.push('', '## 想問的問題', '');
    L.push('1. 整晚的打呼集中在什麼時段?持續多久?');
    L.push(hasAudio ? '2. 說夢話的內容大概是什麼?' : '2. 說話的事件出現在什麼時候?');
    L.push('3. 有沒有反覆出現的聲音?可能是什麼?');
    L.push('4. 背景聲音的變化可能影響睡眠嗎?');
    if (hasMotion) L.push('5. 聲音事件跟動作較多的時段(疑似淺眠)有沒有對應?');
    L.push(`${hasMotion ? 6 : 5}. 有沒有我應該注意、或可以改善的地方?`);
    L.push('', '## 請注意', '');
    L.push('- 請不要做醫療診斷。如果看到需要就醫的跡象，請直接建議我去看醫生。');
    if (hasAudio) L.push('- 如果你無法播放或分析 night.wav,請只根據 report.md 和 data.json 回答，並告訴我哪些問題需要聽音訊才能回答。');
    L.push('');
    return L.join('\n');
  },
};
