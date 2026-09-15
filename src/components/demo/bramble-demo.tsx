'use client';

import { useState } from 'react';
import { SCENARIOS, type Scenario } from '@/lib/demo/scenarios';
import { OnboardingView } from './onboarding-view';
import { RelationshipsView } from './relationships-view';
import { ScenarioGraph } from './scenario-graph';
import { StoryView } from './story-view';

// The prototype's four screens, in order. This is the whole app on the demo
// path: intro → import relationships → life graph → play a scenario → back to
// the graph. No network, no key, no persistence.

type Step =
  | { kind: 'intro' }
  | { kind: 'relationships' }
  | { kind: 'graph' }
  | { kind: 'story'; scenarioId: string };

export function BrambleDemo() {
  const [step, setStep] = useState<Step>({ kind: 'intro' });
  /** The people the stories revolve around. The scenario builder will key off
   *  these once it's real; for now the scenarios are hardcoded and the names
   *  only salt the graph's label pool. */
  const [castNames, setCastNames] = useState<string[]>([]);

  const scenario: Scenario | undefined =
    step.kind === 'story' ? SCENARIOS.find((entry) => entry.id === step.scenarioId) : undefined;

  return (
    <main className="h-svh w-full overflow-hidden bg-white text-black">
      <div key={step.kind} className="h-full w-full [animation:bramble-fade_350ms_ease-out]">
        {step.kind === 'intro' && (
          <OnboardingView onFinish={() => setStep({ kind: 'relationships' })} />
        )}

        {step.kind === 'relationships' && (
          <RelationshipsView
            onContinue={(names) => {
              setCastNames(names);
              setStep({ kind: 'graph' });
            }}
          />
        )}

        {step.kind === 'graph' && (
          <ScenarioGraph
            castNames={castNames}
            onSelect={(picked) => setStep({ kind: 'story', scenarioId: picked.id })}
          />
        )}

        {step.kind === 'story' && scenario && (
          <StoryView scenario={scenario} onBack={() => setStep({ kind: 'graph' })} />
        )}
      </div>
    </main>
  );
}
