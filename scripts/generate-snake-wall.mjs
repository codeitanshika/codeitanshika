// Fetches the real GitHub contribution calendar and animates a snake that
// treats contributed days as walls (never crosses or clears them) instead of
// food to eat. Path is a greedy nearest-unvisited walk with BFS routing
// through empty (0-contribution) cells only; disconnected pockets of empty
// cells fall back to a direct jump since no in-grid route exists.

const username = process.env.GH_USERNAME;
const token = process.env.GITHUB_TOKEN;

if (!username || !token) {
  console.error("GH_USERNAME and GITHUB_TOKEN env vars are required");
  process.exit(1);
}

const query = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
              weekday
            }
          }
        }
      }
    }
  }
`;

async function fetchCalendar() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: username } }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data.user.contributionsCollection.contributionCalendar.weeks;
}

function levelFor(count) {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 8) return 3;
  return 4;
}

function buildGrid(weeks) {
  const cols = weeks.length;
  const grid = Array.from({ length: cols }, () => Array(7).fill(null));
  weeks.forEach((week, col) => {
    week.contributionDays.forEach((day) => {
      grid[col][day.weekday] = {
        count: day.contributionCount,
        level: levelFor(day.contributionCount),
      };
    });
  });
  return grid;
}

function key(c, r) {
  return `${c},${r}`;
}

// BFS from `start` through walkable (empty, level 0) cells looking for the
// nearest cell present in `targets`. Returns the cell path (inclusive of
// start) or null if none of the targets are reachable.
function bfsToNearest(grid, cols, start, targets) {
  const queue = [start];
  const seen = new Set([key(start.c, start.r)]);
  const parent = new Map();

  while (queue.length) {
    const cur = queue.shift();
    if (targets.has(key(cur.c, cur.r)) && !(cur.c === start.c && cur.r === start.r)) {
      const path = [cur];
      let k = key(cur.c, cur.r);
      while (parent.has(k)) {
        const p = parent.get(k);
        path.push(p);
        k = key(p.c, p.r);
      }
      return path.reverse();
    }
    const neighbors = [
      { c: cur.c - 1, r: cur.r },
      { c: cur.c + 1, r: cur.r },
      { c: cur.c, r: cur.r - 1 },
      { c: cur.c, r: cur.r + 1 },
    ];
    for (const n of neighbors) {
      if (n.c < 0 || n.c >= cols || n.r < 0 || n.r > 6) continue;
      const cell = grid[n.c][n.r];
      if (!cell || cell.level !== 0) continue; // wall or out of range
      const nk = key(n.c, n.r);
      if (seen.has(nk)) continue;
      seen.add(nk);
      parent.set(nk, cur);
      queue.push(n);
    }
  }
  return null;
}

function computePath(grid, cols) {
  const empties = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 7; r++) {
      if (grid[c][r] && grid[c][r].level === 0) empties.push({ c, r });
    }
  }
  if (empties.length === 0) return [];

  const remaining = new Set(empties.map((e) => key(e.c, e.r)));
  let current = empties[0];
  remaining.delete(key(current.c, current.r));
  const path = [current];

  while (remaining.size > 0) {
    const routed = bfsToNearest(grid, cols, current, remaining);
    if (routed) {
      // routed[0] is `current` itself (BFS backtrack includes the start
      // node); it's already the last entry in `path`, so skip it here.
      const steps = routed.slice(1);
      for (const cell of steps) {
        path.push(cell);
        remaining.delete(key(cell.c, cell.r));
      }
      current = steps[steps.length - 1];
    } else {
      // no reachable unvisited empty cell (disconnected pocket) - jump to
      // the closest remaining cell by straight-line distance
      let best = null;
      let bestDist = Infinity;
      for (const k of remaining) {
        const [c, r] = k.split(",").map(Number);
        const d = Math.hypot(c - current.c, r - current.r);
        if (d < bestDist) {
          bestDist = d;
          best = { c, r };
        }
      }
      path.push(best);
      remaining.delete(key(best.c, best.r));
      current = best;
    }
  }
  return path;
}

const CELL = 11;
const GAP = 3;
const MARGIN = 4;
const STEP_DURATION = 0.09; // seconds per grid step

const PALETTES = {
  light: {
    bg: "none",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: "#000000",
  },
  dark: {
    bg: "none",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: "#ffffff",
  },
};

function cellCenter(c, r) {
  return {
    x: MARGIN + c * (CELL + GAP) + CELL / 2,
    y: MARGIN + r * (CELL + GAP) + CELL / 2,
  };
}

function renderSvg(grid, cols, path, palette) {
  const width = MARGIN * 2 + cols * (CELL + GAP) - GAP;
  const height = MARGIN * 2 + 7 * (CELL + GAP) - GAP;

  const cells = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 7; r++) {
      const cell = grid[c][r];
      if (!cell) continue;
      const x = MARGIN + c * (CELL + GAP);
      const y = MARGIN + r * (CELL + GAP);
      cells.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${palette.levels[cell.level]}" />`
      );
    }
  }

  const motionPath = path.length
    ? "M " + path.map((p) => { const { x, y } = cellCenter(p.c, p.r); return `${x},${y}`; }).join(" L ")
    : "";
  const dur = Math.max(path.length * STEP_DURATION, 1);

  const bodySegments = [
    { size: CELL * 0.9, opacity: 1, delay: 0 },
    { size: CELL * 0.8, opacity: 0.85, delay: 0.22 },
    { size: CELL * 0.7, opacity: 0.65, delay: 0.44 },
    { size: CELL * 0.55, opacity: 0.4, delay: 0.66 },
  ];

  const snakeEls = path.length
    ? bodySegments
        .map(({ size, opacity, delay }) => {
          const half = size / 2;
          return `<rect x="${-half}" y="${-half}" width="${size}" height="${size}" rx="2" fill="${palette.snake}" opacity="${opacity}">
    <animateMotion dur="${dur}s" begin="${delay}s" repeatCount="indefinite" path="${motionPath}" rotate="0" calcMode="linear" />
  </rect>`;
        })
        .join("\n  ")
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${palette.bg}" />
  ${cells.join("\n  ")}
  ${snakeEls}
</svg>
`;
}

async function main() {
  const weeks = await fetchCalendar();
  const grid = buildGrid(weeks);
  const cols = weeks.length;
  const path = computePath(grid, cols);

  const fs = await import("node:fs/promises");
  await fs.mkdir("profile", { recursive: true });
  await fs.writeFile("profile/snake-wall.svg", renderSvg(grid, cols, path, PALETTES.light));
  await fs.writeFile("profile/snake-wall-dark.svg", renderSvg(grid, cols, path, PALETTES.dark));
  console.log(`Generated snake-wall SVGs. Path length: ${path.length} cells across ${cols} weeks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
