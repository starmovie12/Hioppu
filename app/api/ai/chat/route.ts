/**
 * /api/ai/chat — MFLIX PRO AI Assistant
 *
 * Uses Anthropic API to chat about system problems.
 * Automatically fetches diagnostics and provides context to Claude.
 *
 * Requires ANTHROPIC_API_KEY in environment variables.
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ─── System prompt with FULL MFLIX PRO architecture knowledge ────────────────
const SYSTEM_PROMPT = `Tu MFLIX PRO ka AI System Administrator hai. Tu is website ka har ek part jaanta hai — har API route, har function, har Firebase collection, har solver, har config value. Tu Hindi + English mix mein baat karta hai (Hinglish). Tu chhota aur to-the-point jawab deta hai.

## MFLIX PRO Architecture:
- **Stack**: Next.js 15 (App Router) + Firebase Firestore + Vercel Hosting
- **VPS Server**: Python APIs at port 10000 (Timer bypass) and port 5001 (HubCloud bypass)
- **Cron**: GitHub Actions har ~5 minute mein /api/cron/process-queue ko call karta hai
- **Vercel Limit**: Har API route max 60 seconds run kar sakta hai (maxDuration: 60)

## Firebase Collections:
1. **movies_queue** & **webseries_queue**: URLs jo process hone baki hain (status: pending/processing/completed/failed)
2. **scraping_tasks**: Active tasks ki full detail — preview, links array (har link ka status: pending/processing/done/error), metadata
3. **system/engine_status**: Cron heartbeat — lastRunAt, status, details

## API Routes:
- **POST /api/tasks**: Movie URL se links extract karta hai, Firebase mein task create karta hai. Status 'pending' set hota hai — cron pick karega.
- **POST /api/solve_task**: Core solver — taskId + links leta hai, timer links sequential + direct links parallel solve karta hai. 45s time budget hai.
- **POST /api/stream_solve**: Browser ke liye NDJSON streaming solver — manual "START ENGINE" button se chalta hai. Live logs stream karta hai.
- **GET /api/cron/process-queue**: GitHub Cron handler — heartbeat, stuck recovery, queue se 1 item pick, extract + solve. Direct function calls use karta hai (no nested HTTP).
- **GET /api/engine-status**: Engine heartbeat check + queue counts.
- **GET /api/auto-process/queue**: Queue items list + PATCH for status updates.

## Solvers (lib/solvers.ts):
- **extractMovieLinks(url)**: Movie page scrape karke download links nikalta hai
- **solveHubCloudNative(url)**: HubCloud bypass — best_download_link return karta hai
- **solveHubDrive(url)**: HubDrive resolve
- **solveHBLinks(url)**: HBLinks resolve
- **solveHubCDN(url)**: HubCDN direct solve
- **solveGadgetsWebNative(url)**: GadgetsWeb timer bypass (native, no VPS)

## Config (lib/config.ts):
- TIMER_DOMAINS: ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'] — YE SEQUENTIAL (ek-ek karke)
- TARGET_DOMAINS: ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud', 'gdflix', 'drivehub'] — YE PARALLEL
- LINK_TIMEOUT_MS: 25000 (per link)
- OVERALL_TIMEOUT_MS: 50000
- STUCK_TASK_THRESHOLD_MS: 10 min
- MAX_CRON_RETRIES: 3

## 4 SAKHT Rules:
1. **VPS Protection**: Timer domains SEQUENTIAL, Direct domains PARALLEL (Promise.allSettled)
2. **Zero-Drop Decoupling**: Browser band hone par backend pe asar nahi padna chahiye
3. **State Hydration**: Page refresh pe Firebase se state restore hona chahiye
4. **Complete Extraction**: Koi bhi link skip nahi hoga — sab done/error hone tak task complete nahi

## Frontend (components/MflixApp.tsx):
- Shield Pattern: completedLinksRef cache — polling se stream data protect karta hai
- 3-Layer Data Resolution: Live Stream > Shield > Firebase Polling
- 5-second polling (setInterval), 20-second engine polling
- Auto-Pilot: Queue items ek-ek karke process — solve_task call karta hai

## Common Problems & Solutions:

### "Links nikal nahi rahe" (Extraction failure):
- Check: VPS server up hai? (Timer API + HubCloud API)
- Check: Source website ne structure change kiya?
- Check: TIMER_API/HUBCLOUD_API env variables sahi hain?
- Fix: VPS restart karo, ya solvers.ts mein selectors update karo

### "Engine OFFLINE" (Cron not running):
- Check: GitHub Actions workflow enabled hai?
- Check: CRON_SECRET env variable Vercel + GitHub mein match karta hai?
- Fix: GitHub repo → Actions tab → Enable workflow

### "Task stuck in processing":
- Check: Cron stuck recovery kaam kar raha hai? (STUCK_TASK_THRESHOLD_MS = 10min)
- Check: solve_task 60s timeout se pehle complete ho raha hai?
- Fix: Manual retry button press karo, ya Firebase mein status 'pending' kardo

### "Queue items pending but not processing":
- Check: Engine ONLINE hai? Heartbeat fresh hai?
- Check: Koi processing item stuck toh nahi? (blocks next pick)
- Fix: Stuck item ko manually 'pending' karo Firebase mein

### "Link success rate low":
- Check: Specific solver fail ho raha hai? (HubCloud vs Timer vs HBLinks)
- Check: VPS memory/CPU issue? Too many parallel requests?
- Fix: Check VPS logs, restart VPS, check solver code

Jab user koi problem bataye:
1. Pehle diagnostics data analyze kar — jo tujhe context mein mila hai
2. Root cause identify kar
3. Step-by-step fix batao — simple Hindi mein
4. Agar code change chahiye, toh exact file path + code snippet de
5. Agar prompt chahiye Claude ke liye, toh ready-to-paste prompt de

IMPORTANT: Tera response concise hona chahiye. Faltu lectures mat de. Direct problem → cause → fix batao.`;

// ─── Helper: Get base URL ────────────────────────────────────────────────────
function getBaseUrl(req: NextRequest): string {
  const host = req.headers.get('host') || 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') || 'http';
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured. Add it to your .env / Vercel environment variables.' },
      { status: 500 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const userMessage = body?.message;
  const conversationHistory = body?.history || [];
  const diagnostics = body?.diagnostics || null;

  if (!userMessage) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  // ─── Build messages array ──────────────────────────────────────────────────
  const messages: any[] = [];

  // Add conversation history
  for (const msg of conversationHistory) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // Add current message with diagnostics context
  let userContent = userMessage;
  if (diagnostics) {
    userContent = `[CURRENT SYSTEM DIAGNOSTICS — auto-fetched]\n\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\`\n\n[USER'S QUESTION]\n${userMessage}`;
  }

  messages.push({ role: 'user', content: userContent });

  // ─── Call Anthropic API ────────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('[AI Chat] Anthropic API error:', errData);
      return NextResponse.json(
        { error: `Anthropic API error: ${response.status} — ${errData?.error?.message || 'Unknown'}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const assistantText = data.content
      ?.filter((block: any) => block.type === 'text')
      ?.map((block: any) => block.text)
      ?.join('\n') || 'No response generated.';

    return NextResponse.json({
      response: assistantText,
      usage: data.usage,
    });
  } catch (e: any) {
    console.error('[AI Chat] Error:', e.message);
    return NextResponse.json(
      { error: `Failed to reach Anthropic API: ${e.message}` },
      { status: 502 }
    );
  }
}
