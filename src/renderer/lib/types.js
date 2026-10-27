import { t } from './i18n.js';

// File-type categories. Indices match scanner/src/types.rs.
export const TYPES = [
  { id: 'other',   c: '#7B8390', fg: '#0E1014', get l() { return t('Other'); } },
  { id: 'video',   c: '#3B82F6', fg: '#071226', get l() { return t('Video'); } },
  { id: 'app',     c: '#EC6FB0', fg: '#2A0718', get l() { return t('Games & apps'); } },
  { id: 'system',  c: '#5B6576', fg: '#F4F6F9', get l() { return t('System'); } },
  { id: 'image',   c: '#F59E0B', fg: '#2A1700', get l() { return t('Images'); } },
  { id: 'archive', c: '#A78BFA', fg: '#170B33', get l() { return t('Archives & disk images'); } },
  { id: 'code',    c: '#34D399', fg: '#05251A', get l() { return t('Code & packages'); } },
  { id: 'audio',   c: '#22C3D8', fg: '#04222A', get l() { return t('Audio'); } },
  { id: 'doc',     c: '#E9D27A', fg: '#2A2205', get l() { return t('Documents'); } },
];
export const TYPE_COUNT = TYPES.length;
export const T = Object.fromEntries(TYPES.map((t, i) => [t.id, i]));

// Only used for display of names the scanner didn't classify (e.g. live "biggest so far").
const EXT = {
  video: 'mp4 mkv avi mov wmv webm m4v flv mpg mpeg m2ts vob',
  image: 'jpg jpeg png gif bmp tif tiff webp heic raw cr2 nef dng psd',
  archive: 'zip rar 7z tar gz iso img vhd vhdx vmdk msi cab',
  audio: 'mp3 wav flac aac ogg m4a wma opus',
  doc: 'pdf doc docx xls xlsx ppt pptx txt md csv epub',
  code: 'js ts py java cs go rs json',
  app: 'exe dll pak',
  system: 'sys log dat tmp etl',
};
const extMap = {};
for (const [k, v] of Object.entries(EXT)) for (const e of v.split(' ')) extMap[e] = T[k];

export function typeOfName(name) {
  const m = /\.([^.\\/]+)$/.exec(name);
  return (m && extMap[m[1].toLowerCase()]) || 0;
}

export const SHADE = 'radial-gradient(ellipse at 30% 22%, rgba(255,255,255,.34), rgba(255,255,255,0) 48%, rgba(0,0,0,.34) 100%)';
