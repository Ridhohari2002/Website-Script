export default function PublicLoading() {
  return (
    <div className="shell py-16" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading page</span>
      <div className="h-3 w-24 animate-pulse rounded-xs bg-bg-elevated" />
      <div className="mt-5 h-9 w-full max-w-[420px] animate-pulse rounded-sm bg-bg-elevated" />
      <div className="mt-4 h-4 w-full max-w-[560px] animate-pulse rounded-xs bg-bg-surface" />
      <div className="mt-2 h-4 w-full max-w-[480px] animate-pulse rounded-xs bg-bg-surface" />
    </div>
  );
}
