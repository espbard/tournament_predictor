export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center p-8 ${className ?? ''}`}>
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
    </div>
  );
}
