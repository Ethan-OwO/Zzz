// prompt.md: a question template for any AI (design_M6-M7 §6.3). Pure; the text lives in ExportStrings.
import type { NightReport } from '../report/types.ts';
import { ZH_TW, type ExportStrings } from './strings.ts';
import type { WavPlan } from './wav.ts';

/** With no clips there is no night.wav, so ExportStrings.promptMd leaves out every sentence about it. */
export function renderPromptMd(report: NightReport, plan: WavPlan, s: ExportStrings = ZH_TW): string {
  return `<!-- locale: ${s.locale} -->\n` + s.promptMd({
    hasAudio: plan.clips.length > 0,
    hasMotion: report.motion !== null,
    mode: report.mode,
  });
}
