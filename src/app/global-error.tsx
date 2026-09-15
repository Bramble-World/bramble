'use client'; // Error boundaries must be Client Components

// Replaces the root layout when the root layout itself throws, so it has to
// bring its own <html>/<body>.
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#FFFFFB] p-8 text-center">
        <h2 className="text-xl">Something went wrong.</h2>
        {error.digest ? <p className="text-sm opacity-60">Reference: {error.digest}</p> : null}
        <button className="rounded-full border px-4 py-2 text-sm" onClick={() => unstable_retry()}>
          Try again
        </button>
      </body>
    </html>
  );
}
