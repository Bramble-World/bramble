import type { Metadata } from "next"
import { BrambleDemo } from "@/components/demo/bramble-demo"

export const metadata: Metadata = {
  title: "Bramble — prototype",
  description: "A walkthrough of Bramble: import your relationships, explore your life graph, and play a scenario.",
}

export default function DemoPage() {
  return <BrambleDemo />
}
