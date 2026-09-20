/**
 * Terminal rendering. Colours are dropped when stdout is not a TTY, when
 * NO_COLOR is set, or when TERM is "dumb".
 */

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  (process.env.FORCE_COLOR !== undefined || Boolean(process.stdout.isTTY));

const wrap = (open, close) => (text) => (enabled ? `[${open}m${text}[${close}m` : String(text));

export const color = {
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  green: wrap(32, 39),
  grey: wrap(90, 39),
  bold: wrap(1, 22),
};

const BADGE = {
  deny: () => color.bold(color.red(' DENY ')),
  ask: () => color.bold(color.yellow(' ASK  ')),
  warn: () => color.bold(color.blue(' WARN ')),
  allow: () => color.bold(color.green(' OK   ')),
};

const MARK = { deny: '✖', ask: '▲', warn: '•' };

/**
 * Render an evaluation result as a short human report.
 *
 * @param {import('./engine.js').Finding[]} findings
 * @returns {string}
 */
export function renderReport(result, { verbose = false } = {}) {
  const lines = [];
  const headline = result.decision === 'allow' && result.findings.length ? 'warn' : result.decision;
  lines.push(`${BADGE[headline]()} ${color.bold(truncate(result.command, 96))}`);

  if (!result.findings.length) {
    lines.push(color.grey(result.allowlisted ? '       allow-listed by project config' : '       no rule matched'));
    return lines.join('\n');
  }

  for (const finding of result.findings) {
    const tint = finding.severity === 'deny' ? color.red : finding.severity === 'ask' ? color.yellow : color.blue;
    lines.push('');
    lines.push(`  ${tint(MARK[finding.severity] ?? '•')} ${color.bold(finding.title)} ${color.grey(`[${finding.id}]`)}`);
    if (finding.detail) lines.push(`    ${color.grey(finding.detail)}`);
    lines.push(`    ${color.grey('why')}   ${finding.why}`);
    if (finding.safer) lines.push(`    ${color.grey('safer')} ${finding.safer}`);
    if (verbose && finding.segment !== result.command) {
      lines.push(`    ${color.grey('in')}    ${truncate(finding.segment, 88)}`);
    }
  }

  return lines.join('\n');
}

/** One-line reason, used for hook output and CI logs. */
export function renderReason(result) {
  if (!result.findings.length) return 'No cmdguard rule matched.';
  const blocking = result.findings.filter((f) => f.severity !== 'warn');
  const shown = (blocking.length ? blocking : result.findings).slice(0, 3);
  const parts = shown.map((finding) => {
    const safer = finding.safer ? ` Safer: ${finding.safer}` : '';
    const detail = finding.detail ? ` (${finding.detail})` : '';
    return `${finding.title}${detail} [${finding.id}] — ${finding.why}${safer}`;
  });
  const extra = result.findings.length > shown.length ? ` (+${result.findings.length - shown.length} more)` : '';
  return `cmdguard: ${parts.join(' | ')}${extra}`;
}

export function truncate(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
