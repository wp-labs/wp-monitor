import type { Theme } from '@/context/ThemeContext';

// Colors are ordered 60°-core-first so the first 6 series get maximum contrast.
// Indices 0-5:   core hues (60° spacing → each is unmistakably different)
// Indices 6-11:  interleaved mid-hues (30° offset, fill in when >6 series)
const PALETTES: Record<Theme, string[]> = {
  'dark-modern': [
    '#FF6B6B', //  0° red      core
    '#FFD43B', // 60° yellow   core
    '#51CF66', // 120° green   core
    '#3BC9DB', // 180° cyan    core
    '#339AF0', // 240° blue    core
    '#F06595', // 300° pink    core
    '#FF922B', // 30° orange   ext
    '#A9E34B', // 90° lime     ext
    '#20C997', // 150° teal    ext
    '#74C0FC', // 210° sky     ext
    '#9775FA', // 270° purple  ext
    '#E599F7', // 330° magenta ext
  ],
  'night-blue': [
    '#FF6B6B', // red     core
    '#FFD43B', // yellow  core
    '#51CF66', // green   core
    '#3BC9DB', // cyan    core
    '#F06595', // pink    core
    '#FF922B', // orange  core (replaces blue — invisible on night-blue bg)
    '#A9E34B', // lime    ext
    '#20C997', // teal    ext
    '#9775FA', // purple  ext
    '#E599F7', // magenta ext
    '#74C0FC', // sky     ext
    '#FFA94D', // amber   ext
  ],
  'light-modern': [
    '#E03131', // red     core
    '#F08C00', // amber   core
    '#2F9E44', // green   core
    '#1098AD', // cyan    core
    '#1971C2', // blue    core
    '#D6336C', // pink    core
    '#E8590C', // orange  ext
    '#74B816', // lime    ext
    '#0C8599', // teal    ext
    '#4263EB', // indigo  ext
    '#7048E8', // purple  ext
    '#AE3EC9', // magenta ext
  ],
};

export const MONITOR_SERIES_PALETTE = PALETTES['dark-modern'];

export function getPalette(theme: Theme): string[] {
  return PALETTES[theme];
}
