[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/imnotripper/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/imnotripper/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban solver — per-room push-optimal A*

A Sokoban solver for the [make.fun bounty sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121). It solves every level in exactly P\* pushes (the push-optimal count), scoring a perfect 1,000,000 on the practice set.

## How it works

Each level is a 1-wide hallway with 1–4 rooms off it. A box pushed out of a room can never return, so the level's push-optimal count is the sum of its rooms' optima, and each room can be solved independently:

1. **Decompose** — the hallway row is the row the player starts on; rooms are the connected components of floor cells off that row. Each room has a "porch" (the hallway cells adjacent to its door), so a box sitting on the door cell is simply pushed in as the first push.
2. **Per-room A\* over pushes** — a state is the sorted box positions plus the canonical player position (smallest cell of the flood-fill region reachable without moving a box). The heuristic is the minimum-assignment cost of BFS distances from each box to a goal, which is admissible, so A\* is push-optimal. Dead squares (no goal reachable by reverse pulls) and full 2×2 wall/box blocks prune the search. A solution must also leave the player able to reach the porch again, so the player can walk on to the next room.
3. **Stitch** — the player walks along the hallway (BFS, avoiding boxes) to each room's porch, the room's move sequence is expanded into LURD moves, and the process repeats.

## Properties

- **Deterministic**: the search is budgeted by node count only — no wall clock, no randomness, no environment-dependent branching — so two runs produce byte-identical output.
- **Fast**: the whole 5-instance practice set solves in ~0.5 s (limit: 60 s).
- **Self-contained**: a single `main.ts`, Node 22, erasable TypeScript, node builtins only, no dependencies, no network.

## Practice results

| instance | pushes | P\* | points |
|----------|--------|-----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

Total practice score: **1,000,000** (house baseline plain-astar 1.0.0 scores 200,000 on the same set).

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
