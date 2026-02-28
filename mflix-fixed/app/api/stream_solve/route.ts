/**
 * /api/stream_solve — BROWSER LIVE STREAMING SOLVER
 *
 * This is ONLY used for the manual "START ENGINE" button in the browser.
 * It streams real-time logs to the UI via NDJSON.
 *
 * KEY FIXES:
 * 1. Per-link timeout of 25s — no single link can block others
 * 2. Overall timeout of 50s — ensures we finish within Vercel's 60s
 * 3. Promise.allSettled for parallel — one failure never kills siblings
 * 4. Every link gets a final status (done/error), never left hanging
 */

export const maxDuration = 60;

import { db } from '@/lib/firebaseAdmin';
import {
  solveHBLinks,
  solveHubCDN,
  solveHubDrive,
  solveHubCloudNative,
  solveGadgetsWebNative,
} from '@/lib/solvers';

const TIMER_API = 'http://85.121.5.246:10000/solve?url=';
const LINK_TIMEOUT_MS = 25_000; // 25s per link
const OVERALL_TIMEOUT_MS = 50_000; // 50s overall guard

const fetchJSON = async (url: string, timeoutMs = 20000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'MflixPro/2.0' },
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

export async function POST(req: Request) {
  let links: any[];
  let taskId: string | undefined;
  let extractedBy: string = 'Browser/Live';

  try {
    const body = await req.json();
    links = body.links;
    taskId = body.taskId;
    if (body.extractedBy) extractedBy = body.extractedBy;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  if (!Array.isArray(links) || links.length === 0) {
    return new Response(JSON.stringify({ error: 'No links provided' }), { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const overallStart = Date.now();

      const send = (data: any) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(data) + '\n')); } catch {}
      };

      const processLink = async (linkData: any, idx: number) => {
        const lid = linkData.id ?? idx;
        let currentLink = linkData.link;
        const logs: { msg: string; type: string }[] = [];

        const sendLog = (msg: string, type = 'info') => {
          logs.push({ msg, type });
          send({ id: lid, msg, type });
        };

        // Check overall timeout
        if (Date.now() - overallStart > OVERALL_TIMEOUT_MS) {
          sendLog('⏱️ Skipped — overall timeout reached', 'error');
          send({ id: lid, status: 'error' });
          await saveToFirestore(taskId, lid, linkData, { status: 'error', error: 'Overall timeout', logs }, extractedBy);
          send({ id: lid, status: 'finished' });
          return;
        }

        // Per-link timeout wrapper
        const solveWithTimeout = async () => {
          try {
            if (!currentLink || typeof currentLink !== 'string') {
              sendLog('❌ No link URL', 'error');
              send({ id: lid, status: 'error' });
              await saveToFirestore(taskId, lid, linkData, { status: 'error', error: 'No link URL', logs }, extractedBy);
              return;
            }

            // ── HUBCDN.FANS ──
            if (currentLink.includes('hubcdn.fans')) {
              sendLog('⚡ HubCDN processing...', 'info');
              const r = await solveHubCDN(currentLink);
              if (r.status === 'success') {
                send({ id: lid, final: r.final_link, status: 'done' });
                await saveToFirestore(taskId, lid, linkData, { status: 'done', finalLink: r.final_link, logs }, extractedBy);
              } else {
                sendLog(`❌ HubCDN: ${r.message}`, 'error');
                send({ id: lid, status: 'error' });
                await saveToFirestore(taskId, lid, linkData, { status: 'error', error: r.message, logs }, extractedBy);
              }
              return;
            }

            // ── TIMER BYPASS ──
            const targetDomains = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud'];
            let loopCount = 0;
            while (loopCount < 3 && !targetDomains.some(d => currentLink.includes(d))) {
              const isTimer = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'].some(x => currentLink.includes(x));
              if (!isTimer && loopCount === 0) break;

              sendLog('⏳ Timer bypass...', 'warn');
              try {
                if (currentLink.includes('gadgetsweb')) {
                  const r = await solveGadgetsWebNative(currentLink);
                  if (r.status === 'success') {
                    currentLink = r.link!;
                    sendLog('✅ Timer bypassed', 'success');
                  } else throw new Error(r.message || 'Bypass failed');
                } else {
                  const r = await fetchJSON(TIMER_API + encodeURIComponent(currentLink));
                  if (r.status === 'success') {
                    currentLink = r.extracted_link;
                    sendLog('✅ Timer bypassed', 'success');
                  } else throw new Error(r.message || 'Timer failed');
                }
              } catch (e: any) {
                sendLog(`❌ Timer: ${e.message}`, 'error');
                break;
              }
              loopCount++;
            }

            // ── HBLINKS ──
            if (currentLink.includes('hblinks')) {
              sendLog('🔗 Solving HBLinks...', 'info');
              const r = await solveHBLinks(currentLink);
              if (r.status === 'success') {
                currentLink = r.link!;
                sendLog('✅ HBLinks solved', 'success');
              } else {
                sendLog(`❌ HBLinks: ${r.message}`, 'error');
                send({ id: lid, status: 'error' });
                await saveToFirestore(taskId, lid, linkData, { status: 'error', error: r.message, logs }, extractedBy);
                return;
              }
            }

            // ── HUBDRIVE ──
            if (currentLink.includes('hubdrive')) {
              sendLog('☁️ Solving HubDrive...', 'info');
              const r = await solveHubDrive(currentLink);
              if (r.status === 'success') {
                currentLink = r.link!;
                sendLog('✅ HubDrive solved', 'success');
              } else {
                sendLog(`❌ HubDrive: ${r.message}`, 'error');
                send({ id: lid, status: 'error' });
                await saveToFirestore(taskId, lid, linkData, { status: 'error', error: r.message, logs }, extractedBy);
                return;
              }
            }

            // ── HUBCLOUD ──
            if (currentLink.includes('hubcloud') || currentLink.includes('hubcdn')) {
              sendLog('⚡ HubCloud direct link...', 'info');
              const r = await solveHubCloudNative(currentLink);
              if (r.status === 'success' && r.best_download_link) {
                sendLog(`🎉 Done via ${r.best_button_name || 'Best'}`, 'success');
                send({ id: lid, final: r.best_download_link, status: 'done', best_button_name: r.best_button_name });
                await saveToFirestore(taskId, lid, linkData, {
                  status: 'done',
                  finalLink: r.best_download_link,
                  logs,
                  best_button_name: r.best_button_name || null,
                  all_available_buttons: r.all_available_buttons || [],
                }, extractedBy);
                return;
              } else {
                sendLog(`❌ HubCloud: ${r.message}`, 'error');
              }
            }

            // ── UNRECOGNIZED ──
            sendLog('❌ Unrecognized link format', 'error');
            send({ id: lid, status: 'error' });
            await saveToFirestore(taskId, lid, linkData, { status: 'error', error: 'Could not solve', logs }, extractedBy);

          } catch (e: any) {
            sendLog(`⚠️ Error: ${e.message}`, 'error');
            send({ id: lid, status: 'error' });
            await saveToFirestore(taskId, lid, linkData, { status: 'error', error: e.message, logs }, extractedBy);
          }
        };

        // Per-link timeout race
        try {
          await Promise.race([
            solveWithTimeout(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Link timeout')), LINK_TIMEOUT_MS)
            ),
          ]);
        } catch (e: any) {
          sendLog(`⏱️ ${e.message} (${LINK_TIMEOUT_MS / 1000}s limit)`, 'error');
          send({ id: lid, status: 'error' });
          await saveToFirestore(taskId, lid, linkData, { status: 'error', error: e.message, logs }, extractedBy);
        }

        send({ id: lid, status: 'finished' });
      };

      // ── PROCESS ALL LINKS ──
      // Use Promise.allSettled so one failure doesn't kill others
      // But we still process sequentially to avoid VPS overload for timer links
      
      // Separate timer vs direct links
      const timerDomains = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'];
      const timerLinks = links.filter(l => timerDomains.some(d => (l.link || '').includes(d)));
      const directLinks = links.filter(l => !timerDomains.some(d => (l.link || '').includes(d)));

      // Direct links — parallel
      const directPromises = directLinks.map(l => processLink(l, links.indexOf(l)));
      
      // Timer links — sequential
      const timerPromise = (async () => {
        for (const l of timerLinks) {
          if (Date.now() - overallStart > OVERALL_TIMEOUT_MS) break;
          await processLink(l, links.indexOf(l));
        }
      })();

      await Promise.allSettled([...directPromises, timerPromise]);

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ─── Firestore save helper ───────────────────────────────────────────────────
async function saveToFirestore(
  taskId: string | undefined,
  lid: number,
  linkData: any,
  result: any,
  extractedBy: string
) {
  if (!taskId) return;
  try {
    const taskRef = db.collection('scraping_tasks').doc(taskId);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(taskRef);
      if (!doc.exists) return;
      const existing = doc.data()?.links || [];
      const updated = existing.map((l: any) => {
        if (l.id === lid || l.link === linkData.link) {
          return {
            ...l,
            finalLink: result.finalLink || l.finalLink || null,
            status: result.status || 'error',
            error: result.error || null,
            logs: result.logs || [],
            best_button_name: result.best_button_name || null,
            all_available_buttons: result.all_available_buttons || [],
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
  } catch (e: any) {
    console.error('[Stream] DB save error:', e.message);
  }
}
