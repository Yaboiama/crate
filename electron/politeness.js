// The polite-client layer: error taxonomy, per-host token bucket,
// per-host circuit breaker, and full-jitter backoff. See BRIEF.md §5.
'use strict';

// kind: 'ratelimit' | 'transient' | 'permanent' | 'extractor' | 'auth' | 'tooling'
class CrateError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CrateError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// delay = random(0, min(cap, base * 2^attempt)) — full jitter.
function fullJitter(attempt, baseMs = 2000, capMs = 300000) {
  const ceiling = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  return Math.floor(Math.random() * ceiling);
}

// Token bucket per hostname, shared by metadata lookups and download
// launches against the same host. Per-host overrides let well-provisioned
// APIs run faster while strict ones (MusicBrainz: 1/s) stay strict.
class RateLimiter {
  constructor({ ratePerSec = 1, burst = 2, hosts = {} } = {}) {
    this.def = { ratePerSec, burst };
    this.hosts = hosts; // host -> { ratePerSec, burst }
    this.buckets = new Map(); // host -> { tokens, last, queue }
  }

  _cfg(host) { return this.hosts[host] || this.def; }

  _bucket(host) {
    let b = this.buckets.get(host);
    if (!b) {
      b = { cfg: this._cfg(host), tokens: this._cfg(host).burst, last: Date.now(), draining: false, queue: [] };
      this.buckets.set(host, b);
    }
    return b;
  }

  take(host) {
    const b = this._bucket(host);
    return new Promise((resolve) => {
      b.queue.push(resolve);
      this._drain(b);
    });
  }

  _drain(b) {
    if (b.draining) return;
    b.draining = true;
    const step = () => {
      const now = Date.now();
      b.tokens = Math.min(b.cfg.burst, b.tokens + ((now - b.last) / 1000) * b.cfg.ratePerSec);
      b.last = now;
      while (b.queue.length && b.tokens >= 1) {
        b.tokens -= 1;
        b.queue.shift()();
      }
      if (b.queue.length) {
        const waitMs = Math.ceil(((1 - b.tokens) / b.cfg.ratePerSec) * 1000);
        setTimeout(step, Math.max(50, waitMs));
      } else {
        b.draining = false;
      }
    };
    step();
  }
}

// After 3 consecutive rate-limit responses from a host, pause all work
// against that host: 5 minutes, doubling per trip, capped at 30 minutes.
// Respects Retry-After when it asks for longer.
const BREAKER_START_MS = 5 * 60 * 1000;
const BREAKER_CAP_MS = 30 * 60 * 1000;

class CircuitBreaker {
  constructor() {
    this.hosts = new Map(); // host -> { consecutive, trips, until }
    this.listeners = [];
  }

  onChange(fn) { this.listeners.push(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(); } catch { /* listener error is not ours */ } } }

  _h(host) {
    let h = this.hosts.get(host);
    if (!h) { h = { consecutive: 0, trips: 0, until: 0 }; this.hosts.set(host, h); }
    return h;
  }

  // Returns { until } — the earliest time work against this host may resume.
  // Never earlier than Retry-After demands.
  noteRateLimit(host, retryAfterMs = 0) {
    const h = this._h(host);
    h.consecutive += 1;
    const now = Date.now();
    let waitMs;
    if (h.consecutive >= 3) {
      const cooloff = Math.min(BREAKER_CAP_MS, BREAKER_START_MS * Math.pow(2, h.trips));
      h.trips += 1;
      waitMs = Math.max(retryAfterMs, cooloff);
    } else {
      waitMs = Math.max(retryAfterMs, fullJitter(h.consecutive, 2000, 60000));
    }
    h.until = Math.max(h.until, now + waitMs);
    this._emit();
    return { until: h.until };
  }

  noteSuccess(host) {
    const h = this._h(host);
    if (h.consecutive || h.until) {
      h.consecutive = 0;
      h.until = 0;
      this._emit();
    }
    // trips decay only on success so a long session isn't stuck at 30m forever
    if (h.trips > 0) h.trips -= 1;
  }

  blockedUntil(host) {
    const h = this.hosts.get(host);
    if (!h) return 0;
    if (h.until && h.until <= Date.now()) { h.until = 0; this._emit(); }
    return h.until || 0;
  }

  isBlocked(host) { return this.blockedUntil(host) > Date.now(); }

  // First host currently in cooling-off, for the status bar.
  active() {
    for (const [host, h] of this.hosts) {
      if (h.until > Date.now()) return { host, until: h.until };
    }
    return null;
  }
}

function prettyHost(host) {
  if (/youtube|ytimg|youtu\.be/i.test(host)) return 'YouTube';
  if (/spotify|scdn/i.test(host)) return 'Spotify';
  if (/soundcloud|sndcdn/i.test(host)) return 'SoundCloud';
  return host;
}

module.exports = { CrateError, RateLimiter, CircuitBreaker, fullJitter, prettyHost };
