/**
 * The decision engine: command line in, decision + findings out.
 */

import { normalize, nestedCommands, splitSegments } from './parse.js';
import { rules as builtinRules } from './rules.js';
import { defaultConfig, SEVERITIES } from './config.js';

const RANK = { off: 0, warn: 1, ask: 2, deny: 3 };
const MAX_NESTING = 4;

/**
 * @typedef {object} Finding
 * @property {string} id
 * @property {'warn'|'ask'|'deny'} severity
 * @property {string} title
 * @property {string} why
 * @property {string} [safer]
 * @property {string} [detail]
 * @property {string} segment the command the rule matched on
 */

/**
 * Evaluate a command line.
 *
 * @param {string} command
 * @param {object} [config]
 * @param {object} [options]
 * @param {Array} [options.rules] override the rule set (used by tests)
 * @returns {{ command: string, decision: 'allow'|'ask'|'deny', findings: Finding[], segments: string[], allowlisted: boolean }}
 */
export function evaluate(command, config = defaultConfig, options = {}) {
  const settings = { ...defaultConfig, ...config };
  const ruleSet = options.rules ?? builtinRules;
  const line = typeof command === 'string' ? command : '';

  if (!line.trim()) {
    return { command: line, decision: 'allow', findings: [], segments: [], allowlisted: false };
  }

  if (settings.allow.some((pattern) => new RegExp(pattern, 'i').test(line))) {
    return { command: line, decision: 'allow', findings: [], segments: [], allowlisted: true };
  }

  const segments = collectSegments(line);
  const parsedSegments = segments.map((segment) => normalize(segment));
  const findings = [];

  for (const rule of ruleSet) {
    const severity = resolveSeverity(rule, settings);
    if (severity === 'off') continue;

    if (rule.scope === 'line') {
      const result = runTest(rule, { line, segments, parsedSegments });
      if (result) findings.push(toFinding(rule, severity, result, line, settings));
      continue;
    }

    for (const parsed of parsedSegments) {
      const result = runTest(rule, { ...parsed, line });
      if (result) {
        findings.push(toFinding(rule, severity, result, parsed.raw, settings));
        break; // one report per rule is enough
      }
    }
  }

  findings.push(...customPatternFindings(line, settings));
  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]);

  const worst = findings.reduce((acc, finding) => Math.max(acc, RANK[finding.severity]), 0);
  const decision = worst >= RANK.deny ? 'deny' : worst >= RANK.ask ? 'ask' : 'allow';

  return { command: line, decision, findings, segments, allowlisted: false };
}

/**
 * Expand a command line into every command it can run, following
 * `bash -c`, `ssh host …` and `eval` up to a small nesting depth.
 */
function collectSegments(line, depth = 0, seen = new Set()) {
  const out = [];
  for (const segment of splitSegments(line)) {
    if (seen.has(segment)) continue;
    seen.add(segment);
    out.push(segment);

    if (depth >= MAX_NESTING) continue;
    for (const inner of nestedCommands(normalize(segment))) {
      out.push(...collectSegments(inner, depth + 1, seen));
    }
  }
  return out;
}

function runTest(rule, context) {
  try {
    return rule.test(context);
  } catch {
    return false; // a broken rule must never break the guard
  }
}

function toFinding(rule, severity, result, segment, settings) {
  const override = typeof result === 'object' && result.severity;
  const effective = override && !settings.rules[rule.id] ? clamp(result.severity, settings) : severity;
  return {
    id: rule.id,
    severity: effective,
    title: rule.title,
    why: rule.why,
    safer: rule.safer,
    tags: rule.tags ?? [],
    detail: typeof result === 'object' ? result.detail : undefined,
    segment,
  };
}

function customPatternFindings(line, settings) {
  const findings = [];
  for (const severity of ['deny', 'ask', 'warn']) {
    for (const pattern of settings[severity]) {
      if (!new RegExp(pattern, 'i').test(line)) continue;
      findings.push({
        id: `custom.${severity}`,
        severity: clamp(severity, settings),
        title: 'Matched a project rule',
        why: `The project configuration marks /${pattern}/ as ${severity}.`,
        tags: ['custom'],
        detail: `pattern: /${pattern}/`,
        segment: line,
      });
    }
  }
  return findings.filter((finding) => finding.severity !== 'off');
}

/** Per-rule override first, then the profile. */
function resolveSeverity(rule, settings) {
  const override = settings.rules?.[rule.id];
  if (override) return override;
  return clamp(rule.severity, settings);
}

function clamp(severity, settings) {
  const index = SEVERITIES.indexOf(severity);
  if (index < 0) return severity;
  if (settings.profile === 'strict') return SEVERITIES[Math.min(index + 1, SEVERITIES.length - 1)];
  if (settings.profile === 'loose') return SEVERITIES[Math.max(index - 1, 0)];
  return severity;
}

export const EXIT_CODES = { allow: 0, ask: 1, deny: 2, usage: 64 };
