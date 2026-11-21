// Sokoban solver: per-room push-optimal A* with stitching through the hallway.
//
// Level structure (guaranteed by the generator): a 1-wide hallway row across the
// board where the player starts, plus 1-4 rooms off it, each with one door onto
// the hallway, 3-4 boxes and as many goals. A box pushed out of a room can never
// return, so a level's push-optimal count P* is the sum of its rooms' optima and
// each room can be solved independently, then stitched together by walking the
// player along the hallway.
//
// Per room: A* over pushes. The player starts on a "porch" cell (a hallway cell
// adjacent to the room's door), so a box sitting on the door cell is simply
// pushed in as the first push. A state is the sorted box positions plus the
// canonical player position (the smallest cell of the flood-fill region the
// player can reach without moving a box, over room + porch cells). The heuristic
// is the minimum assignment cost of BFS distances from each box to a goal
// (admissible: every push moves exactly one box by one square). Dead squares
// (cells no goal is reachable from by reverse pulls) and full 2x2 wall/box
// blocks prune the search. A* over pushes is optimal, so a solved room costs
// its optimum. A solution must also leave the player able to reach a porch
// cell again, so the player can walk on to the next room.
//
// Determinism: the search is budgeted by NODE COUNT only. No wall clock, no
// Math.random, no environment-dependent branching anywhere, so two runs
// produce byte-identical output.
//
// Node 22, erasable TypeScript only, node builtins only, no dependencies.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Generous deterministic node budget per room (expansions). Rooms are tiny. */
const ROOM_NODE_BUDGET = 4_000_000;

type Dir = { dx: number; dy: number; ch: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

// ---------------------------------------------------------------------------
// Level parsing
// ---------------------------------------------------------------------------

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goals: Set<number>;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').map((r) => r.replace(/\r$/, '')).filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if (ch === '.' || ch === '*' || ch === '+') goals.add(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** BFS walk from `from` to `to` over `walkCells` avoiding `blocked`; returns move letters, or null. */
function bfsWalk(
  w: number,
  h: number,
  from: number,
  to: number,
  walkCells: Set<number>,
  blocked: Set<number>,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, number>();
  const prevCh = new Map<number, string>();
  const q: number[] = [from];
  prev.set(from, -1);
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!walkCells.has(n) || prev.has(n) || blocked.has(n)) continue;
      prev.set(n, c);
      prevCh.set(n, d.ch);
      if (n === to) {
        let moves = '';
        for (let t = n; t !== from; t = prev.get(t)!) moves = prevCh.get(t)! + moves;
        return moves;
      }
      q.push(n);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-room push-optimal A*
// ---------------------------------------------------------------------------

interface RoomSolution {
  /** Pushes in order: [fromCell, toCell, dirCh] with global cell indices. */
  pushes: { from: number; to: number; ch: string }[];
  /** The porch cell (global) the player must stand on to start this solution. */
  entryCell: number;
  /** Player cell (global) after the last push. */
  endPlayer: number;
  /** Box cells (global) after the solution. */
  endBoxes: number[];
  pushesCount: number;
}

interface RoomSpec {
  /** Room floor cells (global indices), sorted. Boxes never leave these. */
  cells: number[];
  goals: number[];
  boxes: number[];
  /** Porch cells: hallway cells adjacent to a door cell of this room. */
  porch: number[];
}

/**
 * Solve one room push-optimally. The player starts on one of the porch cells
 * and, when requireExit is set, must finish able to reach a porch cell again
 * (so the player can leave for the next room). Returns null if no solution
 * is found within the node budget.
 */
function solveRoom(level: Level, room: RoomSpec, requireExit: boolean): RoomSolution | null {
  const { w } = level;
  const roomSet = new Set(room.cells);
  const porchSet = new Set(room.porch);
  const moveSet = new Set<number>([...room.cells, ...room.porch]);
  const goalSet = new Set(room.goals);
  const boxes0 = [...room.boxes].sort((a, b) => a - b);

  // Neighbour cell of `c` in direction k (global index), or -1 when the cell
  // is not walkable (room or porch) for movement, resp. not a room cell.
  const moveNb = (c: number, k: number): number => {
    const d = DIRS[k]!;
    const nx = (c % w) + d.dx;
    const ny = ((c / w) | 0) + d.dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= level.h) return -1;
    const n = ny * w + nx;
    return moveSet.has(n) ? n : -1;
  };
  const roomNb = (c: number, k: number): number => {
    const n = moveNb(c, k);
    return n >= 0 && roomSet.has(n) ? n : -1;
  };

  // All-pairs BFS distances on room floor (ignoring boxes), indexed by
  // position in room.cells.
  const idx = new Map<number, number>();
  room.cells.forEach((g, i) => idx.set(g, i));
  const n = room.cells.length;
  const dist: Int16Array[] = [];
  for (let a = 0; a < n; a++) {
    const d = new Int16Array(n).fill(-1);
    const q: number[] = [a];
    d[a] = 0;
    for (let head = 0; head < q.length; head++) {
      const c = q[head]!;
      for (let k = 0; k < 4; k++) {
        const nb = roomNb(room.cells[c]!, k);
        if (nb >= 0) {
          const j = idx.get(nb)!;
          if (d[j] < 0) {
            d[j] = d[c]! + 1;
            q.push(j);
          }
        }
      }
    }
    dist.push(d);
  }

  // Dead squares: cells from which no goal is reachable by reverse pulls.
  // Reverse pull: a box at b could have come from b' = b - d if b' is a room
  // cell and the player could stand at b' - d (a room or porch cell).
  const alive = new Array<boolean>(n).fill(false);
  const rq: number[] = [];
  for (const g of room.goals) {
    alive[idx.get(g)!] = true;
    rq.push(g);
  }
  for (let head = 0; head < rq.length; head++) {
    const b = rq[head]!;
    for (let k = 0; k < 4; k++) {
      const bp = roomNb(b, k ^ 1); // predecessor cell b' = b - d_k
      if (bp < 0 || alive[idx.get(bp)!]) continue;
      if (moveNb(bp, k ^ 1) < 0) continue; // player must stand at b' - d_k
      alive[idx.get(bp)!] = true;
      rq.push(bp);
    }
  }
  const dead = new Set<number>();
  room.cells.forEach((g, i) => {
    if (!alive[i]) dead.add(g);
  });

  // 2x2 blocks fully filled with walls/boxes (a box in one can never move).
  // A block cell that is neither a room cell nor a wall (e.g. a porch cell)
  // breaks the block.
  const blocks: number[][] = [];
  for (const g of room.cells) {
    const x = g % w;
    const y = (g / w) | 0;
    if (x + 1 >= w || y + 1 >= level.h) continue;
    const quad = [g, g + 1, g + w, g + w + 1];
    let ok = true;
    for (const c of quad) {
      if (!roomSet.has(c) && !level.wall[c]) {
        ok = false;
        break;
      }
    }
    if (ok) blocks.push(quad);
  }

  const goalList = [...room.goals].sort((a, b) => a - b);
  // Permutations of goal indices, for the assignment heuristic.
  const perms: number[][] = [];
  const buildPerm = (cur: number[], used: boolean[]): void => {
    if (cur.length === goalList.length) {
      perms.push([...cur]);
      return;
    }
    for (let i = 0; i < goalList.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      buildPerm(cur, used);
      cur.pop();
      used[i] = false;
    }
  };
  buildPerm([], new Array<boolean>(goalList.length).fill(false));

  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < boxes.length; i++) {
        const d = dist[idx.get(boxes[i]!)!]![idx.get(goalList[p[i]!]!)!]!;
        if (d < 0) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };

  /** Flood-fill region reachable from `start` avoiding boxes (room+porch). */
  const region = (start: number, boxSet: Set<number>): { canon: number; set: Set<number> } => {
    const set = new Set<number>([start]);
    const q: number[] = [start];
    let canon = start;
    for (let head = 0; head < q.length; head++) {
      const c = q[head]!;
      if (c < canon) canon = c;
      for (let k = 0; k < 4; k++) {
        const nb = moveNb(c, k);
        if (nb >= 0 && !boxSet.has(nb) && !set.has(nb)) {
          set.add(nb);
          q.push(nb);
        }
      }
    }
    return { canon, set };
  };

  const isDeadState = (boxes: number[]): boolean => {
    for (const b of boxes) if (dead.has(b)) return true;
    if (blocks.length > 0) {
      const boxSet = new Set(boxes);
      for (const blk of blocks) {
        let full = true;
        let hasBoxOffGoal = false;
        for (const c of blk) {
          if (level.wall[c]) continue; // wall cell: filled
          if (boxSet.has(c)) {
            if (!goalSet.has(c)) hasBoxOffGoal = true;
          } else {
            full = false; // room floor cell with no box on it
            break;
          }
        }
        if (full && hasBoxOffGoal) return true;
      }
    }
    return false;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet.has(b));

  // --- A* over pushes ---
  const stBoxes: number[][] = [];
  const stCanon: number[] = [];
  const stPlayer: number[] = []; // actual player cell after arriving in this state
  const stParent: number[] = [];
  const stPush: { from: number; to: number; dir: number }[] = [];
  const stG: number[] = [];
  const bestG = new Map<string, number>();
  const keyOf = (boxes: number[], canon: number): string => boxes.join(',') + '|' + canon;

  const initSeen = new Set<number>();
  for (const e of [...room.porch].sort((a, b) => a - b)) {
    const boxSet = new Set(boxes0);
    const { canon } = region(e, boxSet);
    if (initSeen.has(canon)) continue;
    initSeen.add(canon);
    const k = keyOf(boxes0, canon);
    if (bestG.has(k)) continue;
    bestG.set(k, 0);
    stBoxes.push([...boxes0]);
    stCanon.push(canon);
    stPlayer.push(e);
    stParent.push(-1);
    stPush.push({ from: -1, to: -1, dir: -1 });
    stG.push(0);
  }
  if (stBoxes.length === 0) return null;

  // Binary heap of [f, -g, stateIndex]; tie-break by state index (insertion order).
  const heap: number[][] = [];
  const heapLess = (a: number[], b: number[]): boolean =>
    a[0]! < b[0]! || (a[0]! === b[0]! && (a[1]! < b[1]! || (a[1]! === b[1]! && a[2]! < b[2]!)));
  const heapPush = (e: number[]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number[] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  for (let s = 0; s < stBoxes.length; s++) {
    heapPush([heuristic(stBoxes[s]!), 0, s]);
  }

  let expanded = 0;
  let goalState = -1;
  while (heap.length > 0 && expanded < ROOM_NODE_BUDGET) {
    const [f, negG, s] = heapPop() as [number, number, number];
    const g = -negG;
    if (bestG.get(keyOf(stBoxes[s]!, stCanon[s]!)) !== g) continue; // stale entry
    const boxes = stBoxes[s]!;
    if (solved(boxes)) {
      if (!requireExit) {
        goalState = s;
        break;
      }
      const boxSet = new Set(boxes);
      const { set } = region(stCanon[s]!, boxSet);
      let canExit = false;
      for (const e of room.porch) {
        if (set.has(e)) {
          canExit = true;
          break;
        }
      }
      if (canExit) {
        goalState = s;
        break;
      }
      // Solved but stranded: keep searching for a solvable-and-exitable state.
      continue;
    }
    expanded++;
    const boxSet = new Set(boxes);
    const { set: reach } = region(stCanon[s]!, boxSet);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const behind = moveNb(b, k ^ 1); // player must stand here (opposite dir)
        const target = roomNb(b, k);
        if (behind < 0 || target < 0) continue;
        if (!reach.has(behind)) continue;
        if (boxSet.has(target)) continue;
        if (dead.has(target)) continue;
        const nb = [...boxes];
        nb[bi] = target;
        nb.sort((a, b2) => a - b2);
        if (isDeadState(nb)) continue;
        const { canon } = region(b, new Set(nb));
        const ng = g + 1;
        const key = keyOf(nb, canon);
        const prev = bestG.get(key);
        if (prev !== undefined && prev <= ng) continue;
        bestG.set(key, ng);
        const ns = stBoxes.length;
        stBoxes.push(nb);
        stCanon.push(canon);
        stPlayer.push(b); // player ends on the box's old cell
        stParent.push(s);
        stPush.push({ from: b, to: target, dir: k });
        stG.push(ng);
        heapPush([ng + heuristic(nb), -ng, ns]);
      }
    }
  }

  if (goalState < 0) return null;

  // Reconstruct the push list and the porch cell used.
  const chain: number[] = [];
  for (let t = goalState; t >= 0; t = stParent[t]!) chain.push(t);
  chain.reverse();
  const entryCell = stPlayer[chain[0]!]!;
  const pushes: { from: number; to: number; ch: string }[] = [];
  for (let i = 1; i < chain.length; i++) {
    const p = stPush[chain[i]!]!;
    pushes.push({ from: p.from, to: p.to, ch: DIRS[p.dir]!.ch });
  }
  return {
    pushes,
    entryCell,
    endPlayer: stPlayer[goalState]!,
    endBoxes: [...stBoxes[goalState]!],
    pushesCount: stG[goalState]!,
  };
}

// ---------------------------------------------------------------------------
// Whole-level driver: decompose, solve rooms, stitch
// ---------------------------------------------------------------------------

/** Expand a room solution into LURD moves; player starts on sol.entryCell. */
function roomMoves(
  level: Level,
  room: RoomSpec,
  sol: RoomSolution,
  boxesNow: Set<number>,
): { moves: string; endPlayer: number } | null {
  const { w, h } = level;
  const moveSet = new Set<number>([...room.cells, ...room.porch]);
  let moves = '';
  let player = sol.entryCell;
  const boxes = new Set(boxesNow);
  for (const p of sol.pushes) {
    const dx = p.to % w - p.from % w;
    const dy = ((p.to / w) | 0) - ((p.from / w) | 0);
    const dir = DIRS.find((d) => d.dx === dx && d.dy === dy)!;
    const behind = p.from - (dir.dy * w + dir.dx);
    const walk = bfsWalk(w, h, player, behind, moveSet, boxes);
    if (walk === null) return null;
    moves += walk + dir.ch;
    boxes.delete(p.from);
    boxes.add(p.to);
    player = p.from;
  }
  return { moves, endPlayer: player };
}

function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { w, h } = level;
  const hallwayRow = (level.player / w) | 0;
  const floorSet = new Set<number>();
  for (let i = 0; i < w * h; i++) if (!level.wall[i]) floorSet.add(i);

  // Rooms: connected components of non-wall cells outside the hallway row.
  const seen = new Array<boolean>(w * h).fill(false);
  const rooms: RoomSpec[] = [];
  for (let i = 0; i < w * h; i++) {
    if (level.wall[i] || seen[i]) continue;
    const y = (i / w) | 0;
    if (y === hallwayRow) continue;
    const comp: number[] = [];
    const q: number[] = [i];
    seen[i] = true;
    for (let head = 0; head < q.length; head++) {
      const c = q[head]!;
      comp.push(c);
      const cx = c % w;
      const cy = (c / w) | 0;
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (level.wall[n] || seen[n] || ((n / w) | 0) === hallwayRow) continue;
        seen[n] = true;
        q.push(n);
      }
    }
    comp.sort((a, b) => a - b);
    const compSet = new Set(comp);
    const goals = [...level.goals].filter((g) => compSet.has(g));
    const boxes = level.boxes.filter((b) => compSet.has(b));
    if (boxes.length === 0) continue; // decorative alcove, ignore
    // Door cells: room cells adjacent to a hallway-row floor cell.
    const doors: number[] = [];
    for (const c of comp) {
      const cx = c % w;
      const cy = (c / w) | 0;
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (ny === hallwayRow && nx >= 0 && nx < w && !level.wall[ny * w + nx]) {
          doors.push(c);
          break;
        }
      }
    }
    // Porch cells: hallway-row floor cells adjacent to a door cell.
    const porchSet = new Set<number>();
    for (const dc of doors) {
      const cx = dc % w;
      const cy = (dc / w) | 0;
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (ny === hallwayRow && nx >= 0 && nx < w && !level.wall[ny * w + nx]) {
          porchSet.add(ny * w + nx);
        }
      }
    }
    rooms.push({ cells: comp, goals, boxes, porch: [...porchSet].sort((a, b) => a - b) });
  }

  // Deterministic room order: by smallest porch cell.
  rooms.sort((a, b) => (a.porch[0] ?? 0) - (b.porch[0] ?? 0));

  // If decomposition failed (no rooms but boxes exist), treat the whole board
  // as one room entered from the player's start cell.
  if (rooms.length === 0 && level.boxes.length > 0) {
    const whole: RoomSpec = {
      cells: [...floorSet].sort((a, b) => a - b),
      goals: [...level.goals],
      boxes: [...level.boxes],
      porch: [level.player],
    };
    const sol = solveRoom(level, whole, false);
    if (sol === null) return '';
    const rm = roomMoves(level, whole, sol, new Set(level.boxes));
    return rm === null ? '' : rm.moves;
  }

  let moves = '';
  let player = level.player;
  const boxesNow = new Set(level.boxes);
  for (const room of rooms) {
    let sol = solveRoom(level, room, true);
    if (sol === null) {
      // Retry without the exit requirement; the player may still be able to
      // leave (the exit test is conservative in which porch cell it accepts).
      sol = solveRoom(level, room, false);
    }
    if (sol === null) return ''; // give up on this instance, keep the others
    // Walk the player to the room's porch cell (any floor, avoiding boxes).
    const walk = bfsWalk(w, h, player, sol.entryCell, floorSet, boxesNow);
    if (walk === null) return '';
    moves += walk;
    player = sol.entryCell;
    const rm = roomMoves(level, room, sol, boxesNow);
    if (rm === null) return '';
    moves += rm.moves;
    player = rm.endPlayer;
    // Update global boxes: remove the room's old boxes, add its solved ones.
    for (const b of room.boxes) boxesNow.delete(b);
    for (const b of sol.endBoxes) boxesNow.add(b);
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
