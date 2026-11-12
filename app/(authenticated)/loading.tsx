export default function AuthenticatedLoading() {
  return (
    <div className="shell py-16" aria-busy="true" aria-live="polite">
      <span className="sr-only">Checking your account</span>
      <div className="h-3 w-24 animate-pulse rounded-xs bg-bg-elevated" />
      <div className="mt-5 h-9 w-full max-w-[420px] animate-pulse rounded-sm bg-bg-elevated" />
      <div className="mt-4 h-4 w-full max-w-[560px] animate-pulse rounded-xs bg-bg-surface" />
      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-md border border-border-default bg-bg-surface" />
        <div className="h-56 animate-pulse rounded-md border border-border-default bg-bg-surface" />
      </div>
    </div>
  );
}
