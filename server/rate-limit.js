const positiveInt=(value,fallback)=>{const parsed=Number(value);return Number.isInteger(parsed)&&parsed>0?parsed:fallback;};

/** Atomic fixed-window limiter stored in SQLite/libSQL, so all Worker instances share it. */
export async function consumeRateLimit(db,key,limit,windowMs=60000,now=Date.now()){
  const resetAt=now+windowMs;
  const row=await db.prepare(`INSERT INTO api_rate_limits(key,count,reset_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN api_rate_limits.reset_at<=? THEN 1 ELSE api_rate_limits.count+1 END,
      reset_at=CASE WHEN api_rate_limits.reset_at<=? THEN excluded.reset_at ELSE api_rate_limits.reset_at END
    RETURNING count,reset_at`).bind(key,resetAt,now,now).first();
  const count=Number(row?.count||0),actualReset=Number(row?.reset_at||resetAt);
  return {allowed:count<=limit,limit,remaining:Math.max(0,limit-count),resetAt:actualReset};
}

export function rateLimitConfig(env,kind){
  return kind==='write'
    ? positiveInt(env.ORBIT_WRITE_LIMIT_PER_MINUTE,20)
    : positiveInt(env.ORBIT_READ_LIMIT_PER_MINUTE,120);
}

