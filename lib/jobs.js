// Long-running background jobs (copy, export, import) with progress the UI can poll.
import { randomUUID, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';

const jobs = new Map();
const KEEP_MS = 60 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt > KEEP_MS) {
      if (j.file) rmSync(j.file, { force: true });
      jobs.delete(id);
    }
  }
}

export function createJob(kind, title, run) {
  gc();
  const job = {
    id: randomUUID(),
    kind,
    title,
    status: 'running',
    progress: 0,
    phase: 'Menyiapkan…',
    log: [],
    items: [],
    result: null,
    error: null,
    cancelled: false,
    startedAt: Date.now(),
    finishedAt: null,
    token: randomBytes(18).toString('hex'),
    file: null,
    fileName: null,
  };
  jobs.set(job.id, job);

  const ctx = {
    job,
    log(msg, level = 'info') {
      job.log.push({ t: Date.now(), level, msg: String(msg) });
      if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    },
    progress(p, phase) {
      if (Number.isFinite(p)) job.progress = Math.max(0, Math.min(1, p));
      if (phase) job.phase = phase;
    },
    item(key, patch) {
      let it = job.items.find((i) => i.key === key);
      if (!it) {
        it = { key };
        job.items.push(it);
      }
      Object.assign(it, patch);
    },
    checkCancel() {
      if (job.cancelled) throw Object.assign(new Error('Dibatalkan'), { cancelled: true });
    },
    setFile(path, name) {
      job.file = path;
      job.fileName = name;
    },
  };

  Promise.resolve()
    .then(() => run(ctx))
    .then(
      (result) => {
        job.result = result ?? null;
        job.status = 'done';
        job.progress = 1;
        job.phase = 'Selesai';
      },
      (err) => {
        job.status = err.cancelled ? 'cancelled' : 'error';
        job.error = err.message || String(err);
        job.phase = err.cancelled ? 'Dibatalkan' : 'Gagal';
        ctx.log(job.error, 'error');
      },
    )
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return job;
}

export const getJob = (id) => jobs.get(id);

export function publicJob(j) {
  const { token, file, ...rest } = j;
  return { ...rest, download: file && j.status === 'done' ? `/download/${j.id}?token=${token}` : null };
}

export function cancelJob(id) {
  const j = jobs.get(id);
  if (j && j.status === 'running') j.cancelled = true;
  return Boolean(j);
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30).map(publicJob);
}
