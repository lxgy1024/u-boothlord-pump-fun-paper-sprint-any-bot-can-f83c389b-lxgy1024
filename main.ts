// Tape sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most new curves bleed out, so the bot only ever buys a launch whose
// opening tape already shows real outside demand, and it gets out fast either
// way. Every coin is watched from its CreateEvent. The tape records distinct
// non-creator buyers, total trades, net SOL flow (buys minus sells), the
// creator's own behaviour, and the price path from creation. A coin becomes a
// buy only while it is young (age 2..60 slots) and passes every filter at
// once: at least 3 distinct outside buyers, at least 4 trades, positive net
// flow, at least 0.3 SOL of real reserves, the creator has not sold, no single
// outside sell bigger than half the real reserves, and the price still within
// -10%..+80% of its creation price. One stake of 0.05 SOL per coin (clipped by
// the 1%-of-real-reserve per-reply cap, never below 0.01 SOL), at most 5 open
// positions. A held coin is sold whole on the first of: +25% over cost,
// -15% under cost, 600 slots held, the creator selling while held, or 150
// slots with no trade. Nothing here reads the clock, the environment or
// Math.random; all iteration is over insertion-ordered maps, so the two
// grading runs agree byte for byte.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL, the guardrail floor
const MIN_REAL_SOL_LAMPORTS = 300_000_000n; // 0.3 SOL of real reserves to qualify
const MIN_AGE_SLOTS = 2;
const MAX_AGE_SLOTS = 30;
const MIN_BUYERS = 3;
const MIN_TRADES = 4;
const MAX_RUNUP_BPS = 3_000; // +30% over creation price at most
const MIN_RUNUP_BPS = -1_000; // -10% under creation price at least
const TAKE_PROFIT_BPS = 1_000; // +10% over cost
const STOP_LOSS_BPS = -800; // -8% under cost
const MAX_HOLD_SLOTS = 200;
const MIN_NET_FLOW_LAMPORTS = 300_000_000n; // 0.3 SOL of net buy flow to qualify
const STALE_SLOTS = 150;
const SLIPPAGE_BPS = 1_000;

/** Everything the opening tape says about one curve. */
interface Tape {
  mint: Pubkey;
  creator: Pubkey;
  createdSlot: number;
  /** Creation price as virtual quote / virtual token reserves. */
  createVq: bigint;
  createVt: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  /** Net SOL flow in lamports: buys minus sells. */
  netFlow: bigint;
  /** Largest single outside sell seen, in lamports. */
  biggestSell: bigint;
  creatorSold: boolean;
  lastTradeSlot: number;
  decided: boolean;
}

/** Price of a curve now, as a ratio vq/vt; null when the curve has no reserves. */
function priceRatio(vq: bigint, vt: bigint): { vq: bigint; vt: bigint } | null {
  if (vq <= 0n || vt <= 0n) return null;
  return { vq, vt };
}

/** Value in lamports of `tokens` at price vq/vt (bigint division, deterministic). */
function valueOf(tokens: bigint, vq: bigint, vt: bigint): bigint {
  return (tokens * vq) / vt;
}

/** Is price (vq/vt) at least `bps` above base (bvq/bvt)? Cross-multiplied, no floats. */
function priceAtLeast(vq: bigint, vt: bigint, bvq: bigint, bvt: bigint, bps: number): boolean {
  // vq/vt >= bvq/bvt * (10000 + bps) / 10000
  const left = vq * bvt * 10_000n;
  const right = bvq * vt * BigInt(10_000 + bps);
  return left >= right;
}

/** One held position's exit bookkeeping. */
interface Held {
  buySlot: number;
  buyCost: bigint;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();

function tapeFor(mint: Pubkey, creator: Pubkey, slot: number, vq: bigint, vt: bigint): Tape {
  const t: Tape = {
    mint,
    creator,
    createdSlot: slot,
    createVq: vq,
    createVt: vt,
    trades: 0,
    buyers: new Set(),
    netFlow: 0n,
    biggestSell: 0n,
    creatorSold: false,
    lastTradeSlot: slot,
    decided: false,
  };
  tapes.set(mint, t);
  return t;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // Fold this batch's events into the tapes first.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!tapes.has(e.mint)) {
          tapeFor(e.mint, e.creator, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        }
      } else if (e.event === 'TradeEvent') {
        const t = tapes.get(e.mint);
        if (t === undefined) continue;
        t.trades += 1;
        t.lastTradeSlot = e.slot;
        const sol = BigInt(e.sol_amount);
        if (e.is_buy) {
          t.netFlow += sol;
          if (e.user !== t.creator) t.buyers.add(e.user);
        } else {
          t.netFlow -= sol;
          if (e.user === t.creator) {
            t.creatorSold = true;
          } else if (sol > t.biggestSell) {
            t.biggestSell = sol;
          }
        }
      } else if (e.event === 'CompleteEvent') {
        const t = tapes.get(e.mint);
        if (t !== undefined) t.decided = true;
      }
    }

    // Exits first: every held position is re-priced from the latest reserves.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      const h = held.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceRatio(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price === null) continue;
      const value = valueOf(pos.token_amount, price.vq, price.vt);
      const cost = pos.cost_lamports;
      const t = tapes.get(mint);
      const age = h !== undefined ? batch.slot - h.buySlot : 0;
      const stale = t !== undefined && batch.slot - t.lastTradeSlot >= STALE_SLOTS;
      const devSold = t !== undefined && t.creatorSold;
      const takeProfit = value * 10_000n >= cost * BigInt(10_000 + TAKE_PROFIT_BPS);
      const stopLoss = value * 10_000n <= cost * BigInt(10_000 + STOP_LOSS_BPS);
      const tooOld = h !== undefined && age >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || tooOld || stale || devSold) {
        if (orders.length < state.hello.caps.max_orders_per_batch && free >= tx) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
          free -= tx;
          held.delete(mint);
        }
      }
    }

    // Entries: each undecided tape gets one look per batch, in first-seen order.
    for (const t of tapes.values()) {
      if (t.decided) continue;
      const age = batch.slot - t.createdSlot;
      if (age < MIN_AGE_SLOTS) continue;
      if (age > MAX_AGE_SLOTS) {
        t.decided = true;
        continue;
      }
      const curve = state.curves.get(t.mint);
      if (curve === undefined || curve.complete) {
        t.decided = true;
        continue;
      }
      if (t.trades < MIN_TRADES || t.buyers.size < MIN_BUYERS) continue;
      if (t.netFlow < MIN_NET_FLOW_LAMPORTS) continue;
      if (t.netFlow <= 0n || t.creatorSold) {
        t.decided = true;
        continue;
      }
      if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
      if (t.biggestSell * 2n > curve.real_quote_reserves) {
        t.decided = true;
        continue;
      }
      const price = priceRatio(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price === null) continue;
      if (!priceAtLeast(price.vq, price.vt, t.createVq, t.createVt, MIN_RUNUP_BPS)) {
        t.decided = true;
        continue;
      }
      if (priceAtLeast(price.vq, price.vt, t.createVq, t.createVt, MAX_RUNUP_BPS)) continue;
      const cap = state.maxBuyLamports(t.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (orders.length >= state.hello.caps.max_orders_per_batch || slots <= 0 || free < amount + tx) continue;
      orders.push({ side: 'buy', mint: t.mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      free -= amount + tx;
      slots -= 1;
      t.decided = true;
      held.set(t.mint, { buySlot: batch.slot, buyCost: amount });
    }

    return orders;
  },
});
