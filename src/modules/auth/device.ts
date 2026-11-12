const MAX_LABEL_LENGTH = 64;

/**
 * Bounded, human-readable device label for the session listing.
 *
 * The raw user-agent never leaves the server. Detection is intentionally
 * coarse: it is a display hint for the owner, not a security signal.
 */
export function describeUserAgent(value: string | null): string {
  if (!value) return "Unknown device";

  const ua = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512);
  const browser = detectBrowser(ua);
  const platform = detectPlatform(ua);
  return `${browser} on ${platform}`.slice(0, MAX_LABEL_LENGTH);
}

function detectBrowser(ua: string): string {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera/i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung Internet";
  if (/FxiOS/i.test(ua)) return "Firefox";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/CriOS\//i.test(ua)) return "Chrome";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  return "Unknown browser";
}

function detectPlatform(ua: string): string {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown platform";
}
