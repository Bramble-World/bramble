import type { Metadata } from 'next';
import { BrambleDemo } from '@/components/demo/bramble-demo';

export const metadata: Metadata = {
  title: 'Bramble — prototype',
  description:
    'A walkthrough of Bramble: import your relationships, explore your life graph, and play a scenario.',
  // Unlisted. Nothing on the site links here, so the only way in is the URL —
  // keep it out of the index too, or a single shared link makes it public.
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return <BrambleDemo />;
}
