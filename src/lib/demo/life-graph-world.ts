// Generates the dense field of nodes behind the life graph.
//
// The atmosphere is procedurally generated but *deterministic*: a fixed-seed
// PRNG means the same sprawl every render. That matters more than it sounds — a
// graph that reshuffles between rehearsal and pitch is a graph nobody can learn
// to talk over. It also keeps the field identical on the server and the client.

// MARK: - Deterministic randomness

const MASK = (1n << 64n) - 1n
const MULTIPLIER = 6364136223846793005n
const INCREMENT = 1442695040888963407n

/**
 * Small 64-bit LCG, seeded once, so the world is reproducible frame to frame
 * and run to run. `Math.random` would reshuffle on every mount.
 */
export class SeededRandom {
  private state: bigint

  constructor(seed: bigint) {
    this.state = seed & MASK
  }

  unit(): number {
    this.state = (this.state * MULTIPLIER + INCREMENT) & MASK
    return Number(this.state >> 11n) / 2 ** 53
  }

  range(low: number, high: number): number {
    return low + this.unit() * (high - low)
  }

  chance(probability: number): boolean {
    return this.unit() < probability
  }
}

// MARK: - Palette

export type DotColor = "orange" | "blue" | "lavender" | "blush" | "sage"

export const DOT_COLOR: Record<DotColor, string> = {
  orange: "rgb(242, 107, 56)",
  blue: "rgb(92, 156, 232)",
  lavender: "rgb(163, 140, 214)",
  blush: "rgb(242, 161, 173)",
  sage: "rgb(128, 186, 140)",
}

/** Orange, blue and lavender dominate; the other two are accents. */
function weightedColor(rng: SeededRandom): DotColor {
  const roll = rng.unit()
  if (roll < 0.31) return "orange"
  if (roll < 0.62) return "blue"
  if (roll < 0.88) return "lavender"
  if (roll < 0.95) return "blush"
  return "sage"
}

// MARK: - Nodes

export type AtmosphereNode = {
  /** Normalised world coordinates. Values outside 0…1 bleed off the edges,
   *  which is what makes the field feel larger than the window. */
  x: number
  y: number
  /** Fraction of the *window's* short edge, not the world's. */
  radius: number
  color: DotColor
  label: string | null
  labelScale: number
  isPill: boolean
  /** Whether a hairline runs back to the centre. */
  tethered: boolean
}

export type LifeGraphWorld = {
  center: { x: number; y: number }
  nodes: AtmosphereNode[]
  scenarioAnchors: { x: number; y: number }[]
}

/**
 * How much larger the world is than the window. Everything is rendered at this
 * multiple and panned within it — without it there'd be nothing to pan *to*,
 * just white space at the edges.
 */
export const WORLD_SCALE = 1.75

/**
 * Hand-placed so the five playable nodes stay clear of each other and of the
 * dense core — and all sit inside the region visible before the user pans
 * anywhere, which at WORLD_SCALE is roughly 0.21…0.79.
 */
export const SCENARIO_ANCHORS = [
  { x: 0.31, y: 0.3 },
  { x: 0.69, y: 0.315 },
  { x: 0.7, y: 0.615 },
  { x: 0.315, y: 0.64 },
  { x: 0.545, y: 0.705 },
]

export const CENTER_ANCHOR = { x: 0.5, y: 0.455 }

function tooClose(
  a: { x: number; y: number },
  b: { x: number; y: number },
  within: number,
): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < within
}

/** Fisher–Yates against the seeded generator, so contact ordering is stable. */
function shuffledDeterministically<T>(items: T[], rng: SeededRandom): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng.unit() * (i + 1)) % (i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/**
 * Node count scales with world area (WORLD_SCALE² ≈ 3×) so density holds steady
 * as the field grows past the window.
 */
export function buildLifeGraphWorld(castNames: string[] = [], nodeCount = 620): LifeGraphWorld {
  const rng = new SeededRandom(0x5eedb10dn)
  const nodes: AtmosphereNode[] = []

  // Real contacts get salted in first so the graph feels like the user's own
  // life rather than stock content.
  const labelPool = [...shuffledDeterministically(castNames, rng), ...VOCABULARY]

  for (let i = 0; i < nodeCount; i++) {
    const theta = rng.range(0, Math.PI * 2)
    // An exponent below 1 biases toward the centre, giving the dense core.
    const falloff = Math.pow(rng.unit(), 0.55)
    const reach = falloff * 0.78

    const point = {
      x: CENTER_ANCHOR.x + Math.cos(theta) * reach * 1.08,
      y: CENTER_ANCHOR.y + Math.sin(theta) * reach * 1.02,
    }

    // Keep the playable nodes and the centre legible.
    if (tooClose(point, CENTER_ANCHOR, 0.075)) continue
    if (SCENARIO_ANCHORS.some((anchor) => tooClose(point, anchor, 0.062))) continue

    // Radii as a fraction of the window's short edge. The floor is set by
    // legibility rather than by the distribution — below roughly 0.0035 a dot
    // reads as a speck of dust instead of a node.
    const base = rng.range(0.0105, 0.025)
    const bump = rng.chance(0.1) ? rng.range(0.01, 0.03) : 0

    const wantsLabel = rng.chance(0.34) && labelPool.length > 0
    const label = wantsLabel ? (labelPool.pop() ?? null) : null

    nodes.push({
      x: point.x,
      y: point.y,
      radius: base + bump,
      color: weightedColor(rng),
      label,
      labelScale: rng.chance(0.12) ? rng.range(0.019, 0.028) : rng.range(0.009, 0.015),
      isPill: wantsLabel && rng.chance(0.07),
      tethered: rng.chance(0.42),
    })
  }

  return { center: CENTER_ANCHOR, nodes, scenarioAnchors: SCENARIO_ANCHORS }
}

/**
 * Plausible life-graph vocabulary: places, people, brands, tastes, habits.
 * Stand-in for what the extraction stage will actually surface.
 */
export const VOCABULARY: string[] = [
  "Blue Bottle Coffee", "Interior Design", "Silver Jewelry", "Farmer's Market",
  "Road Trips", "Espresso", "Men's Fashion", "Korean Skincare", "Vintage Furniture",
  "Personal Finance", "Hot Girl Walk", "Clean Girl Aesthetic", "Film Camera",
  "Skateboarding", "Surfing", "Baking", "Bagels", "Banchan", "Japanese",
  "Cantonese", "Korean Drama", "Netflix", "Mubi", "Spotify Wrapped", "EDM",
  "Funk", "The Weeknd", "Otis Redding", "Solange", "Daniel Caesar", "Kanye West",
  "Tyler, The Creator", "Ocean Grey", "Peaches", "New York", "NYC", "Brooklyn",
  "San Francisco", "Pittsburgh", "Hawaii", "Mykonos", "Amalfi Coast", "The Met",
  "704 Bedford Ave", "Queens", "Econ", "Comm 101", "PHYS 1140", "Figma",
  "Pinterest", "SKIMS", "Moscot", "Heineken", "Red Bull", "MMA", "Piano",
  "Photography", "Journaling", "Prayer", "Workouts", "Reading", "Therapy",
  "Healing Era", "Reinvention", "First Heartbreak", "Church", "Sunday Service",
  "Group Chat", "Left On Read", "Situationship", "The Ex", "Best Friend",
  "Little Brother", "Cousins", "Aunt Rosa", "Mom", "Dad", "Roommate",
  "Freelance", "Growth Marketing", "Contract Work", "Future Startup",
  "Financial Freedom", "Travel The World", "Impact Millions", "A Book Deal",
  "My Own Company", "Peace", "Legacy", "Make Art", "Own Freedom",
  "Leslie", "Adelle", "April", "Thomas Keen", "Adam Gauvin", "Jason Kwon",
  "Jennifer Pyo", "Myron Ngan", "Diana Xiao", "Jasmine Jin", "Julie Tang",
  "Jack Fan", "Syriana Lee", "Angela Lozano", "Daniel Silva", "Sawyer",
  "Harvin Park", "Honeypls", "Destiny", "Iced Tea", "Green Juice",
  "Gunpla", "Nikon F4", "1989", "Offline", "Random Convos", "Internet Strangers",
]
