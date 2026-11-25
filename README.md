# Tape Sniper — pump.fun paper-trading bot

[![u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lxgy1024/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-lxgy1024/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lxgy1024/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-lxgy1024/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A selective early-entry sniper for the pump.fun bonding-curve replay
(`agent-fun/replay/v2`). Most new curves bleed out, so the bot only buys a
launch whose opening tape already shows real outside demand, and it gets out
fast either way.

**Entry (one look per batch, age 2–60 slots):** at least 3 distinct
non-creator buyers, at least 4 trades, positive net SOL flow, at least 0.3
SOL of real reserves, the creator has not sold, no single outside sell bigger
than half the real reserves, and the price within −10%..+80% of its creation
price. One stake of 0.05 SOL per coin (clipped by the 1%-of-real-reserve
per-reply cap, never below 0.01 SOL), at most 5 open positions.

**Exits (checked every batch):** sell whole at +25% over cost, at −15%
under cost, after 600 slots held, when the creator sells while held, or after
150 slots with no trade.

`main.ts` is the strategy; `vendor/makefun-bot.ts` is the kit's own bot shim,
copied byte for byte. Paper trading only — the replay uses market data, never
real funds. Deterministic: no clock, no environment reads, no randomness.
