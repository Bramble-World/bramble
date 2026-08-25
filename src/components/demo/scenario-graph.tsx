"use client"

import Image from "next/image"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  buildLifeGraphWorld,
  DOT_COLOR,
  WORLD_SCALE,
  type AtmosphereNode,
  type LifeGraphWorld,
} from "@/lib/demo/life-graph-world"
import { ACCENT_COLOR, MAIN_CHARACTER, SCENARIOS, type Scenario } from "@/lib/demo/scenarios"
import { PortraitCircle } from "./portrait-circle"

// The life graph. A dense procedural field of everything the system knows about
// the user, with the five playable scenarios sitting on top as the only
// interactive nodes.
//
// The world is rendered larger than the viewport and panned inside it, so there
// is genuinely more graph than screen. Two layers: the atmosphere is hundreds of
// dots, lines and labels in a single canvas; only the handful of interactive
// nodes are real DOM.

const MIN_ZOOM = 0.55
const MAX_ZOOM = 2.4
/** Below this a pointer gesture is a click, not a pan. */
const DRAG_SLOP = 4

type Point = { x: number; y: number }

export function ScenarioGraph({
  castNames,
  onSelect,
}: {
  castNames: string[]
  onSelect: (scenario: Scenario) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [size, setSize] = useState({ w: 0, h: 0 })
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [hovered, setHovered] = useState<string | null>(null)

  const world = useMemo(() => buildLifeGraphWorld(castNames), [castNames])

  const unit = Math.min(size.w, size.h)
  const worldW = size.w * WORLD_SCALE
  const worldH = size.h * WORLD_SCALE

  // MARK: - Measurement

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ w: width, h: height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // MARK: - Panning limits

  /** Keeps the world covering the viewport — you can explore to the edges but
   *  never drag the graph off into blank space. */
  const clampPan = useCallback(
    (proposed: Point, atZoom: number): Point => {
      const limitX = Math.max(0, (worldW * atZoom - size.w) / 2)
      const limitY = Math.max(0, (worldH * atZoom - size.h) / 2)
      return {
        x: Math.min(Math.max(proposed.x, -limitX), limitX),
        y: Math.min(Math.max(proposed.y, -limitY), limitY),
      }
    },
    [worldW, worldH, size.w, size.h],
  )

  const applyZoom = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM)
      setZoom(clamped)
      setPan((current) => clampPan(current, clamped))
    },
    [clampPan],
  )

  const resetView = useCallback(() => {
    setPan({ x: 0, y: 0 })
    setZoom(1)
  }, [])

  // MARK: - Gestures

  const pointers = useRef(new Map<number, Point>())
  const gestureStart = useRef<{ point: Point; pan: Point } | null>(null)
  const pinchStart = useRef<{ distance: number; zoom: number } | null>(null)
  /** Consulted by the node click handler so a pan never opens a scenario. */
  const moved = useRef(false)

  const pointerDistance = () => {
    const [a, b] = [...pointers.current.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  const onPointerDown = (event: React.PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    moved.current = false

    if (pointers.current.size === 2) {
      pinchStart.current = { distance: pointerDistance(), zoom }
      gestureStart.current = null
    } else if (pointers.current.size === 1) {
      gestureStart.current = { point: { x: event.clientX, y: event.clientY }, pan }
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.current.size === 2 && pinchStart.current) {
      moved.current = true
      const ratio = pointerDistance() / (pinchStart.current.distance || 1)
      applyZoom(pinchStart.current.zoom * ratio)
      return
    }

    const start = gestureStart.current
    if (!start) return
    const delta = { x: event.clientX - start.point.x, y: event.clientY - start.point.y }
    if (Math.hypot(delta.x, delta.y) > DRAG_SLOP) moved.current = true
    if (!moved.current) return
    setPan(clampPan({ x: start.pan.x + delta.x, y: start.pan.y + delta.y }, zoom))
  }

  const endPointer = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinchStart.current = null
    if (pointers.current.size === 0) gestureStart.current = null
  }

  // Trackpad and mouse: plain wheel pans, pinch (which arrives as ctrl+wheel)
  // zooms. Bound natively so the listener can be non-passive.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        applyZoom(zoom * (1 - event.deltaY * 0.01))
      } else {
        setPan((current) => clampPan({ x: current.x - event.deltaX, y: current.y - event.deltaY }, zoom))
      }
    }

    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [applyZoom, clampPan, zoom])

  // MARK: - Atmosphere

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || worldW === 0 || worldH === 0) return
    const context = canvas.getContext("2d")
    if (!context) return

    // Re-rasterise as the user zooms in, otherwise CSS scaling softens several
    // hundred hairlines into grey.
    const resolution = (window.devicePixelRatio || 1) * Math.min(2, Math.max(1, zoom))
    canvas.width = Math.round(worldW * resolution)
    canvas.height = Math.round(worldH * resolution)
    canvas.style.width = `${worldW}px`
    canvas.style.height = `${worldH}px`
    context.setTransform(resolution, 0, 0, resolution, 0, 0)
    context.clearRect(0, 0, worldW, worldH)

    drawAtmosphere(context, world, { worldW, worldH, unit })
  }, [world, worldW, worldH, unit, zoom])

  // MARK: - Render

  const anchors = world.scenarioAnchors

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={resetView}
      className="font-grotesque relative h-full w-full cursor-grab touch-none select-none overflow-hidden bg-white [animation:bramble-fade_700ms_ease-out] active:cursor-grabbing"
    >
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: worldW,
          height: worldH,
          transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        <canvas ref={canvasRef} className="absolute left-0 top-0" />

        {/* Centre — the player */}
        <div
          className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
          style={{ left: world.center.x * worldW, top: world.center.y * worldH }}
        >
          <PortraitCircle
            src={MAIN_CHARACTER.portrait}
            fallback={MAIN_CHARACTER.name}
            ringWidth={`${unit * 0.132 * 0.045}px`}
            sizes="200px"
            className="shadow-[0_3px_10px_rgba(0,0,0,0.10)]"
            style={{ width: unit * 0.132 }}
          />
          <PillLabel
            text={MAIN_CHARACTER.name}
            fontSize={unit * 0.042}
            paddingX={unit * 0.03}
            paddingY={unit * 0.014}
            marginTop={unit * 0.018}
          />
        </div>

        {/* The five playable nodes */}
        {SCENARIOS.map((scenario, index) => {
          const anchor = anchors[index % anchors.length]
          const isHovered = hovered === scenario.id
          const diameter = unit * 0.082
          return (
            <button
              type="button"
              key={scenario.id}
              onMouseEnter={() => setHovered(scenario.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => {
                if (!moved.current) onSelect(scenario)
              }}
              aria-label={`Play ${scenario.title} with ${scenario.personaName}`}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 cursor-pointer flex-col items-center transition-transform duration-150"
              style={{
                left: anchor.x * worldW,
                top: anchor.y * worldH,
                transform: `translate(-50%, -50%) scale(${isHovered ? 1.07 : 1})`,
              }}
            >
              <PortraitCircle
                src={scenario.portrait}
                fallback={scenario.personaName}
                ringWidth={`${diameter * 0.06}px`}
                ringColor={isHovered ? ACCENT_COLOR[scenario.accent] : "#ffffff"}
                sizes="140px"
                className="transition-shadow duration-150"
                style={{
                  width: diameter,
                  boxShadow: isHovered
                    ? `0 3px 14px rgba(0,0,0,0.20)`
                    : `0 3px 7px rgba(0,0,0,0.09)`,
                }}
              />
              <PillLabel
                text={scenario.personaName}
                fontSize={unit * 0.026}
                paddingX={unit * 0.019}
                paddingY={unit * 0.009}
                marginTop={unit * 0.013}
              />
              <span
                className="whitespace-nowrap leading-none text-black/45"
                style={{ fontSize: unit * 0.0165, marginTop: unit * 0.013 }}
              >
                {scenario.nodeCaption}
              </span>
            </button>
          )
        })}
      </div>

      {/* Chrome */}
      <div
        className="pointer-events-none absolute inset-0 flex items-start justify-between"
        style={{ padding: size.w * 0.022 }}
      >
        <Image
          src="/bramble-logo.png"
          alt="bramble"
          width={144}
          height={144}
          style={{ width: Math.max(34, size.w * 0.038), height: "auto" }}
        />
        <div
          className="flex flex-col items-end rounded-full bg-white/90"
          style={{
            padding: `${size.w * 0.008}px ${size.w * 0.014}px`,
            gap: 2,
          }}
        >
          <span className="font-bold text-black" style={{ fontSize: Math.max(11, size.w * 0.0112) }}>
            {SCENARIOS.length} stories found
          </span>
          <span className="text-black/50" style={{ fontSize: Math.max(9, size.w * 0.0092) }}>
            drag to explore · double-click to recentre
          </span>
        </div>
      </div>
    </div>
  )
}

// MARK: - Pill

/** The white capsule used for the centre and each playable node. */
function PillLabel({
  text,
  fontSize,
  paddingX,
  paddingY,
  marginTop,
}: {
  text: string
  fontSize: number
  paddingX: number
  paddingY: number
  marginTop: number
}) {
  return (
    <span
      className="whitespace-nowrap rounded-full bg-white leading-none text-black shadow-[0_2px_7px_rgba(0,0,0,0.13)]"
      style={{ fontSize, padding: `${paddingY}px ${paddingX}px`, marginTop }}
    >
      {text}
    </span>
  )
}

// MARK: - Canvas

/**
 * Every non-interactive node, drawn in one pass.
 *
 * `unit` is the *viewport's* short edge, not the world's — node and type sizes
 * should stay constant as the world grows, otherwise a bigger world just means
 * bigger dots instead of more of them.
 */
function drawAtmosphere(
  context: CanvasRenderingContext2D,
  world: LifeGraphWorld,
  { worldW, worldH, unit }: { worldW: number; worldH: number; unit: number },
) {
  const center = { x: world.center.x * worldW, y: world.center.y * worldH }
  const font = (size: number) => `${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`

  // Hairline starburst first, so everything else sits on top. Opacity stays low
  // because a few hundred lines all converge on the centre — raise it much and
  // the core turns grey.
  context.beginPath()
  for (const node of world.nodes) {
    if (!node.tethered) continue
    context.moveTo(center.x, center.y)
    context.lineTo(node.x * worldW, node.y * worldH)
  }
  context.strokeStyle = "rgba(0, 0, 0, 0.085)"
  context.lineWidth = unit * 0.0021
  context.stroke()

  context.textAlign = "center"
  context.textBaseline = "middle"

  for (const node of world.nodes) {
    const x = node.x * worldW
    const y = node.y * worldH
    const radius = node.radius * unit

    context.globalAlpha = 0.92
    context.fillStyle = DOT_COLOR[node.color]
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
    context.globalAlpha = 1

    if (!node.label) continue
    drawLabel(context, node, { x, y, radius, unit, font })
  }
}

function drawLabel(
  context: CanvasRenderingContext2D,
  node: AtmosphereNode,
  {
    x,
    y,
    radius,
    unit,
    font,
  }: { x: number; y: number; radius: number; unit: number; font: (size: number) => string },
) {
  const label = node.label as string
  const fontSize = node.labelScale * unit
  const labelY = y + radius + fontSize * 0.85

  context.font = font(fontSize)

  if (node.isPill) {
    const width = context.measureText(label).width + fontSize * 1.3
    const height = fontSize * 1.9
    context.beginPath()
    context.roundRect(x - width / 2, labelY - height / 2, width, height, height / 2)
    context.fillStyle = "#ffffff"
    context.fill()
    context.strokeStyle = "rgba(0, 0, 0, 0.06)"
    context.lineWidth = 1
    context.stroke()
  }

  context.fillStyle = node.isPill ? "rgba(0, 0, 0, 0.88)" : "rgba(0, 0, 0, 0.72)"
  context.fillText(label, x, labelY)
}
