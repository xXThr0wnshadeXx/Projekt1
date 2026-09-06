// Local guardrails, not LinkedIn-approved quotas. Keep these independent of maps.
export const MIN_INTERVAL = 120_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const HOURLY_ACTIONS = 25;
export const DAILY_ACTIONS = 150;
export const RESTRICTION_COOLDOWN = 15 * 60_000;

export function normalizePolicy(value = {}, now = Date.now()) {
  return {
    nextAt: Number.isFinite(value.nextAt) ? value.nextAt : 0,
    actions: (Array.isArray(value.actions) ? value.actions : [])
      .filter(at => Number.isFinite(at) && at > now - DAY).sort((a, b) => a - b),
    failures: Math.max(0, Number(value.failures) || 0),
    blocked: value.blocked || null,
    startup: value.startup&&typeof value.startup.id==='string'&&Number.isInteger(value.startup.used)&&value.startup.used>=0&&value.startup.used<=2?{...value.startup}:null,
  };
}

export function beginRun(policy,id,now=Date.now()){
  return {...normalizePolicy(policy,now),startup:{id,used:0}};
}
export function nextAction(policy, delay, now = Date.now(), runId) {
  const p = normalizePolicy(policy, now);
  const hour = p.actions.filter(at => at > now - HOUR);
  const interval = Math.max(MIN_INTERVAL, (Number(delay) || 120) * 1000);
  let at = Math.max(now, p.nextAt, p.actions.length ? p.actions.at(-1) + interval : 0);
  // Only the second action in this exact run may use the startup allowance.
  // Restrictions/backoff invalidate it; ordinary map changes cannot spend it.
  if(runId&&p.startup?.id===runId&&p.startup.used===1&&!p.blocked&&!p.failures)at=now;
  let reason = 'Minimum interval between LinkedIn actions';
  if (hour.length >= HOURLY_ACTIONS) {
    const until = hour[hour.length - HOURLY_ACTIONS] + HOUR;
    if (until > at) { at = until; reason = 'Hourly collection budget'; }
  }
  if (p.actions.length >= DAILY_ACTIONS) {
    const until = p.actions[p.actions.length - DAILY_ACTIONS] + DAY;
    if (until > at) { at = until; reason = 'Daily collection budget'; }
  }
  return { at, reason, interval };
}

export function reserveAction(policy, delay, now = Date.now(), runId) {
  const p = normalizePolicy(policy, now), gate = nextAction(p, delay, now,runId);
  if (p.blocked || gate.at > now) throw Error('A collection action is not allowed yet.');
  p.actions.push(now);
  p.nextAt = now + gate.interval;
  if(runId&&p.startup?.id===runId)p.startup.used=Math.min(2,p.startup.used+1);
  return p;
}

export function retryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? now + seconds * 1000 : now + DAY;
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(now, date) : 0;
}

export function blockPolicy(policy, reason, until = 0, now = Date.now()) {
  const p = normalizePolicy(policy, now);
  p.nextAt = Math.max(p.nextAt, until, now + RESTRICTION_COOLDOWN);
  p.blocked = { reason, at: now };
  p.startup=null;
  return p;
}

export function backoffPolicy(policy, delay, now = Date.now()) {
  const p = normalizePolicy(policy, now);
  p.failures++;
  p.startup=null;
  const wait = Math.max(MIN_INTERVAL, (Number(delay) || 120) * 1000) * 2 ** Math.min(p.failures - 1, 5);
  p.nextAt = Math.max(p.nextAt, now + wait);
  return p;
}
