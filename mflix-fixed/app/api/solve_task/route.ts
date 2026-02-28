/**
 * /api/solve_task — SERVER-SIDE NON-STREAMING PARALLEL SOLVER
 *
 * This is the CORE backend engine. Both the GitHub cron AND the browser
 * Auto-Pilot call this endpoint. It does NOT stream — it processes all
 * links, saves results to Firebase, and returns a JSON summary.
 *
 * ✅ Smart Parallel Processing — direct links fire simultaneously
 * ✅ VPS Protection            — timer links stay sequential
 * ✅ Per-link Timeout (25s)    — no single link blocks forever
 * ✅ Overall Guard (50s)       — ensures we finish within Vercel's 60s
 * ✅ Auto Retry (2×)           — transient errors retried automatically
 * ✅ Atomic Firestore Writes   — parallel writes never corrupt data
 * ✅ Works with browser closed  — runs as independent serverless function
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';
import {
  solveHBLinks,
  solveHubCDN,
  solveHubDrive,
  solveHubCloudNative,
  solveGadgetsWebNative,
} from '@/lib/solvers';

// ─── Constants ────────────────────────────────────────────────────────────────
const TIMER_API = 'http://85.121.5.246:10000/solve?url=';
const TIMER_DOMAINS = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'] as const;
const TARGET_DOMAINS = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud'] as const;
const LINK_TIMEOUT_MS = 25_000; // 25s per-link hard cap
const OVERALL_TIMEOUT_MS = 50_000; // 50s overall guard (leaves 10s margin for Vercel)

// ─── Timeout-aware fetch helper ───────────────────────────────────────────────
async function fetchWithTimeout(url: string, timeoutMs = 20_000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'MflixPro/3.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Firestore atomic write (save one link result) ───────────────────────────
async function saveResultToFirestore(
  taskId: string,
  lid: number | string,
  linkUrl: string,
  result: any,
  extractedBy: string,
): Promise<void> {
  const taskRef = db.collection('scraping_tasks').doc(taskId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) return;

    const existing = snap.data()?.links || [];
    const updated = existing.map((l: any) => {
      if (l.id === lid || l.link === linkUrl) {
        return {
          ...l,
          finalLink: result.finalLink || l.finalLink || null,
          status: result.status || 'error',
          error: result.error || null,
          logs: result.logs || [],
          best_button_name: result.best_button_name || null,
          all_available_buttons: result.all_available_buttons || [],
          solvedAt: new Date().toISOString(),
        };
      }
      return l;
    });

    const allDone = updated.every((l: any) =>
      ['done', 'success', 'error', 'failed'].includes((l.status || '').toLowerCase())
    );
    const anySuccess = updated.some((l: any) =>
      ['done', 'success'].includes((l.status || '').toLowerCase())
    );

    tx.update(taskRef, {
      links: updated,
      status: allDone ? (anySuccess ? 'completed' : 'failed') : 'processing',
      extractedBy,
      ...(allDone ? { completedAt: new Date().toISOString() } : {}),
    });
  });
}

// ─── Core single-link solver ──────────────────────────────────────────────────
async function processLink(
  linkData: any,
  idx: number,
  taskId: string,
  extractedBy: string,
  attempt = 1,
): Promise<{ lid: number; status: string; finalLink?: string }> {
  const lid = linkData.id ?? idx;
  const originalUrl = linkData.link as string;
  const logs: { msg: string; type: string }[] = [];
  const log = (msg: string, type = 'info') => logs.push({ msg, type });

  let result: any = { ...linkData, status: 'error', error: 'Unknown error', logs };

  const solveWork = async () => {
    if (!originalUrl || typeof originalUrl !== 'string') {
      log('❌ No link URL', 'error');
      return;
    }

    let currentLink = originalUrl;
    log(`🔍 [attempt ${attempt}/2] ${currentLink.slice(0, 60)}`, 'info');

    try {
      // ── 1. HubCDN.fans ──
      if (currentLink.includes('hubcdn.fans')) {
        log('⚡ HubCDN processing...', 'info');
        const r = await solveHubCDN(currentLink);
        if (r.status === 'success') {
          log('✅ HubCDN done', 'success');
          result = { ...linkData, finalLink: r.final_link, status: 'done', logs };
        } else {
          log(`❌ HubCDN: ${r.message}`, 'error');
          result = { ...linkData, status: 'error', error: r.message, logs };
        }
        return;
      }

      // ── 2. Timer bypass ──
      let loopCount = 0;
      while (loopCount < 3 && !TARGET_DOMAINS.some(d => currentLink.includes(d))) {
        const isTimerLink = TIMER_DOMAINS.some(x => currentLink.includes(x));
        if (!isTimerLink) break;

        log(`⏳ Timer bypass (loop ${loopCount + 1})...`, 'warn');
        try {
          if (currentLink.includes('gadgetsweb')) {
            const r = await solveGadgetsWebNative(currentLink);
            if (r.status === 'success' && r.link) {
              currentLink = r.link;
              log('✅ Timer bypassed (GadgetsWeb)', 'success');
            } else {
              log(`❌ GadgetsWeb: ${r.message}`, 'error');
              break;
            }
          } else {
            const r = await fetchWithTimeout(TIMER_API + encodeURIComponent(currentLink), 20_000);
            if (r.status === 'success' && r.extracted_link) {
              currentLink = r.extracted_link;
              log('✅ Timer bypassed (VPS)', 'success');
            } else {
              log(`❌ VPS timer: ${r.message || 'no link'}`, 'error');
              break;
            }
          }
        } catch (e: any) {
          log(`❌ Timer error: ${e.message}`, 'error');
          break;
        }
        loopCount++;
      }

      // ── 3. HBLinks ──
      if (currentLink.includes('hblinks')) {
        log('🔗 Solving HBLinks...', 'info');
        const r = await solveHBLinks(currentLink);
        if (r.status === 'success' && r.link) {
          currentLink = r.link;
          log('✅ HBLinks solved', 'success');
        } else {
          log(`❌ HBLinks: ${r.message}`, 'error');
          result = { ...linkData, status: 'error', error: r.message, logs };
          return;
        }
      }

      // ── 4. HubDrive ──
      if (currentLink.includes('hubdrive')) {
        log('☁️ Solving HubDrive...', 'info');
        const r = await solveHubDrive(currentLink);
        if (r.status === 'success' && r.link) {
          currentLink = r.link;
          log('✅ HubDrive solved', 'success');
        } else {
          log(`❌ HubDrive: ${r.message}`, 'error');
          result = { ...linkData, status: 'error', error: r.message, logs };
          return;
        }
      }

      // ── 5. HubCloud / HubCDN ──
      if (currentLink.includes('hubcloud') || currentLink.includes('hubcdn')) {
        log('⚡ Solving HubCloud...', 'info');
        const r = await solveHubCloudNative(currentLink);
        if (r.status === 'success' && r.best_download_link) {
          log(`🎉 Done via ${r.best_button_name || 'Download'}`, 'success');
          result = {
            ...linkData,
            finalLink: r.best_download_link,
            status: 'done',
            logs,
            best_button_name: r.best_button_name || null,
            all_available_buttons: r.all_available_buttons || [],
          };
        } else {
          log(`❌ HubCloud: ${r.message}`, 'error');
          result = { ...linkData, status: 'error', error: r.message, logs };
        }
        return;
      }

      // ── 6. No solver matched ──
      log('❌ Unrecognised link — no solver matched', 'error');
      result = { ...linkData, status: 'error', error: 'No solver matched', logs };

    } catch (e: any) {
      log(`⚠️ Unexpected error: ${e.message}`, 'error');
      result = { ...linkData, status: 'error', error: e.message, logs };
    }
  };

  // Per-link timeout race
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${LINK_TIMEOUT_MS / 1000}s`)), LINK_TIMEOUT_MS)
  );

  try {
    await Promise.race([solveWork(), timeout]);
  } catch (e: any) {
    log(`⏱️ ${e.message}`, 'error');
    result = { ...linkData, status: 'error', error: e.message, logs };
  }

  // Auto-retry once on failure
  if (result.status === 'error' && attempt === 1) {
    log('🔄 Auto-retrying (attempt 2/2)...', 'warn');
    return processLink(linkData, idx, taskId, extractedBy, 2);
  }

  // Save final result to Firestore immediately
  try {
    await saveResultToFirestore(taskId, lid, originalUrl, result, extractedBy);
  } catch (e: any) {
    console.error(`[solve_task] DB write failed lid=${lid}:`, e.message);
  }

  return { lid, status: result.status, finalLink: result.finalLink };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  // Accept both CRON_SECRET auth and x-mflix-internal header (for browser auto-pilot)
  const auth = req.headers.get('authorization');
  const internalHeader = req.headers.get('x-mflix-internal');
  const isAuthorized = auth === `Bearer ${process.env.CRON_SECRET}` || internalHeader === 'true';

  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let taskId: string, links: any[], extractedBy: string;
  try {
    const body = await req.json();
    taskId = body.taskId;
    links = body.links;
    extractedBy = body.extractedBy || 'Server/Auto-Pilot';
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!taskId || !Array.isArray(links) || links.length === 0) {
    return NextResponse.json({ error: 'taskId and non-empty links required' }, { status: 400 });
  }

  // Mark task as processing
  try {
    await db.collection('scraping_tasks').doc(taskId).update({
      status: 'processing',
      extractedBy,
      processingStartedAt: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }

  // Overall timeout guard
  const overallStart = Date.now();

  // ─── SMART ROUTING ──────────────────────────────────────────────────────
  // 🚀 DIRECT links → Promise.allSettled (parallel)
  // 🛡️ TIMER links → Sequential (protect VPS)
  // Both groups run CONCURRENTLY with each other.

  const timerLinks = links.filter(l => TIMER_DOMAINS.some(d => (l.link || '').includes(d)));
  const directLinks = links.filter(l => !TIMER_DOMAINS.some(d => (l.link || '').includes(d)));

  console.log(`[solve_task] ${taskId} | ${directLinks.length} direct (parallel) + ${timerLinks.length} timer (sequential)`);

  const results: { lid: number; status: string; finalLink?: string }[] = [];

  // Direct links — fire all at once
  const directPromises = directLinks.map(l =>
    processLink(l, links.indexOf(l), taskId, extractedBy)
  );

  // Timer links — sequential to protect VPS
  const timerPromise = (async () => {
    const timerResults: typeof results = [];
    for (const l of timerLinks) {
      // Check overall timeout
      if (Date.now() - overallStart > OVERALL_TIMEOUT_MS) {
        console.warn(`[solve_task] Overall timeout reached, marking remaining timer links as error`);
        // Mark remaining as timed out
        const remaining = timerLinks.slice(timerLinks.indexOf(l));
        for (const rl of remaining) {
          const lid = rl.id ?? links.indexOf(rl);
          try {
            await saveResultToFirestore(taskId, lid, rl.link, {
              status: 'error',
              error: 'Overall timeout - will retry next run',
              logs: [{ msg: '⏱️ Skipped due to overall timeout', type: 'error' }],
            }, extractedBy);
          } catch {}
          timerResults.push({ lid, status: 'error' });
        }
        break;
      }
      const r = await processLink(l, links.indexOf(l), taskId, extractedBy);
      timerResults.push(r);
    }
    return timerResults;
  })();

  // Run both groups concurrently
  const [directSettled, timerResult] = await Promise.all([
    Promise.allSettled(directPromises),
    timerPromise,
  ]);

  // Collect results
  for (const s of directSettled) {
    if (s.status === 'fulfilled') results.push(s.value);
  }
  results.push(...timerResult);

  const doneCount = results.filter(r => r.status === 'done').length;
  const errorCount = results.filter(r => r.status === 'error').length;

  console.log(`[solve_task] ${taskId} | Done: ${doneCount}, Errors: ${errorCount}`);

  return NextResponse.json({
    ok: true,
    taskId,
    processed: links.length,
    done: doneCount,
    errors: errorCount,
    directCount: directLinks.length,
    timerCount: timerLinks.length,
  });
}
