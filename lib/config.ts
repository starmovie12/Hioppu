export const VPS_BASE_URL  = process.env.VPS_BASE_URL  || 'http://85.121.5.246';
export const HUBCLOUD_PORT = process.env.HUBCLOUD_PORT || '5001';
export const TIMER_PORT    = process.env.TIMER_PORT    || '10000';
export const HUBCLOUD_API  = `${VPS_BASE_URL}:${HUBCLOUD_PORT}`;
export const TIMER_API     = `${VPS_BASE_URL}:${TIMER_PORT}`;

export const TIMER_DOMAINS  = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'] as const;
export const TARGET_DOMAINS = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud', 'gdflix', 'drivehub'] as const;

export const AXIOS_TIMEOUT_MS   = 20_000;
export const LINK_TIMEOUT_MS    = 25_000;
export const OVERALL_TIMEOUT_MS = 50_000;

export const MAX_RETRY_ATTEMPTS      = 2;
export const STUCK_TASK_THRESHOLD_MS = 10 * 60 * 1_000;
export const MAX_CRON_RETRIES        = 3;
export const TASK_POLL_INTERVAL_MS   = 5_000;

export const JUNK_DOMAINS = [
  'catimages', 'imdb.com', 'googleusercontent', 'instagram.com',
  'facebook.com', 'wp-content', 'wpshopmart',
] as const;

export const JUNK_LINK_TEXTS = [
  'how to download', '[how to download]', 'how to watch', '[how to watch]',
  'join telegram', 'join our telegram', 'request movie',
  '4k | sdr | hevc', '4k | sdr', 'sdr | hevc',
] as const;

export const JUNK_LINK_EXACT_TEXTS = [
  '4k',
  'sdr',
  'hevc',
  'download',
  'watch',
  'click here',
  'link',
] as const;

export const VALID_LANGUAGES = [
  'Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam',
  'Kannada', 'Punjabi', 'Marathi', 'Bengali', 'Spanish',
  'French', 'Korean', 'Japanese', 'Chinese',
] as const;

export const FORMAT_PRIORITY: Record<string, number> = {
  'WEB-DL': 5, 'BluRay': 4, 'WEBRip': 3, 'HEVC': 2, 'x264': 1, 'HDTC': 0, '10Bit': 0,
};

export const HUBCLOUD_TLDS = ['.foo', '.fans', '.dev', '.cloud', '.icu', '.lol', '.art', '.in', '.store'] as const;
export const HUBDRIVE_TLDS = ['.space', '.pro', '.in'] as const;

export const CDN_DOMAINS = [
  'hubcdn', 'hubdrive', 'gadgetsweb', 'hubstream', 'hdstream',
  'hblinks', 'hubcloud', 'gdflix', 'drivehub',
] as const;

export function isTimerDomain(url: string): boolean {
  const lower = url.toLowerCase();
  return TIMER_DOMAINS.some((d) => lower.includes(d));
}

export function isTargetDomain(url: string): boolean {
  const lower = url.toLowerCase();
  return TARGET_DOMAINS.some((d) => lower.includes(d));
}

export function isJunkLinkText(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (JUNK_LINK_TEXTS.some((j) => lower.includes(j))) return true;
  if (JUNK_LINK_EXACT_TEXTS.some((j) => lower === j)) return true;
  return false;
}

export function isJunkDomain(url: string): boolean {
  const lower = url.toLowerCase();
  return JUNK_DOMAINS.some((d) => lower.includes(d));
}
