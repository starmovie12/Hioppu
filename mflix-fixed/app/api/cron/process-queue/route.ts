/**
 * /api/cron/process-queue — GITHUB CRON HANDLER (runs every ~1 min)
 *
 * KEY FIX: Uses /api/solve_task (non-streaming, parallel) instead of
 * reading stream_solve. This ensures:
 * 1. ALL links are processed (not just 2)
 * 2. Processing stays within 60s Vercel limit
 * 3. No browser dependency — runs 100% on server
 *
 * Flow:
 *   1. Update heartbeat → shows "ONLINE" in UI
 *   2. Recover stuck tasks (processing > 10 min)
 *   3. Pick 1 pending queue item
 *   4. POST /api/tasks → creates task + extracts links from movie page
 *   5. POST /api/solve_task → solves ALL links in parallel on server
 *   6. Update queue status
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(msg: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' }),
    });
  } catch {}
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────
async function updateHeartbeat(status: 'running' | 'idle' | 'error', details = '') {
  try {
    await db.collection('system').doc('engine_status').set({
      lastRunAt: new Date().toISOString(),
      status, details,
      source: 'github-cron',
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (e: any) {
    console.error('[Heartbeat]', e.message);
  }
}

// ─── Stuck task recovery ─────────────────────────────────────────────────────
async function recoverStuckTasks(): Promise<number> {
  const TEN_MIN_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  let recovered = 0;

  for (const col of ['movies_queue', 'webseries_queue']) {
    try {
      const stuckSnap = await db.collection(col)
        .where('status', '==', 'processing')
        .get();

      for (const doc of stuckSnap.docs) {
        const data = doc.data();
        const lockedAt = data.lockedAt || data.updatedAt || data.createdAt || '';

        if (lockedAt && lockedAt < TEN_MIN_AGO) {
          const retryCount = (data.retryCount || 0) + 1;

          if (retryCount > 3) {
            await db.collection(col).doc(doc.id).update({
              status: 'failed',
              error: 'Max retries exceeded (3/3)',
              failedAt: new Date().toISOString(),
              retryCount,
            });
          } else {
            await db.collection(col).doc(doc.id).update({
              status: 'pending',
              lockedAt: null,
              retryCount,
              lastRecoveredAt: new Date().toISOString(),
            });
          }
          recovered++;
        }
      }
    } catch (e: any) {
      console.error(`[Recovery] ${col}:`, e.message);
    }
  }

  // Also recover stuck scraping_tasks
  try {
    const stuckSnap = await db.collection('scraping_tasks')
      .where('status', '==', 'processing')
      .get();

    for (const doc of stuckSnap.docs) {
      const data = doc.data();
      const createdAt = data.createdAt || data.updatedAt || '';
      if (createdAt && createdAt < TEN_MIN_AGO) {
        const links = data.links || [];
        const hasPending = links.some((l: any) => {
          const s = (l.status || '').toLowerCase();
          return s === 'pending' || s === 'processing' || s === '';
        });

        if (hasPending) {
          const updatedLinks = links.map((l: any) => {
            const s = (l.status || '').toLowerCase();
            if (s === 'processing' || s === '' || s === 'pending') {
              return { ...l, status: 'pending', logs: [{ msg: '🔄 Auto-recovered', type: 'info' }] };
            }
            return l;
          });

          await db.collection('scraping_tasks').doc(doc.id).update({
            status: 'processing',
            links: updatedLinks,
            recoveredAt: new Date().toISOString(),
          });
          recovered++;
        }
      }
    }
  } catch (e: any) {
    console.error('[Recovery] scraping_tasks:', e.message);
  }

  return recovered;
}

// ─── Main Cron Handler ───────────────────────────────────────────────────────
export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();

  try {
    // Step 1: Heartbeat
    await updateHeartbeat('running', 'Cron started');

    // Step 2: Recover stuck tasks
    const recovered = await recoverStuckTasks();
    if (recovered > 0) {
      await sendTelegram(`🔧 <b>Auto-Recovery</b>\n♻️ ${recovered} stuck task(s) recovered`);
    }

    // Step 3: Pick 1 pending queue item
    let doc: any = null;
    let col = '';

    const mSnap = await db.collection('movies_queue')
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get();

    if (!mSnap.empty) {
      doc = mSnap.docs[0];
      col = 'movies_queue';
    } else {
      const wSnap = await db.collection('webseries_queue')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'asc')
        .limit(1)
        .get();
      if (!wSnap.empty) {
        doc = wSnap.docs[0];
        col = 'webseries_queue';
      }
    }

    if (!doc) {
      await updateHeartbeat('idle', 'Queue empty');
      return NextResponse.json({ status: 'idle', message: 'Queue empty', recovered });
    }

    const item = { id: doc.id, ...doc.data() } as any;
    const retryCount = item.retryCount || 0;

    // Step 4: Lock the queue item
    await db.collection(col).doc(item.id).update({
      status: 'processing',
      lockedAt: new Date().toISOString(),
      retryCount,
    });

    // Step 5: Get base URL
    let base = (process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (!base) base = 'https://ffgggc-hztr.vercel.app';

    // Step 6: Create task via /api/tasks (extracts links from movie page)
    console.log(`[Cron] Creating task for: ${item.url}`);
    const taskRes = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.url }),
    });

    if (!taskRes.ok) {
      const errText = await taskRes.text();
      throw new Error(`/api/tasks HTTP ${taskRes.status}: ${errText.substring(0, 100)}`);
    }

    const taskData = await taskRes.json();
    if (taskData.error) throw new Error(taskData.error);
    const taskId = taskData.taskId;

    // Step 7: Get the task's links from Firebase
    const taskDoc = await db.collection('scraping_tasks').doc(taskId).get();
    const taskDocData = taskDoc.exists ? taskDoc.data() : null;
    const allLinks = taskDocData?.links || [];

    // Filter pending links only
    const pendingLinks = allLinks
      .map((l: any, i: number) => ({ ...l, id: i }))
      .filter((l: any) => {
        const s = (l.status || '').toLowerCase();
        return s === 'pending' || s === '' || s === 'processing';
      });

    let success = false;

    if (pendingLinks.length > 0) {
      // Step 8: Call /api/solve_task — NON-STREAMING, processes ALL links in parallel
      console.log(`[Cron] Solving ${pendingLinks.length} links via /api/solve_task`);
      
      const solveRes = await fetch(`${base}/api/solve_task`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({
          taskId,
          links: pendingLinks.map((l: any) => ({ id: l.id, name: l.name, link: l.link })),
          extractedBy: 'Server/Auto-Pilot',
        }),
      });

      if (solveRes.ok) {
        const solveData = await solveRes.json();
        success = (solveData.done || 0) > 0;
        console.log(`[Cron] solve_task result: done=${solveData.done}, errors=${solveData.errors}`);
      } else {
        const errText = await solveRes.text();
        console.error(`[Cron] solve_task failed: ${errText.substring(0, 100)}`);
      }
    } else {
      // No pending links (all already done/failed)
      success = allLinks.some((l: any) => ['done', 'success'].includes((l.status || '').toLowerCase()));
    }

    // Step 9: Update queue status
    const finalStatus = success ? 'completed' : 'failed';
    await db.collection(col).doc(item.id).update({
      status: finalStatus,
      processedAt: new Date().toISOString(),
      taskId,
      extractedBy: 'Server/Auto-Pilot',
      retryCount,
    });

    // Step 10: Mark extraction source on scraping_tasks
    try {
      await db.collection('scraping_tasks').doc(taskId).update({
        extractedBy: 'Server/Auto-Pilot',
      });
    } catch {}

    // Step 11: Heartbeat & Telegram
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const title = taskData.preview?.title || item.title || item.url;

    await updateHeartbeat('idle', `Last: ${title} (${finalStatus})`);

    await sendTelegram(success
      ? `✅ <b>Auto-Pilot</b> 🤖\n🎬 ${title}\n⏱ ${elapsed}s\n🔄 Retry: ${retryCount}/3`
      : `❌ <b>Auto-Pilot Failed</b>\n🎬 ${title}\n🔄 Retry: ${retryCount}/3`
    );

    return NextResponse.json({
      status: finalStatus, title, elapsed, recovered, retryCount,
      extractedBy: 'Server/Auto-Pilot',
    });

  } catch (e: any) {
    console.error(`[CRON ERROR]`, e);
    await updateHeartbeat('error', e.message);
    await sendTelegram(`🚨 <b>CRON ERROR</b>\n${e.message}`);
    return NextResponse.json({ error: e.message, status: 'failed_internally' }, { status: 200 });
  }
}
