'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/app/lab/actions';

type Props = {
  /** A server action, passed down as a reference from a server component. */
  action: () => Promise<ActionResult>;
  label: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary';
  className?: string;
};

/**
 * A button that runs a server action and says what happened.
 *
 * Wrapped in `startTransition` rather than a form, because these take a session
 * id rather than form fields and there is nothing to submit. The pending state
 * is not decoration: a turn takes several seconds to generate, and without it
 * the page looks broken and gets clicked again.
 *
 * Next dispatches actions one at a time per client, so a second click while one
 * is in flight would queue rather than run — `disabled` makes that visible
 * instead of mysterious.
 */
export function ActionButton({
  action,
  label,
  pendingLabel,
  variant = 'secondary',
  className,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(null);
            setResult(await action());
          })
        }
        className={cn(
          'rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-50',
          variant === 'primary'
            ? 'bg-foreground text-background hover:opacity-90'
            : 'border-border bg-background hover:bg-muted',
          className
        )}
      >
        {pending ? (pendingLabel ?? 'Working…') : label}
      </button>

      {result && (
        <span
          className={cn(
            'text-xs',
            result.ok ? 'text-muted-foreground' : 'text-destructive font-medium'
          )}
        >
          {result.message}
        </span>
      )}
    </span>
  );
}
