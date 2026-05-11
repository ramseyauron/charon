import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { now, json, firstPositiveNumber } from '../utils.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { numSetting } from '../db/settings.js';
import { openPositions } from '../db/positions.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { liveWalletBalanceLamports, liveWalletPubkey } from '../liveExecutor.js';
import { candidateSummary, compactCandidateLine, batchRevealSummary, formatPosition } from './format.js';
import { candidateButtons, batchRevealButtons, navKeyboard, positionButtons, intentButtons, positionsListKeyboard } from './menus.js';
import { batchById } from '../db/decisions.js';

export async function sendTelegram(text, extra = {}) {
  return bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  });
}

export async function sendCandidateAlert(candidateId, candidate, decision) {
  const sent = await sendTelegram(candidateSummary(candidate, decision), candidateButtons(candidateId, decision));
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, candidate.token.mint, 'candidate', now(), sent.message_id, json({ candidate, decision }));
}

export async function sendBatchReveal(batchId, rows, decision, triggerCandidateId) {
  const sent = await sendTelegram(
    batchRevealSummary(batchId, rows, decision, triggerCandidateId),
    batchRevealButtons(batchId, rows, decision, triggerCandidateId),
  );
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    triggerCandidateId || null,
    decision.selected_mint || rows.find(row => row.id === Number(triggerCandidateId))?.candidate?.token?.mint || 'batch',
    'batch_reveal',
    now(),
    sent.message_id,
    json({ batchId, candidateIds: rows.map(row => row.id), decision, triggerCandidateId }),
  );
}

export async function sendBatch(chatId, batchId) {
  const batch = batchById(batchId);
  if (!batch) return bot.sendMessage(chatId, 'Batch not found.');
  const lines = [
    '🧭 <b>Screening Batch</b>',
    '',
    `Batch: <b>#${batchId}</b> · Decision: <b>${escapeHtml(batch.verdict)}</b> ${fmtPct(batch.confidence)}`,
    batch.reason ? `Reason: ${escapeHtml(String(batch.reason).slice(0, 500))}` : null,
    '',
    ...batch.rows.map((row, index) => compactCandidateLine(row, index + 1)),
  ];
  const keyboard = batch.rows.slice(0, 10).map((row, index) => ([{
    text: `${index + 1}. ${row.candidate.token?.symbol || short(row.candidate.token?.mint || '')}`,
    callback_data: `cand:${row.id}`,
  }]));
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return bot.sendMessage(chatId, lines.filter(Boolean).join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function sendPositionOpen(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  const label = position?.execution_mode === 'live' ? 'Live buy executed' : 'Dry-run buy stored';
  if (position) await sendTelegram(`✅ <b>${label}</b>\n\n${formatPosition(position)}`, positionButtons(positionId));
}

export async function sendPositionExit(position) {
  const label = position?.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  await sendTelegram(`🏁 <b>${label}: ${escapeHtml(position.exitReason)}</b>\n\n${formatPosition({ ...position, status: 'closed' })}`);
}

export async function sendTradeIntent(intentId, candidate, decision) {
  await sendTelegram([
    '🧾 <b>Trade intent awaiting confirmation</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Size: <b>${fmtSol(numSetting('dry_run_buy_sol', 0.1))} SOL</b>`,
    'Execution: confirmation required before signing.',
  ].join('\n'), intentButtons(intentId));
}

function pnlUpdateButtons(rows) {
  const dashboardRows = rows.map((row) => ({
    ...row.position,
    pnl_percent: row.pnlPercent,
    high_water_mcap: row.currentMcap ?? row.position.high_water_mcap,
  }));
  return positionsListKeyboard(dashboardRows, { showPnl: false, maxCols: 3 });
}

async function hydratePositionPnl(position) {
  const asset = await fetchJupiterAsset(position.mint).catch(() => null);
  const currentMcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.entry_mcap, position.high_water_mcap);
  const pnlPercent = position.entry_mcap && currentMcap
    ? (Number(currentMcap) / Number(position.entry_mcap) - 1) * 100
    : 0;
  return { position, currentMcap, pnlPercent };
}

function pnlUpdateText(rows) {
  const pubkey = liveWalletPubkey();
  const balanceLine = rows.balanceLine || 'Balance: <b>n/a</b>';
  const winRateLine = rows.winRate != null
    ? `Win rate: <b>${rows.winRate.toFixed(1)}%</b> (${rows.winRateWins}/${rows.winRateTotal} closed)`
    : 'Win rate: <b>—</b> (no closed trades)';
  const expectedSol = rows.reduce((sum, row) => {
    if (!row.position.entry_mcap || !row.currentMcap) return sum + (row.position.size_sol || 0);
    return sum + (row.position.size_sol || 0) * (Number(row.currentMcap) / Number(row.position.entry_mcap));
  }, 0);
  const lines = [
    '📊 <b>Dashboard</b>',
    balanceLine,
    winRateLine,
    `Open: <b>${rows.length}</b> · Expected SOL: <b>${fmtSol(expectedSol)}</b>`,
    '',
    ...rows.map((row) => {
      const ticker = row.position.symbol || short(row.position.mint);
      const modeIcon = row.position.execution_mode === 'live' ? '🟩' : '🟨';
      return [
        `${modeIcon} <b>${escapeHtml(ticker)}</b> · ${fmtPct(row.pnlPercent)}`,
        `Mcap: ${fmtUsd(row.currentMcap)} · Size: ${fmtSol(row.position.size_sol)} SOL`,
      ].join('\n');
    }),
    !pubkey ? '' : `Wallet: <code>${escapeHtml(pubkey)}</code>`,
  ];
  return lines.join('\n');
}

async function resolveBalanceLine() {
  const pubkey = liveWalletPubkey();
  if (!pubkey) return 'Balance: <b>n/a</b>';
  try {
    const lamports = await liveWalletBalanceLamports();
    return `Balance: <b>${fmtSol(Number(lamports) / 1_000_000_000)} SOL</b>`;
  } catch {
    return 'Balance: <b>unavailable</b>';
  }
}

async function pinDashboardMessage(messageId) {
  try {
    await bot.pinChatMessage(TELEGRAM_CHAT_ID, Number(messageId), {
      disable_notification: true,
      ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    });
  } catch (err) {
    console.log(`[telegram] dashboard pin failed: ${err.message}`);
  }
}

function isNotModifiedError(err) {
  return /message is not modified/i.test(err?.message || '');
}

function shouldRecreateDashboardMessage(err) {
  const message = err?.message || '';
  return /message to edit not found|message can't be edited/i.test(message);
}

export async function sendDashboardLiveUpdate({ pin = false } = {}) {
  const positions = openPositions().slice(0, 12);
  const balanceLine = await resolveBalanceLine();
  if (!positions.length) {
    const winRateStats = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins
      FROM dry_run_positions WHERE status = 'closed'
    `).get();
    const wrLine = winRateStats.total > 0
      ? `Win rate: <b>${(winRateStats.wins / winRateStats.total * 100).toFixed(1)}%</b> (${winRateStats.wins}/${winRateStats.total} closed)`
      : 'Win rate: <b>—</b> (no closed trades)';
    const emptyText = ['📊 <b>Dashboard</b>', balanceLine, wrLine, '', 'No open positions.'].join('\n');
    const last = db.prepare(`
      SELECT * FROM alerts
      WHERE kind = 'dashboard_live'
      ORDER BY id DESC
      LIMIT 1
    `).get();
    if (last?.telegram_message_id) {
      try {
        await bot.editMessageText(emptyText, {
          chat_id: TELEGRAM_CHAT_ID,
          message_id: Number(last.telegram_message_id),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...navKeyboard(),
        });
        db.prepare('UPDATE alerts SET sent_at_ms = ?, payload_json = ? WHERE id = ?').run(now(), json({ openCount: 0 }), last.id);
        if (pin) await pinDashboardMessage(last.telegram_message_id);
        return;
      } catch (err) {
        if (isNotModifiedError(err)) {
          db.prepare('UPDATE alerts SET sent_at_ms = ? WHERE id = ?').run(now(), last.id);
          return;
        }
        if (!shouldRecreateDashboardMessage(err)) {
          console.log(`[telegram] dashboard edit failed: ${err.message}`);
          return;
        }
      }
    }
    const sent = await sendTelegram(emptyText, navKeyboard());
    db.prepare(`
      INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(null, 'dashboard', 'dashboard_live', now(), sent.message_id, json({ openCount: 0 }));
    if (pin) await pinDashboardMessage(sent.message_id);
    return;
  }

  const rows = await Promise.all(positions.map(hydratePositionPnl));
  const winRateStats = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins
    FROM dry_run_positions WHERE status = 'closed'
  `).get();
  rows.winRate = winRateStats.total > 0 ? (winRateStats.wins / winRateStats.total * 100) : null;
  rows.winRateWins = winRateStats.wins || 0;
  rows.winRateTotal = winRateStats.total || 0;
  rows.balanceLine = balanceLine;
  const text = pnlUpdateText(rows);
  const extra = pnlUpdateButtons(rows);
  const last = db.prepare(`
    SELECT * FROM alerts
    WHERE kind = 'dashboard_live'
    ORDER BY id DESC
    LIMIT 1
  `).get();

  if (last?.telegram_message_id) {
    try {
      await bot.editMessageText(text, {
        chat_id: TELEGRAM_CHAT_ID,
        message_id: Number(last.telegram_message_id),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
      });
      db.prepare('UPDATE alerts SET sent_at_ms = ?, payload_json = ? WHERE id = ?').run(now(), json({ openCount: rows.length, rows }), last.id);
      if (pin) await pinDashboardMessage(last.telegram_message_id);
      return;
    } catch (err) {
      if (isNotModifiedError(err)) {
        db.prepare('UPDATE alerts SET sent_at_ms = ? WHERE id = ?').run(now(), last.id);
        return;
      }
      if (!shouldRecreateDashboardMessage(err)) {
        console.log(`[telegram] dashboard edit failed: ${err.message}`);
        return;
      }
    }
  }

  const sent = await sendTelegram(text, extra);
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(null, 'dashboard', 'dashboard_live', now(), sent.message_id, json({ openCount: rows.length, rows }));
  if (pin) await pinDashboardMessage(sent.message_id);
}

export async function sendPnlHeartbeatUpdate() {
  await sendDashboardLiveUpdate({ pin: false });
}
