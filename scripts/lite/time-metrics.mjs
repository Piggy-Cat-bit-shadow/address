export const parseElapsed = (value) => {
  const parts = String(value || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  return Math.round(parts[0] * 1000);
};

export const parseTimeMetrics = (text) => {
  const rss = String(text).match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
  const elapsed = String(text).match(/Elapsed \(wall clock\) time \([^)]*\):\s*([0-9:.]+)/u);
  return {
    peakRssKiB: rss ? Number(rss[1]) : null,
    peakRssMiB: rss ? Math.round(Number(rss[1]) / 1024) : null,
    wallClockMs: elapsed ? parseElapsed(elapsed[1]) : null
  };
};
